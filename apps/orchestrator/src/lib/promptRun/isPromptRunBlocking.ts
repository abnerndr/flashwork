import type { PromptRunStatus } from '../types'

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
  if (!liveTerminalIds) return true
  const ids = asTerminalIds(runTerminalIds).filter(Boolean)
  if (ids.length === 0) return false
  return ids.some((id) => liveTerminalIds.includes(id))
}
