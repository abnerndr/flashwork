import { QUOTA_HANDOFF_THRESHOLD, PROMPT_RUN_HANDOFF_PAIR } from './constants'
import type { AgentType } from '../types'

export type HandoffTriggerKind = 'quota' | 'error' | 'user'

export type HandoffTriggerInput = {
  activeAgent: AgentType
  claudeFiveHourUtilization: number | null
  codexRateLimited: boolean
  ptyChunk: string
}

const ERROR_PATTERN =
  /429|rate[\s-]?limit|quota exceeded|usage limit|overloaded|authentication (failed|error)|invalid api key/i

export function detectHandoffTrigger(input: HandoffTriggerInput): { kind: HandoffTriggerKind } | null {
  if (!PROMPT_RUN_HANDOFF_PAIR.includes(input.activeAgent as 'claude' | 'codex')) return null
  if (input.activeAgent === 'claude') {
    if (
      input.claudeFiveHourUtilization != null &&
      input.claudeFiveHourUtilization >= QUOTA_HANDOFF_THRESHOLD
    ) {
      return { kind: 'quota' }
    }
  }
  if (input.activeAgent === 'codex' && input.codexRateLimited) return { kind: 'quota' }
  if (input.ptyChunk && ERROR_PATTERN.test(input.ptyChunk)) return { kind: 'error' }
  return null
}

export function handoffTarget(
  source: AgentType,
  installedAgents: AgentType[],
): 'claude' | 'codex' | null {
  if (source === 'claude' && installedAgents.includes('codex')) return 'codex'
  if (source === 'codex' && installedAgents.includes('claude')) return 'claude'
  return null
}
