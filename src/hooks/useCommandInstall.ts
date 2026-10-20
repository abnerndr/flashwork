import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'

import {
  type InstallMethod,
  installerPtyCommand,
  installOutputIsFatal,
  installShellLine,
} from '../lib/agentInstall'
import { isWindows, osFamily } from '../lib/platform'
import { installTargetOs } from '../lib/wsl'
import { useProjectsStore } from '../stores/projectsStore'
import {
  agentCliVersion,
  findCliLauncher,
  killPty,
  listenPtyData,
  listenPtyExit,
  refreshCliPath,
  spawnPty,
  wslPrepareFolder,
  writePty,
} from '../lib/tauri'

export type AgentInstallStatus = 'idle' | 'running' | 'success' | 'failed'

/**
 * Set only when a run finished with the installer reporting success and the resolver still
 * finding a binary, but the version at that binary never moved — the installer likely updated a
 * different install of the same CLI than the one PATH resolves to. Holds that binary's path so
 * the caller can name it.
 */
export type AgentInstallShadowConflict = { path: string }

const MAX_LOG_CHARS = 12_000
const PROMPT_SETTLE_MS = 2_000
const WSL_PROMPT_SETTLE_MS = 8_000

function shellLooksReady(log: string): boolean {
  const plain = log.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\r/g, '')
  return /(?:\$|#|%|>)\s*$/.test(plain)
}

async function waitForInstallerPrompt(readLog: () => string, timeoutMs: number): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (Date.now() - started >= 400 && shellLooksReady(readLog())) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}
// Ctrl+U kills the line in bash/readline. PowerShell inserts it as `^U` and
// glues it to the first token, so an assignment is parsed as a command name.
const CLEAR_LINE = '\x15'

/**
 * Spawn an interactive pwsh (Windows) or bash (Unix) PTY. `command_builder_for_terminal`
 * wraps a named command in default_shell() -Command / -lc, which is not a prompt — except
 * for known shell names, which it now launches as the PTY process itself. The install
 * pipeline is written into that shell, not passed as spawnPty.command. If pwsh/bash is
 * missing, fall back to the app default shell (powershell.exe / $SHELL).
 */
async function spawnInstallerPty(
  ptyId: string,
  os: ReturnType<typeof osFamily>,
  cwd?: string,
): Promise<{ id: string }> {
  const env = os === 'windows' ? { FLASHWORK_PTY_NO_PROFILE: '1' } : undefined
  try {
    return await spawnPty({
      cols: 100,
      rows: 24,
      id: ptyId,
      command: installerPtyCommand(os),
      cwd,
      env,
    })
  } catch {
    return spawnPty({ cols: 100, rows: 24, id: ptyId, cwd, env })
  }
}

function trimLog(value: string): string {
  return value.length > MAX_LOG_CHARS ? value.slice(value.length - MAX_LOG_CHARS) : value
}

/*
 * Package managers serialize badly: two `npm -g` runs fight over the same global directory, and
 * WinGet refuses to run twice at once. Only one command install is allowed at a time, app-wide.
 */
let busyAgent: string | null = null
const busyListeners = new Set<() => void>()

function setBusyAgent(agent: string | null): void {
  busyAgent = agent
  for (const listener of busyListeners) listener()
}

/** The lock key whose install/uninstall is running right now, or null when nothing is. */
export function useAgentOperationBusy(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      busyListeners.add(onChange)
      return () => busyListeners.delete(onChange)
    },
    () => busyAgent,
  )
}

/**
 * `lockKey` identifies the run that holds the app-wide lock. Agent installs pass the agent id
 * (or `node-toolchain` when the same screen also installs Node). Only one install runs at a
 * time so two `npm -g` operations cannot overlap.
 */
export function useCommandInstall(lockKey: string, defaultVerifyCommand: string) {
  const [status, setStatus] = useState<AgentInstallStatus>('idle')
  const [log, setLog] = useState('')
  const [shadowConflict, setShadowConflict] = useState<AgentInstallShadowConflict | null>(null)
  const ptyIdRef = useRef<string | null>(null)
  const cleanupRef = useRef<Array<() => void>>([])
  const disposedRef = useRef(false)
  const logRef = useRef('')
  const settledRef = useRef(false)

  const teardown = useCallback(() => {
    cleanupRef.current.forEach((stop) => stop())
    cleanupRef.current = []
    const ptyId = ptyIdRef.current
    ptyIdRef.current = null
    if (ptyId) void killPty(ptyId).catch(() => undefined)
    // Never leave the app-wide lock held by a run that is gone.
    if (busyAgent === lockKey) setBusyAgent(null)
  }, [lockKey])

  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      teardown()
    }
  }, [teardown])

  const install = useCallback(
    async (method: InstallMethod) => {
      if (status === 'running' || busyAgent !== null) return
      teardown()
      logRef.current = ''
      settledRef.current = false
      setLog('')
      setShadowConflict(null)
      setStatus('running')
      setBusyAgent(lockKey)

      const command = method.verifyCommand ?? defaultVerifyCommand
      // Only meaningful for an update of something already on PATH — a fresh install has
      // nothing to compare against, and verifyAbsent (uninstall) checks absence, not a version.
      const beforeVersion = command && !method.verifyAbsent ? await agentCliVersion(command) : null

      const ptyId = `agent-install:${lockKey}:${Date.now()}`
      const preferences = useProjectsStore.getState().preferences
      const os = installTargetOs(osFamily(), preferences)
      try {
        const installerCwd =
          os === 'linux' && isWindows()
            ? await wslPrepareFolder(preferences.wslDefaultDistro, '~')
            : undefined
        const spawned = await spawnInstallerPty(ptyId, os, installerCwd)
        if (disposedRef.current) {
          void killPty(spawned.id).catch(() => undefined)
          return
        }
        ptyIdRef.current = spawned.id

        cleanupRef.current.push(
          await listenPtyData(spawned.id, (chunk) => {
            const next = trimLog(logRef.current + chunk)
            logRef.current = next
            setLog(next)
            if (!installOutputIsFatal(next) || settledRef.current) return
            settledRef.current = true
            setStatus('failed')
            teardown()
          }),
        )
        cleanupRef.current.push(
          await listenPtyExit(spawned.id, (payload) => {
            ptyIdRef.current = null
            if (busyAgent === lockKey) setBusyAgent(null)
            if (settledRef.current) return
            settledRef.current = true
            // `installShellLine` ends the shell with a bare `exit`, which carries the
            // installer command's own exit status. A non-zero code means the installer
            // itself reported failure (network error, permission denied, ...) — trust it
            // instead of falling through to the resolver, which would still find the
            // previous binary on PATH and misreport the run as a success.
            if (payload.code !== 0) {
              setStatus('failed')
              return
            }
            if (!command) {
              setStatus('failed')
              return
            }
            // A zero exit code still doesn't confirm the binary landed somewhere we
            // can launch it from. Drop the stale launcher cache and re-resolve
            // with the user's login PATH before verifying.
            void refreshCliPath(command)
              .catch(() => null)
              .then(() => findCliLauncher(command))
              .then(async (found) => {
                if (disposedRef.current) return
                const worked = method.verifyAbsent ? !found : Boolean(found)
                if (!worked) {
                  setStatus('failed')
                  return
                }
                // The resolver found a binary and the installer exited clean, but if that
                // binary's version is exactly what it was before, the installer likely
                // reached a different install of this CLI than the one PATH resolves to —
                // a shadowing install earlier on PATH that the update never touched.
                if (beforeVersion && found) {
                  const afterVersion = await agentCliVersion(command)
                  if (disposedRef.current) return
                  if (afterVersion && afterVersion === beforeVersion) {
                    setShadowConflict({ path: found })
                    setStatus('failed')
                    return
                  }
                }
                setStatus('success')
              })
              .catch(() => {
                if (!disposedRef.current) setStatus('failed')
              })
          }),
        )

        await waitForInstallerPrompt(
          () => logRef.current,
          os === 'windows' ? PROMPT_SETTLE_MS : WSL_PROMPT_SETTLE_MS,
        )
        if (disposedRef.current || settledRef.current) return
        const lead = os === 'windows' ? '' : CLEAR_LINE
        await writePty(spawned.id, `${lead}${installShellLine(method.command, os)}`)
      } catch (error) {
        setLog((current) => trimLog(`${current}\n${String(error)}`))
        setStatus('failed')
        teardown()
      }
    },
    [defaultVerifyCommand, lockKey, status, teardown],
  )

  const reset = useCallback(() => {
    teardown()
    logRef.current = ''
    settledRef.current = false
    setLog('')
    setShadowConflict(null)
    setStatus('idle')
  }, [teardown])

  return { status, log, shadowConflict, install, reset }
}
