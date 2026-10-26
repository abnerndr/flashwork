import { useEffect } from 'react'

import { pickDeepseekPlannerModel } from '../lib/promptRun/deepseekPlanner'
import {
  buildSpecContinuePrompt,
  parseContinueNudges,
  stalledSpecTasks,
} from '../lib/promptRun/specContinue'
import { getModelCatalog } from '../lib/providers/catalogOverlay'
import { submitPtyLine } from '../lib/ptySubmit'
import { providerChat, providerKeyStatus } from '../lib/tauri'
import { writePty } from '../lib/tauri/pty'
import type { PtyStatus } from '../lib/types'
import { useProjectsStore } from '../stores/projectsStore'
import { usePromptRunStore } from '../stores/promptRunStore'
import { useTerminalsStore } from '../stores/terminalsStore'

const TICK_MS = 8_000
const NUDGE_GAP_MS = 3 * 60_000

const lastNudgeAt = new Map<string, number>()

/** DeepSeek writes a continuation into every SPEC lane that has gone idle together. */
export function useSpecContinue(): void {
  useEffect(() => {
    const timer = window.setInterval(() => {
      void nudgeStalledSpec().catch((cause) => {
        console.warn('[run-spec] continue failed:', cause)
      })
    }, TICK_MS)
    return () => window.clearInterval(timer)
  }, [])
}

async function nudgeStalledSpec(): Promise<void> {
  const runs = Object.values(usePromptRunStore.getState().byProjectId)
  const run = runs.find((item) => item.status === 'running' && item.specTasks)
  if (!run?.specTasks) return
  const now = Date.now()
  const runtime = runtimeByTerminal(run.projectId, run.specTasks)
  const stalled = stalledSpecTasks(run.specTasks, runtime, now).filter((task) => {
    const terminalId = task.terminalId
    if (!terminalId) return false
    const previous = lastNudgeAt.get(terminalId) ?? 0
    return now - previous >= NUDGE_GAP_MS
  })
  if (stalled.length === 0) return
  const saved = await providerKeyStatus('deepseek').catch(() => ({ saved: false }))
  if (!saved.saved) return
  const model = pickDeepseekPlannerModel(run.prompt, getModelCatalog('deepseek'))
  const result = await providerChat(
    'deepseek',
    model,
    [{ role: 'user', content: buildSpecContinuePrompt(run.prompt, stalled) }],
    45_000,
  )
  const nudges = parseContinueNudges(result.text, stalled)
  for (const task of stalled) {
    if (!task.terminalId) continue
    const ptyId = terminalPtyId(run.projectId, task.terminalId)
    if (!ptyId) continue
    const line = submitPtyLine(nudges[task.id] ?? '')
    if (line) await writePty(ptyId, line)
    lastNudgeAt.set(task.terminalId, now)
  }
}

function runtimeByTerminal(
  projectId: string,
  tasks: readonly { terminalId?: string }[],
): Record<string, { status: PtyStatus; lastIoAt: number }> {
  const byPty = useTerminalsStore.getState().byPtyId
  const runtime: Record<string, { status: PtyStatus; lastIoAt: number }> = {}
  for (const task of tasks) {
    const ptyId = task.terminalId ? terminalPtyId(projectId, task.terminalId) : null
    const row = ptyId ? byPty[ptyId] : undefined
    if (task.terminalId && row) runtime[task.terminalId] = { status: row.status, lastIoAt: row.lastIoAt }
  }
  return runtime
}

function terminalPtyId(projectId: string, terminalId: string): string | null {
  const project = useProjectsStore.getState().projects.find((item) => item.id === projectId)
  const terminal = project?.terminals.find((item) => item.id === terminalId)
  const tab = terminal?.tabs.find((item) => item.id === terminal.activeTabId) ?? terminal?.tabs[0]
  return tab?.ptyId ?? null
}
