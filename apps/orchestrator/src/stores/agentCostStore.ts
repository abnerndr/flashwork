import { create } from 'zustand'

import { listPaneCostCandidates, selectLiveCostTargets } from '../lib/agentCost/liveAgentSessions'
import { getActiveSessions } from '../lib/sessionResume'
import { getSessionCost, type SessionCost } from '../lib/tauri'
import type { AgentType } from '../lib/types'
import { useProjectsStore } from './projectsStore'
import { useTerminalsStore } from './terminalsStore'

export type AgentCostEntry = {
  ptyId: string
  agent: AgentType
  sessionId: string | undefined
  cwd: string
  cost: SessionCost | null
  updatedAt: number
}

type AgentCostState = {
  byPtyId: Record<string, AgentCostEntry>
  refresh: () => Promise<void>
}

function liveAgentSessions() {
  return selectLiveCostTargets(
    listPaneCostCandidates(
      useProjectsStore.getState().projects,
      useTerminalsStore.getState().byPtyId,
      getActiveSessions(),
    ),
  )
}

function emptyEntry(
  live: { ptyId: string; agent: AgentType; cwd: string; sessionId: string | undefined },
  updatedAt: number,
): AgentCostEntry {
  return {
    ptyId: live.ptyId,
    agent: live.agent,
    sessionId: live.sessionId,
    cwd: live.cwd,
    cost: null,
    updatedAt,
  }
}

export const useAgentCostStore = create<AgentCostState>((set) => ({
  byPtyId: {},

  // API-path metering (`sessionCostFromProviderUsage`, synthetic `api:<provider>:<runId>`)
  // waits for P11 `provider_chat` usage in the JSON body.
  refresh: async () => {
    const live = liveAgentSessions()

    const results = await Promise.all(
      live.map(async (s) => {
        if (!s.sessionId) return emptyEntry(s, Date.now())
        try {
          const cost = await getSessionCost(s.agent, s.cwd, s.sessionId)
          return { ...s, cost, updatedAt: Date.now() } as AgentCostEntry
        } catch {
          // Unsupported agent or missing transcript: keep the row with no cost.
          return null
        }
      }),
    )

    set((state) => {
      const next: Record<string, AgentCostEntry> = {}
      for (const s of live) {
        const fresh = results.find((r) => r && r.ptyId === s.ptyId) ?? null
        next[s.ptyId] = fresh ?? state.byPtyId[s.ptyId] ?? emptyEntry(s, 0)
      }
      return { byPtyId: next }
    })
  },
}))

export function selectCostTotals(state: AgentCostState): {
  costUsd: number
  totalTokens: number
  agents: number
} {
  let costUsd = 0
  let totalTokens = 0
  let agents = 0
  for (const entry of Object.values(state.byPtyId)) {
    agents += 1
    if (entry.cost) {
      totalTokens += entry.cost.total_tokens
      if (entry.cost.cost_usd != null) costUsd += entry.cost.cost_usd
    }
  }
  return { costUsd, totalTokens, agents }
}
