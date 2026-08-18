import { findCliLauncher } from '../tauri'
import { agentCliCommand, type AgentType } from '../types'

export async function probeInstalledAgents(enabled: AgentType[]): Promise<AgentType[]> {
  const found: AgentType[] = []
  for (const agent of enabled) {
    const command = agentCliCommand(agent)
    if (!command) continue
    const path = await findCliLauncher(command).catch(() => null)
    if (path) found.push(agent)
  }
  return found
}
