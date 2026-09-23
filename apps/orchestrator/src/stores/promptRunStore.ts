import { create } from 'zustand'

import { listPromptRuns, savePromptRun } from '../lib/tauri'
import { restoreCanonicalClaudeFromRun } from '../lib/promptRun/claudeWriterLock'
import {
  isInterruptedRunOfferable,
  markRunInterrupted,
} from '../lib/promptRun/interruptedResume'
import { isPromptRunBlocking } from '../lib/promptRun/isPromptRunBlocking'
import type {
  PromptRun,
  PromptRunInterruptReason,
  PromptRunStatus,
  PromptRunStep,
} from '../lib/types'

type PromptRunState = {
  byProjectId: Record<string, PromptRun>
  hydrate: (projectId: string) => Promise<void>
  setRun: (run: PromptRun) => void
  patchRun: (projectId: string, patch: Partial<PromptRun>) => void
  appendStep: (projectId: string, step: PromptRunStep) => void
  setStatus: (projectId: string, status: PromptRunStatus) => void
  clear: (projectId: string) => void
  /** Mark in-memory active runs interrupted and flush to disk (app quit). */
  markActiveRunsInterrupted: (reason: PromptRunInterruptReason) => Promise<void>
  /** Persist discard of an interrupted run (cancelled). */
  discardInterrupted: (projectId: string, runId: string) => Promise<void>
}

type PersistSlot = {
  projectId: string
  getState: () => PromptRunState
  queued: boolean
  inFlight: boolean
}

const hydrateSeqByProject = new Map<string, number>()
const persistByRunId = new Map<string, PersistSlot>()

function shouldApplyHydrate(disk: PromptRun, memory: PromptRun | undefined): boolean {
  if (!memory) return true
  if (memory.id === disk.id) return false
  return disk.createdAt > memory.createdAt
}

async function flushPersist(runId: string): Promise<void> {
  const slot = persistByRunId.get(runId)
  if (!slot) return
  slot.queued = false
  const current = slot.getState().byProjectId[slot.projectId]
  if (current?.id === runId) {
    try {
      await savePromptRun(current)
    } catch (cause) {
      console.warn('[prompt-run] persist failed:', cause)
    }
  }
  if (slot.queued) {
    await flushPersist(runId)
    return
  }
  slot.inFlight = false
  persistByRunId.delete(runId)
}

function persist(getState: () => PromptRunState, projectId: string, runId: string): void {
  let slot = persistByRunId.get(runId)
  if (!slot) {
    slot = { projectId, getState, queued: false, inFlight: false }
    persistByRunId.set(runId, slot)
  }
  slot.projectId = projectId
  slot.getState = getState
  if (slot.inFlight) {
    slot.queued = true
    return
  }
  slot.inFlight = true
  void flushPersist(runId)
}

async function persistNow(run: PromptRun): Promise<void> {
  try {
    await savePromptRun(run)
  } catch (cause) {
    console.warn('[prompt-run] persist failed:', cause)
  }
}

/** Move linked Task Board cards into blocked + needsResume for an interrupted run. */
async function flagBoardNeedsResume(runId: string): Promise<void> {
  const { useTaskBoardStore } = await import('./taskBoardStore')
  const board = useTaskBoardStore.getState()
  for (const card of board.cards) {
    if (card.runId !== runId) continue
    if (card.column === 'doing' || card.column === 'verify' || card.needsResume) {
      board.patchCard(card.id, { needsResume: true, column: 'blocked' })
    }
  }
}

export const usePromptRunStore = create<PromptRunState>((set, get) => ({
  byProjectId: {},
  hydrate: async (projectId) => {
    const sequence = (hydrateSeqByProject.get(projectId) ?? 0) + 1
    hydrateSeqByProject.set(projectId, sequence)
    let runs: PromptRun[]
    try {
      runs = await listPromptRuns(projectId)
    } catch (cause) {
      console.warn('[prompt-run] hydrate failed:', cause)
      return
    }
    if (hydrateSeqByProject.get(projectId) !== sequence) return

    // Expire stale interrupted offers on disk.
    for (const run of runs) {
      if (run.status === 'interrupted' && !isInterruptedRunOfferable(run)) {
        const cancelled = { ...run, status: 'cancelled' as const }
        await persistNow(cancelled)
      }
    }

    const active = runs.find((run) => run.status === 'running' || run.status === 'handing-off')
    if (!active) {
      const offerable = runs
        .filter((run) => isInterruptedRunOfferable(run))
        .sort((a, b) => (b.interruptedAt ?? 0) - (a.interruptedAt ?? 0))[0]
      if (!offerable) return
      set((state) => {
        const memory = state.byProjectId[projectId]
        if (memory && memory.id !== offerable.id && memory.status === 'running') return state
        return { byProjectId: { ...state.byProjectId, [projectId]: offerable } }
      })
      await flagBoardNeedsResume(offerable.id)
      return
    }
    const { useProjectsStore } = await import('./projectsStore')
    const project = useProjectsStore.getState().projects.find((item) => item.id === projectId)
    if (
      project &&
      !isPromptRunBlocking(
        active.status,
        [active.activeTerminalId, ...active.steps.map((step) => step.terminalId)].filter(
          (id): id is string => Boolean(id),
        ),
        project.terminals.map((terminal) => terminal.id),
      )
    ) {
      const interrupted = markRunInterrupted(active, 'orphan-pty')
      set((state) => {
        const memory = state.byProjectId[projectId]
        if (memory && !shouldApplyHydrate(interrupted, memory) && memory.id !== interrupted.id) {
          return state
        }
        return { byProjectId: { ...state.byProjectId, [projectId]: interrupted } }
      })
      await persistNow(interrupted)
      await flagBoardNeedsResume(interrupted.id)
      return
    }
    let appliedId: string | undefined
    set((state) => {
      const memory = state.byProjectId[projectId]
      if (!shouldApplyHydrate(active, memory)) return state
      appliedId = active.id
      restoreCanonicalClaudeFromRun(active)
      return { byProjectId: { ...state.byProjectId, [projectId]: active } }
    })
    const current = get().byProjectId[projectId]
    if (appliedId && current?.id === appliedId && current.status === 'handing-off') {
      get().setStatus(projectId, 'running')
    }
  },
  setRun: (run) => {
    restoreCanonicalClaudeFromRun(run)
    set((state) => ({ byProjectId: { ...state.byProjectId, [run.projectId]: run } }))
    persist(get, run.projectId, run.id)
  },
  patchRun: (projectId, patch) => {
    const current = get().byProjectId[projectId]
    if (!current) return
    const next = { ...current, ...patch }
    restoreCanonicalClaudeFromRun(next)
    set((state) => ({ byProjectId: { ...state.byProjectId, [projectId]: next } }))
    persist(get, projectId, next.id)
  },
  appendStep: (projectId, step) => {
    const current = get().byProjectId[projectId]
    if (!current) return
    const next = { ...current, steps: [...current.steps, step] }
    set((state) => ({ byProjectId: { ...state.byProjectId, [projectId]: next } }))
    persist(get, projectId, next.id)
  },
  setStatus: (projectId, status) => {
    get().patchRun(projectId, { status })
  },
  clear: (projectId) => {
    set((state) => {
      const byProjectId = { ...state.byProjectId }
      delete byProjectId[projectId]
      return { byProjectId }
    })
  },
  markActiveRunsInterrupted: async (reason) => {
    const entries = Object.entries(get().byProjectId)
    const nextMap: Record<string, PromptRun> = { ...get().byProjectId }
    const toSave: PromptRun[] = []
    for (const [projectId, run] of entries) {
      if (run.status !== 'running' && run.status !== 'handing-off') continue
      const interrupted = markRunInterrupted(run, reason)
      nextMap[projectId] = interrupted
      toSave.push(interrupted)
    }
    if (toSave.length === 0) return
    set({ byProjectId: nextMap })
    await Promise.all(toSave.map((run) => persistNow(run)))
    for (const run of toSave) {
      await flagBoardNeedsResume(run.id)
    }
  },
  discardInterrupted: async (projectId, runId) => {
    const current = get().byProjectId[projectId]
    const target =
      current?.id === runId
        ? current
        : (await listPromptRuns(projectId).catch(() => [] as PromptRun[])).find(
            (run) => run.id === runId,
          )
    if (!target) return
    const cancelled = { ...target, status: 'cancelled' as const }
    set((state) => {
      const byProjectId = { ...state.byProjectId }
      if (byProjectId[projectId]?.id === runId) delete byProjectId[projectId]
      return { byProjectId }
    })
    await persistNow(cancelled)
    const { useTaskBoardStore } = await import('./taskBoardStore')
    const board = useTaskBoardStore.getState()
    for (const card of board.cards) {
      if (card.runId === runId) {
        board.patchCard(card.id, { needsResume: false, error: undefined })
      }
    }
  },
}))

/** Collect interrupted runs still within TTL across projects (disk scan). */
export async function listOfferableInterruptedRuns(
  projectIds: string[],
): Promise<PromptRun[]> {
  const found: PromptRun[] = []
  for (const projectId of projectIds) {
    let runs: PromptRun[]
    try {
      runs = await listPromptRuns(projectId)
    } catch {
      continue
    }
    for (const run of runs) {
      if (isInterruptedRunOfferable(run)) found.push(run)
    }
  }
  return found.sort((a, b) => (b.interruptedAt ?? 0) - (a.interruptedAt ?? 0))
}
