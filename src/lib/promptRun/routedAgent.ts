import type { ProviderId } from '../providers/modelCatalog'
import { AGENT_TYPE_LABELS, type AgentType, type ApiAgentId, type RoutedAgent } from '../types'

export type { ApiAgentId, RoutedAgent }

const PROVIDER_IDS: ReadonlySet<string> = new Set(['google', 'openai', 'anthropic'])

export const ROUTER_PROVIDER_ORDER: readonly ProviderId[] = ['google', 'openai', 'anthropic']

const API_LABELS: Record<ProviderId, string> = {
  google: 'Gemini API',
  openai: 'OpenAI API',
  anthropic: 'Anthropic API',
}

export function isApiAgentId(value: string): value is ApiAgentId {
  if (!value.startsWith('api:')) return false
  return PROVIDER_IDS.has(value.slice(4))
}

export function providerFromApiAgent(id: ApiAgentId): ProviderId {
  return id.slice(4) as ProviderId
}

export function routedAgentLabel(agent: RoutedAgent): string {
  if (isApiAgentId(agent)) return API_LABELS[providerFromApiAgent(agent)]
  return AGENT_TYPE_LABELS[agent]
}

export async function firstSavedProvider(
  keyStatus: (id: ProviderId) => Promise<{ saved: boolean }>,
): Promise<ProviderId | null> {
  for (const id of ROUTER_PROVIDER_ORDER) {
    if ((await keyStatus(id)).saved) return id
  }
  return null
}

export function isApiTerminalId(id: string): boolean {
  return id.startsWith('api:')
}

export function hasCodingCli(installed: readonly AgentType[]): boolean {
  return installed.some((agent) => agent !== 'shell')
}
