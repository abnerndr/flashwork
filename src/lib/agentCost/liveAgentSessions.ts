import { savedConversationIdFor, type ActiveSessions } from '../sessionResume'
import type { AgentType, SubTab } from '../types'

export type LiveCostCandidate = {
  ptyId: string
  alive: boolean
  agent: AgentType
  cwd: string
  sessionId: string | undefined
}

export type LiveCostTarget = {
  ptyId: string
  agent: AgentType
  cwd: string
  sessionId: string | undefined
}

type PaneTab = Pick<SubTab, 'type' | 'cwd' | 'ptyId' | 'sessionId'>

type PaneProject = {
  terminals: ReadonlyArray<{ tabs: ReadonlyArray<PaneTab> }>
}

/** Alive coding-agent panes. Shell and dead PTYs are dropped; session id is optional. */
export function selectLiveCostTargets(candidates: LiveCostCandidate[]): LiveCostTarget[] {
  const out: LiveCostTarget[] = []
  for (const candidate of candidates) {
    if (!candidate.alive) continue
    if (candidate.agent === 'shell') continue
    out.push({
      ptyId: candidate.ptyId,
      agent: candidate.agent,
      cwd: candidate.cwd,
      sessionId: candidate.sessionId,
    })
  }
  return out
}

/** Walk project tabs and combine with PTY alive flags plus any saved conversation id. */
export function listPaneCostCandidates(
  projects: ReadonlyArray<PaneProject>,
  runtimeByPtyId: Record<string, { alive?: boolean }>,
  sessions: ActiveSessions,
): LiveCostCandidate[] {
  const out: LiveCostCandidate[] = []
  const seen = new Set<string>()
  for (const project of projects) {
    for (const terminal of project.terminals) {
      for (const tab of terminal.tabs) {
        if (!tab.ptyId || seen.has(tab.ptyId)) continue
        seen.add(tab.ptyId)
        const sessionId =
          savedConversationIdFor(sessions[tab.ptyId] ?? null, tab.type, tab.cwd) ??
          tab.sessionId ??
          undefined
        out.push({
          ptyId: tab.ptyId,
          alive: Boolean(runtimeByPtyId[tab.ptyId]?.alive),
          agent: tab.type,
          cwd: tab.cwd,
          sessionId: sessionId || undefined,
        })
      }
    }
  }
  return out
}
