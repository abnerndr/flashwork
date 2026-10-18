import { agentCliCommand, type AgentType } from '../lib/types'
import { useCommandInstall } from './useCommandInstall'

export {
  type AgentInstallShadowConflict,
  type AgentInstallStatus,
  useAgentOperationBusy,
} from './useCommandInstall'

/**
 * `lockKey` identifies the run that holds the app-wide lock. It defaults to the agent, and only
 * differs when the same screen also installs something else for that agent — the Node toolchain —
 * which must not look like the agent's own run or the two would be allowed to run together.
 */
export function useAgentInstall(agent: AgentType, lockKey: string = agent) {
  return useCommandInstall(lockKey, agentCliCommand(agent) ?? agent)
}
