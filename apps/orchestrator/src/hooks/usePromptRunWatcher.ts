import { useEffect, useRef } from 'react'

import { getCachedClaudeUsage } from '../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../lib/codexUsageCache'
import { useT, type MessageKey } from '../lib/i18n'
import { autoHandoffDedupeKey, claimAutoHandoff, isHandoffAborted } from '../lib/promptRun/autoHandoffGate'
import { detectHandoffTrigger, handoffTarget } from '../lib/promptRun/detectHandoffTrigger'
import { executeAutoHandoff } from '../lib/promptRun/executeHandoff'
import { probeInstalledAgents } from '../lib/promptRun/probeInstalled'
import { appendPromptRunJournal, listenPtyData } from '../lib/tauri'
import {
  AGENT_TYPE_LABELS,
  UNRESTRICTED_FLAG,
  type PromptRun,
  type PromptRunStepReason,
} from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { usePromptRunStore } from '../stores/promptRunStore'
import { useUiStore } from '../stores/uiStore'

const USAGE_POLL_MS = 60_000
const HANDOFF_TIMEOUT_MS = 30_000

const REASON_KEYS: Record<Extract<PromptRunStepReason, 'quota' | 'error' | 'user'>, MessageKey> = {
  quota: 'promptRun.reason.quota',
  error: 'promptRun.reason.error',
  user: 'promptRun.reason.user',
}

type ActivePane = {
  tab: { ptyId: string | null; sessionId?: string }
}

function resolveActivePane(run: PromptRun): ActivePane | null {
  const project = useProjectsStore.getState().projects.find((entry) => entry.id === run.projectId)
  const terminal = project?.terminals.find((entry) => entry.id === run.activeTerminalId)
  if (!terminal) return null
  const tab = terminal.tabs.find((entry) => entry.id === terminal.activeTabId) ?? terminal.tabs[0]
  if (!tab) return null
  return { tab }
}

function runningRuns(): PromptRun[] {
  return Object.values(usePromptRunStore.getState().byProjectId).filter(
    (run) => run.status === 'running',
  )
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(label)), ms)
    promise.then(
      (value) => {
        window.clearTimeout(timer)
        resolve(value)
      },
      (cause) => {
        window.clearTimeout(timer)
        reject(cause)
      },
    )
  })
}

export function usePromptRunWatcher() {
  const t = useT()
  const seenRef = useRef(new Set<string>())
  const inflightRef = useRef(new Set<string>())
  const usageRef = useRef<{
    claudeFiveHourUtilization: number | null
    codexRateLimited: boolean
  }>({ claudeFiveHourUtilization: null, codexRateLimited: false })

  const fireHandoff = async (run: PromptRun, kind: 'quota' | 'error' | 'user') => {
    const dedupeKey = autoHandoffDedupeKey(run.id, run.activeAgent, kind)
    if (!claimAutoHandoff(seenRef.current, inflightRef.current, run.id, dedupeKey)) return

    let completed = false
    const abortIfStopped = () =>
      isHandoffAborted(usePromptRunStore.getState().byProjectId[run.projectId], run.id)
    try {
      const enabled = useProjectsStore.getState().preferences.enabledAgents
      const candidates = (['claude', 'codex'] as const).filter((agent) => enabled[agent])
      const installed = await probeInstalledAgents([...candidates])
      const target = handoffTarget(run.activeAgent, installed)
      if (!target) {
        const peer = run.activeAgent === 'claude' ? 'codex' : 'claude'
        useUiStore.getState().pushToast({
          title: t('promptRun.handoffBlockedTitle'),
          body: t('promptRun.handoffBlockedBody', {
            detail: `${AGENT_TYPE_LABELS[peer]} is not available`,
          }),
          agent: run.activeAgent,
        })
        return
      }

      if (abortIfStopped()) return
      usePromptRunStore.getState().setStatus(run.projectId, 'handing-off')
      const pane = resolveActivePane(run)
      const flag = run.unrestricted ? UNRESTRICTED_FLAG[target] : null
      const result = await withTimeout(
        executeAutoHandoff({
          source: run.activeAgent === 'codex' ? 'codex' : 'claude',
          target,
          sourceSessionId: pane?.tab.sessionId,
          cwd: run.cwd,
          extraArgs: flag ? [flag] : [],
          paneName: t('handoff.paneName', { agent: AGENT_TYPE_LABELS[target] }),
          runId: run.id,
          journalPath: run.journalPath,
          prompt: run.prompt,
        }),
        HANDOFF_TIMEOUT_MS,
        'auto-handoff timed out',
      )
      if (abortIfStopped()) return
      const created = useProjectsStore.getState().createTerminal(run.projectId, result.terminalArgs)
      if (abortIfStopped()) return
      const now = Date.now()
      const latest = usePromptRunStore.getState().byProjectId[run.projectId]
      const steps = (latest ?? run).steps.map((step, index, list) =>
        index === list.length - 1 ? { ...step, endedAt: now } : step,
      )
      steps.push({
        agent: target,
        reason: kind,
        startedAt: now,
        terminalId: created.id,
        handoffId: result.artifact?.handoffId,
        contextPath: result.artifact?.contextPath,
      })
      usePromptRunStore.getState().patchRun(run.projectId, {
        status: 'running',
        activeAgent: target,
        activeTerminalId: created.id,
        steps,
      })
      completed = true
      try {
        await appendPromptRunJournal(
          run.id,
          `Handoff to ${AGENT_TYPE_LABELS[target]}`,
          [
            `reason: ${kind}`,
            result.artifact?.contextPath
              ? `capsule: ${result.artifact.contextPath}`
              : 'capsule: fallback journal',
          ].join('\n'),
        )
      } catch (cause) {
        console.warn('[prompt-run] handoff journal append failed:', cause)
      }
      useUiStore.getState().pushToast({
        title: t('promptRun.handoffToastTitle', { agent: AGENT_TYPE_LABELS[target] }),
        body: `${t('promptRun.handoffToastBody', { reason: t(REASON_KEYS[kind]) })} ${t('promptRun.reviewCapsule')}`,
        agent: target,
      })
    } catch (cause) {
      console.warn('[prompt-run] auto-handoff failed:', cause)
      useUiStore.getState().pushToast({
        title: t('promptRun.handoffBlockedTitle'),
        body: t('promptRun.handoffBlockedBody', { detail: String(cause) }),
        agent: run.activeAgent,
      })
    } finally {
      inflightRef.current.delete(run.id)
      if (!completed) {
        const current = usePromptRunStore.getState().byProjectId[run.projectId]
        if (current?.id === run.id && current.status === 'handing-off') {
          usePromptRunStore.getState().setStatus(run.projectId, 'running')
        }
      }
    }
  }

  const considerTrigger = (run: PromptRun, ptyChunk: string) => {
    if (run.status !== 'running') return
    const trigger = detectHandoffTrigger({
      activeAgent: run.activeAgent,
      claudeFiveHourUtilization: usageRef.current.claudeFiveHourUtilization,
      codexRateLimited: usageRef.current.codexRateLimited,
      ptyChunk,
    })
    if (!trigger) return
    void fireHandoff(run, trigger.kind)
  }

  useEffect(() => {
    let cancelled = false
    const pollUsage = async () => {
      const [claude, codex] = await Promise.all([
        getCachedClaudeUsage().catch(() => null),
        getCachedCodexUsage().catch(() => null),
      ])
      if (cancelled) return
      usageRef.current = {
        claudeFiveHourUtilization: claude?.five_hour.utilization ?? null,
        codexRateLimited: Boolean(codex?.rate_limited),
      }
      for (const run of runningRuns()) {
        considerTrigger(run, '')
      }
    }
    void pollUsage()
    const interval = window.setInterval(() => void pollUsage(), USAGE_POLL_MS)
    return () => {
      cancelled = true
      window.clearInterval(interval)
    }
  }, [t])

  const runBindings = usePromptRunStore((state) =>
    Object.values(state.byProjectId)
      .filter((run) => run.status === 'running')
      .map((run) => `${run.id}:${run.activeTerminalId}`)
      .sort()
      .join('|'),
  )
  const ptyBindings = useProjectsStore((state) =>
    Object.values(usePromptRunStore.getState().byProjectId)
      .filter((run) => run.status === 'running')
      .map((run) => {
        const project = state.projects.find((entry) => entry.id === run.projectId)
        const terminal = project?.terminals.find((entry) => entry.id === run.activeTerminalId)
        const tab =
          terminal?.tabs.find((entry) => entry.id === terminal.activeTabId) ?? terminal?.tabs[0]
        return `${run.id}:${tab?.ptyId ?? ''}`
      })
      .sort()
      .join('|'),
  )

  useEffect(() => {
    const unlistens: Array<() => void> = []
    let cancelled = false
    for (const run of runningRuns()) {
      const pane = resolveActivePane(run)
      const ptyId = pane?.tab.ptyId
      if (!ptyId) continue
      const subscribedTerminalId = run.activeTerminalId
      void listenPtyData(ptyId, (chunk) => {
        const current = usePromptRunStore.getState().byProjectId[run.projectId]
        if (!current || current.id !== run.id) return
        if (current.activeTerminalId !== subscribedTerminalId) return
        considerTrigger(current, chunk)
      }).then((unlisten) => {
        if (cancelled) {
          unlisten()
          return
        }
        unlistens.push(unlisten)
      })
    }
    return () => {
      cancelled = true
      for (const unlisten of unlistens) unlisten()
    }
  }, [runBindings, ptyBindings, t])
}
