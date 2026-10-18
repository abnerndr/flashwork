import type { PromptRun } from '../types'

export function shouldIngestContext(
  run: PromptRun,
  sourceTerminalId: string,
  _chunk: string,
): boolean {
  if (!run.canonicalClaudeSessionId) return false
  if (run.canonicalClaudeTerminalId && run.canonicalClaudeTerminalId === sourceTerminalId) {
    return true
  }
  const step = run.steps.find((entry) => entry.terminalId === sourceTerminalId)
  const agent =
    step?.agent ?? (run.activeTerminalId === sourceTerminalId ? run.activeAgent : undefined)
  return agent === 'claude'
}
