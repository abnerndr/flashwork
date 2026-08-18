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

function persist(run: PromptRun): void {
  void savePromptRun(run).catch((cause) => {
    console.warn('[prompt-run] persist failed:', cause)
  })
}

export const usePromptRunStore = create<PromptRunState>((set, get) => ({
  byProjectId: {},
  hydrate: async (projectId) => {
    const runs = await listPromptRuns(projectId).catch(() => [])
    const active = runs.find((run) => run.status === 'running' || run.status === 'handing-off')
    if (!active) return
    set((state) => ({ byProjectId: { ...state.byProjectId, [projectId]: active } }))
  },
  setRun: (run) => {
    set((state) => ({ byProjectId: { ...state.byProjectId, [run.projectId]: run } }))
    persist(run)
  },
  patchRun: (projectId, patch) => {
    const current = get().byProjectId[projectId]
    if (!current) return
    const next = { ...current, ...patch }
    set((state) => ({ byProjectId: { ...state.byProjectId, [projectId]: next } }))
    persist(next)
  },
  appendStep: (projectId, step) => {
    const current = get().byProjectId[projectId]
    if (!current) return
    const next = { ...current, steps: [...current.steps, step] }
    set((state) => ({ byProjectId: { ...state.byProjectId, [projectId]: next } }))
    persist(next)
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
