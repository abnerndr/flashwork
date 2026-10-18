import type { AgentType } from '../types'

const failed = new Set<AgentType>()

export function markAgentAuthFailed(agent: AgentType): void {
  if (agent === 'shell') return
  failed.add(agent)
}

export function excludeFailedAgents(installed: readonly AgentType[]): AgentType[] {
  return installed.filter((agent) => !failed.has(agent))
}

export function clearFailedAgents(): void {
  failed.clear()
}
