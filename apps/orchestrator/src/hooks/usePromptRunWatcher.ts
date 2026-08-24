import { useEffect, useRef } from 'react'

import { getCachedClaudeUsage } from '../lib/claudeUsageCache'
import { getCachedCodexUsage } from '../lib/codexUsageCache'
import { useT, type MessageKey } from '../lib/i18n'
import { autoHandoffDedupeKey, claimAutoHandoff, isHandoffAborted } from '../lib/promptRun/autoHandoffGate'
import { detectHandoffTrigger, handoffTarget, isAgentAuthError, isAgentLoginBlock } from '../lib/promptRun/detectHandoffTrigger'
import { executeAutoHandoff } from '../lib/promptRun/executeHandoff'
import { excludeFailedAgents, markAgentAuthFailed } from '../lib/promptRun/failedAgents'
import { decideLaneFailure } from '../lib/promptRun/laneFailure'
import { probeInstalledAgents } from '../lib/promptRun/probeInstalled'
import { appendPromptRunJournal, ingestRunContext, listenPtyData } from '../lib/tauri'
import { shouldIngestContext } from '../lib/promptRun/ingestContext'
import { AGENT_TYPE_LABELS, ALL_AGENT_TYPES, UNRESTRICTED_FLAG, type AgentType, type PromptRun, type PromptRunStepReason } from '../lib/types'
import { boardLaneContext, failBoardLane, retargetBoardRun } from '../lib/taskBoard/submitBoardTask'
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

function resolvePane(projectId: string, terminalId: string | undefined): ActivePane | null {
  if (!terminalId) return null
  const project = useProjectsStore.getState().projects.find((entry) => entry.id === projectId)
  const terminal = project?.terminals.find((entry) => entry.id === terminalId)
  if (!terminal) return null
  const tab = terminal.tabs.find((entry) => entry.id === terminal.activeTabId) ?? terminal.tabs[0]
  if (!tab) return null
  return { tab }
}

function resolveActivePane(run: PromptRun): ActivePane | null {
  return resolvePane(run.projectId, run.activeTerminalId)
}

function runStepTerminals(run: PromptRun): Array<{ terminalId: string; agent: AgentType }> {
  const steps = run.steps
    .filter((step) => step.terminalId)
    .map((step) => ({ terminalId: step.terminalId as string, agent: step.agent }))
  if (run.activeTerminalId && !steps.some((step) => step.terminalId === run.activeTerminalId)) {
    steps.push({ terminalId: run.activeTerminalId, agent: run.activeAgent })
  }
  return steps
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
  const ingestTimersRef = useRef(new Map<string, number>())
  const usageRef = useRef<{
    claudeFiveHourUtilization: number | null
    codexRateLimited: boolean
  }>({ claudeFiveHourUtilization: null, codexRateLimited: false })

  const endLaneStep = (run: PromptRun, sourceTerminalId: string) => {
    const now = Date.now()
    const latest = usePromptRunStore.getState().byProjectId[run.projectId]
    const steps = (latest ?? run).steps.map((step) =>
      step.terminalId === sourceTerminalId && !step.endedAt ? { ...step, endedAt: now } : step,
    )
    const live = steps.find((step) => step.terminalId && !step.endedAt)
    usePromptRunStore.getState().patchRun(run.projectId, {
      status: 'running',
      steps,
      ...(live
        ? { activeAgent: live.agent, activeTerminalId: live.terminalId as string }
        : {}),
    })
  }

  const fireHandoff = async (
    run: PromptRun,
    kind: 'quota' | 'error' | 'user',
    sourceAgent: AgentType,
    sourceTerminalId: string,
    options: { prompt: string; pauseRun: boolean; errorNote?: string },
  ) => {
    const inflightKey = options.pauseRun ? run.id : `${run.id}:${sourceTerminalId}`
    const dedupeKey = autoHandoffDedupeKey(run.id, sourceAgent, kind)
    if (!claimAutoHandoff(seenRef.current, inflightRef.current, inflightKey, dedupeKey)) return

    let completed = false
    const abortIfStopped = () =>
      isHandoffAborted(usePromptRunStore.getState().byProjectId[run.projectId], run.id)
    try {
      const enabled = useProjectsStore.getState().preferences.enabledAgents
      const candidates = ALL_AGENT_TYPES.filter((agent) => agent !== 'shell' && enabled[agent])
      const installed = excludeFailedAgents(await probeInstalledAgents(candidates))
      const occupied = run.steps
        .map((step) => step.agent)
        .filter((agent) => agent !== sourceAgent)
      const target = handoffTarget(sourceAgent, installed, occupied)
      if (!target) {
        failBoardLane(sourceTerminalId)
        endLaneStep(run, sourceTerminalId)
        useUiStore.getState().pushToast({
          title: t('promptRun.handoffBlockedTitle'),
          body: t('promptRun.handoffBlockedBody', { detail: t('promptRun.handoffNoPeer') }),
          agent: sourceAgent,
        })
        return
      }

      if (abortIfStopped()) return
      if (options.pauseRun) usePromptRunStore.getState().setStatus(run.projectId, 'handing-off')
      const pane = resolvePane(run.projectId, sourceTerminalId) ?? resolveActivePane(run)
      const flag = run.unrestricted ? UNRESTRICTED_FLAG[target] : null
      const result = await withTimeout(
        executeAutoHandoff({
          source: sourceAgent,
          target,
          sourceSessionId: pane?.tab.sessionId,
          cwd: run.cwd,
          extraArgs: flag ? [flag] : [],
          paneName: t('handoff.paneName', { agent: AGENT_TYPE_LABELS[target] }),
          runId: run.id,
          journalPath: run.journalPath,
          prompt: options.prompt,
          errorNote: options.errorNote,
        }),
        HANDOFF_TIMEOUT_MS,
        'auto-handoff timed out',
      )
      if (abortIfStopped()) return
      const created = useProjectsStore.getState().createTerminal(run.projectId, result.terminalArgs)
      if (abortIfStopped()) return
      const now = Date.now()
      const latest = usePromptRunStore.getState().byProjectId[run.projectId]
      const steps = (latest ?? run).steps.map((step) =>
        step.terminalId === sourceTerminalId && !step.endedAt ? { ...step, endedAt: now } : step,
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
        activeAgent: options.pauseRun ? target : (latest ?? run).activeAgent,
        activeTerminalId: options.pauseRun ? created.id : (latest ?? run).activeTerminalId,
        steps,
      })
      retargetBoardRun(run.id, sourceTerminalId, { agent: target, terminalId: created.id })
      completed = true
      try {
        await appendPromptRunJournal(
          run.id,
          `Handoff to ${AGENT_TYPE_LABELS[target]}`,
          [
            `reason: ${kind}`,
            `from: ${AGENT_TYPE_LABELS[sourceAgent]}`,
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
        agent: sourceAgent,
      })
    } finally {
      inflightRef.current.delete(inflightKey)
      if (!completed && options.pauseRun) {
        const current = usePromptRunStore.getState().byProjectId[run.projectId]
        if (current?.id === run.id && current.status === 'handing-off') {
          usePromptRunStore.getState().setStatus(run.projectId, 'running')
        }
      }
    }
  }

  const considerTrigger = (
    run: PromptRun,
    ptyChunk: string,
    sourceAgent: AgentType = run.activeAgent,
    sourceTerminalId: string = run.activeTerminalId,
  ) => {
    if (run.status !== 'running') return
    const trigger = detectHandoffTrigger({
      activeAgent: sourceAgent,
      claudeFiveHourUtilization: usageRef.current.claudeFiveHourUtilization,
      codexRateLimited: usageRef.current.codexRateLimited,
      ptyChunk,
    })
    if (!trigger) return
    const loginBlocked = isAgentLoginBlock(ptyChunk) || isAgentAuthError(ptyChunk)
    if (loginBlocked) markAgentAuthFailed(sourceAgent)
    const liveSteps = run.steps.filter((step) => step.terminalId && !step.endedAt)
    const lane = boardLaneContext(run.id, sourceTerminalId)
    const action = decideLaneFailure({
      liveStepCount: Math.max(liveSteps.length, 1),
      failedKind: lane.failedKind,
      siblingKinds: lane.siblingKinds,
      trigger: trigger.kind,
      loginBlocked,
    })
    const laneKey = `${run.id}:${sourceTerminalId}:${trigger.kind}`
    if (action === 'drop-lane') {
      if (seenRef.current.has(laneKey)) return
      seenRef.current.add(laneKey)
      failBoardLane(sourceTerminalId)
      endLaneStep(run, sourceTerminalId)
      return
    }
    void fireHandoff(run, trigger.kind, sourceAgent, sourceTerminalId, {
      prompt: action === 'retarget-slice' && lane.slicePrompt ? lane.slicePrompt : run.prompt,
      pauseRun: action === 'handoff-run',
      errorNote:
        trigger.kind === 'error'
          ? action === 'retarget-slice'
            ? `${AGENT_TYPE_LABELS[sourceAgent]} failed this slice. Finish only this slice; do not redo sibling panes.`
            : `${AGENT_TYPE_LABELS[sourceAgent]} failed. Continue from its output and finish the user request.`
          : undefined,
    })
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
      .map((run) => `${run.id}:${runStepTerminals(run).map((step) => step.terminalId).join(',')}`)
      .sort()
      .join('|'),
  )
  const ptyBindings = useProjectsStore((state) =>
    Object.values(usePromptRunStore.getState().byProjectId)
      .filter((run) => run.status === 'running')
      .map((run) => {
        const project = state.projects.find((entry) => entry.id === run.projectId)
        return `${run.id}:${runStepTerminals(run)
          .map((step) => {
            const terminal = project?.terminals.find((entry) => entry.id === step.terminalId)
            const tab =
              terminal?.tabs.find((entry) => entry.id === terminal.activeTabId) ?? terminal?.tabs[0]
            return tab?.ptyId ?? ''
          })
          .join(',')}`
      })
      .sort()
      .join('|'),
  )

  useEffect(() => {
    const unlistens: Array<() => void> = []
    let cancelled = false
    for (const run of runningRuns()) {
      for (const step of runStepTerminals(run)) {
        const pane = resolvePane(run.projectId, step.terminalId)
        const ptyId = pane?.tab.ptyId
        if (!ptyId) continue
        const subscribedTerminalId = step.terminalId
        const sourceAgent = step.agent
        void listenPtyData(ptyId, (chunk) => {
          const current = usePromptRunStore.getState().byProjectId[run.projectId]
          if (!current || current.id !== run.id) return
          considerTrigger(current, chunk, sourceAgent, subscribedTerminalId)
          if (!shouldIngestContext(current, subscribedTerminalId, chunk)) return
          const previous = ingestTimersRef.current.get(current.id)
          if (previous) window.clearTimeout(previous)
          ingestTimersRef.current.set(
            current.id,
            window.setTimeout(() => {
              ingestTimersRef.current.delete(current.id)
              const latest = usePromptRunStore.getState().byProjectId[run.projectId]
              if (!latest || latest.id !== run.id || !latest.canonicalClaudeSessionId) return
              void ingestRunContext(
                latest.id,
                'claude',
                latest.canonicalClaudeSessionId,
                latest.cwd,
              ).catch((cause) => {
                console.warn('[prompt-run] context ingest failed:', cause)
              })
            }, 800),
          )
        }).then((unlisten) => {
          if (cancelled) {
            unlisten()
            return
          }
          unlistens.push(unlisten)
        })
      }
    }
    return () => {
      cancelled = true
      for (const unlisten of unlistens) unlisten()
      for (const timer of ingestTimersRef.current.values()) window.clearTimeout(timer)
      ingestTimersRef.current.clear()
    }
  }, [runBindings, ptyBindings, t])
}
