import type { PromptRunStatus } from '../types'
import { isApiTerminalId } from './routedAgent'

function asTerminalIds(value: string | readonly string[] | undefined): string[] {
  if (!value) return []
  return typeof value === 'string' ? [value] : [...value]
}

export function isPromptRunBlocking(
  status: PromptRunStatus | undefined,
  runTerminalIds: string | readonly string[] | undefined,
  liveTerminalIds?: readonly string[],
): boolean {
  if (status !== 'running' && status !== 'handing-off') return false
  const ids = asTerminalIds(runTerminalIds).filter(Boolean)
  if (ids.some((id) => isApiTerminalId(id))) return true
  if (!liveTerminalIds) return true
  if (ids.length === 0) return false
  return ids.some((id) => liveTerminalIds.includes(id))
}
