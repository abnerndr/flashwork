import { create } from 'zustand'

import { listPromptRuns, savePromptRun } from '../lib/tauri'
import type { PromptRun, PromptRunStatus, PromptRunStep } from '../lib/types'

type PromptRunState = {
  byProjectId: Record<string, PromptRun>
  hydrate: (projectId: string) => Promise<void>
  setRun: (run: PromptRun) => void
  patchRun: (projectId: string, patch: Partial<PromptRun>) => void
  appendStep: (projectId: string, step: PromptRunStep) => void
  setStatus: (projectId: string, status: PromptRunStatus) => void
  clear: (projectId: string) => void
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
    const active = runs.find((run) => run.status === 'running' || run.status === 'handing-off')
    if (!active) return
    set((state) => {
      const memory = state.byProjectId[projectId]
      if (!shouldApplyHydrate(active, memory)) return state
      return { byProjectId: { ...state.byProjectId, [projectId]: active } }
    })
  },
  setRun: (run) => {
    set((state) => ({ byProjectId: { ...state.byProjectId, [run.projectId]: run } }))
    persist(get, run.projectId, run.id)
  },
  patchRun: (projectId, patch) => {
    const current = get().byProjectId[projectId]
    if (!current) return
    const next = { ...current, ...patch }
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
}))
