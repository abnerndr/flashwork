import type { AgentType } from '../types'
import { QUOTA_HANDOFF_THRESHOLD } from './constants'

export type HandoffTriggerKind = 'quota' | 'error' | 'user'

export type HandoffTriggerInput = {
  activeAgent: AgentType
  claudeFiveHourUtilization: number | null
  codexRateLimited: boolean
  ptyChunk: string
}

const HANDOFF_PREF: AgentType[] = [
  'claude',
  'gemini',
  'codex',
  'antigravity',
  'copilot',
  'opencode',
  'mimo',
  'freebuff',
]

const AUTH_ERROR_PATTERN =
  /api[_ ]key not valid|invalid api key|api_key_invalid|authentication (failed|error)|error when talking to gemini api/i

const LOGIN_BLOCK_PATTERN =
  /github\.com\/login\/device|do you want to login|enter (an? )?api key/i

const RATE_ERROR_PATTERN =
  /429|rate[\s-]?limit|quota exceeded|usage limit|overloaded/i

export function isAgentAuthError(text: string): boolean {
  return AUTH_ERROR_PATTERN.test(text)
}

export function isAgentLoginBlock(text: string): boolean {
  return LOGIN_BLOCK_PATTERN.test(text)
}

export function detectHandoffTrigger(input: HandoffTriggerInput): { kind: HandoffTriggerKind } | null {
  if (input.activeAgent === 'shell') return null
  if (input.activeAgent === 'claude') {
    if (
      input.claudeFiveHourUtilization != null &&
      input.claudeFiveHourUtilization >= QUOTA_HANDOFF_THRESHOLD
    ) {
      return { kind: 'quota' }
    }
  }
  if (input.activeAgent === 'codex' && input.codexRateLimited) return { kind: 'quota' }
  if (!input.ptyChunk) return null
  if (isAgentAuthError(input.ptyChunk) || RATE_ERROR_PATTERN.test(input.ptyChunk)) {
    return { kind: 'error' }
  }
  return null
}

export function handoffTarget(
  source: AgentType,
  installedAgents: AgentType[],
  occupiedAgents: readonly AgentType[] = [],
): AgentType | null {
  const installed = installedAgents.filter((agent) => agent !== 'shell' && agent !== source)
  if (installed.length === 0) return null
  const occupied = new Set(occupiedAgents)
  const free = installed.filter((agent) => !occupied.has(agent))
  const pool = free.length > 0 ? free : installed
  return HANDOFF_PREF.find((agent) => pool.includes(agent)) ?? pool[0] ?? null
}
