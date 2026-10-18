import { detectAgentsForCwd, findCliLauncher } from '../tauri'
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

/**
 * Agents from `enabled` whose CLI is installed. With `cwd`, detection runs for
 * that folder: a project inside WSL is probed inside its distro (one backend
 * call), so a CLI installed only on the Windows side does not count.
 */
export async function probeInstalledAgents(
  enabled: AgentType[],
  cwd?: string,
): Promise<AgentType[]> {
  const key = `${cwd ?? ''}|${enabled.join(',')}`
  if (cache && cache.key === key && Date.now() - cache.at < CACHE_MS) {
    return cache.agents
  }
  const commands = enabled
    .map((agent) => ({ agent, command: agentCliCommand(agent) }))
    .filter((entry): entry is { agent: AgentType; command: string } => Boolean(entry.command))

  let found: AgentType[]
  if (cwd) {
    const detections = await detectAgentsForCwd(
      cwd,
      commands.map((entry) => entry.command),
    ).catch(() => [])
    const installed = new Set(detections.filter((d) => d.installed).map((d) => d.agent))
    found = commands.filter((entry) => installed.has(entry.command)).map((entry) => entry.agent)
  } else {
    found = (
      await Promise.all(
        commands.map(async ({ agent, command }) => {
          const path = await findCliLauncher(command).catch(() => null)
          return path ? agent : null
        }),
      )
    ).filter((agent): agent is AgentType => Boolean(agent))
  }
  cache = { key, at: Date.now(), agents: found }
  return found
}
