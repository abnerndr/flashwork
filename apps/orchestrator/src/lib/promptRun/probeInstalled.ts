import { findCliLauncher } from '../tauri'
import { agentCliCommand, type AgentType } from '../types'

const CACHE_MS = 30_000

type ProbeCache = {
  key: string
  at: number
  agents: AgentType[]
}

let cache: ProbeCache | null = null

export function clearInstalledAgentCache(): void {
  cache = null
}

export async function probeInstalledAgents(enabled: AgentType[]): Promise<AgentType[]> {
  const key = enabled.join(',')
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return cache.agents
  }
  const found = (
    await Promise.all(
      enabled.map(async (agent) => {
        const command = agentCliCommand(agent)
        if (!command) return null
        const path = await findCliLauncher(command).catch(() => null)
        return path ? agent : null
      }),
    )
  ).filter((agent): agent is AgentType => Boolean(agent))
  cache = { key, at: Date.now(), agents: found }
  return found
}
