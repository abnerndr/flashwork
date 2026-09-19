import { pickEffectiveRouterModel } from '../providers/catalogOverlay'
import type { ProviderId } from '../providers/modelCatalog'
import { extractJsonObject } from '../taskBoard/planner'
import { providerChat, providerKeyStatus, ROUTER_TIMEOUT_MS } from '../tauri/providers'
import type { AgentType } from '../types'
import { firstSavedProvider } from './routedAgent'

export type { ApiAgentId, RoutedAgent } from './routedAgent'
export {
  isApiAgentId,
  isApiTerminalId,
  providerFromApiAgent,
  routedAgentLabel,
} from './routedAgent'
export { routeOpenTask, type RouteOpenResult, type RouteOpenTaskInput } from './routeTask'

export type FreeProbeDeps = {
  keyStatus: (id: ProviderId) => Promise<{ saved: boolean }>
  chat: (
    provider: ProviderId,
    model: string,
    messages: Array<{ role: 'system' | 'user'; content: string }>,
    timeoutMs: number,
  ) => Promise<{ text: string }>
  pickRouterModel?: (provider: ProviderId) => string
}

const PROBE_SYSTEM = [
  'Return ONLY a JSON object, no markdown.',
  'Schema: {"kind":"implement|review|mechanical|explore|ui|unknown","agent":"<installed cli id or api:<provider>>","reason":"<short>"}.',
  'agent must be an installed CLI id, or api:<that provider> when no suitable CLI is installed.',
].join(' ')

export function productionFreeProbeDeps(): FreeProbeDeps {
  return {
    keyStatus: providerKeyStatus,
    chat: providerChat,
    pickRouterModel: pickEffectiveRouterModel,
  }
}

export async function freeProbe(
  input: { prompt: string; installedAgents: AgentType[] },
  deps: FreeProbeDeps,
): Promise<unknown> {
  const provider = await firstSavedProvider(deps.keyStatus)
  if (!provider) return null

  const pick = deps.pickRouterModel ?? pickEffectiveRouterModel
  const installed =
    input.installedAgents.filter((agent) => agent !== 'shell').join(', ') || '(none)'
  let text = ''
  try {
    const result = await deps.chat(
      provider,
      pick(provider),
      [
        {
          role: 'system',
          content: `${PROBE_SYSTEM} Installed CLIs: ${installed}. This provider is ${provider}.`,
        },
        { role: 'user', content: input.prompt },
      ],
      ROUTER_TIMEOUT_MS,
    )
    text = result.text ?? ''
  } catch {
    return null
  }
  if (!text.trim()) return null
  return extractJsonObject(text)
}
