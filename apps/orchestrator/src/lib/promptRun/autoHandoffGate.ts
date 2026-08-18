import type { AgentType } from '../types'
import type { HandoffTriggerKind } from './detectHandoffTrigger'

export function autoHandoffDedupeKey(
  runId: string,
  agent: AgentType,
  kind: HandoffTriggerKind,
): string {
  return `${runId}:${agent}:${kind}`
}

export function claimAutoHandoff(
  seen: Set<string>,
  inflight: Set<string>,
  runId: string,
  key: string,
): boolean {
  if (seen.has(key) || inflight.has(runId)) return false
  seen.add(key)
  inflight.add(runId)
  return true
}
