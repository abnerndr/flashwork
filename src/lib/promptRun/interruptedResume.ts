import type { PromptRun, PromptRunInterruptReason } from '../types'

/** Interrupted Auto / board runs stay offerable for seven days. */
export const INTERRUPTED_RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function isInterruptedRunOfferable(
  run: Pick<PromptRun, 'status' | 'interruptedAt'>,
  now = Date.now(),
): boolean {
  if (run.status !== 'interrupted') return false
  const at = run.interruptedAt
  if (typeof at !== 'number' || !Number.isFinite(at)) return false
  return now - at <= INTERRUPTED_RUN_TTL_MS
}

export function markRunInterrupted(
  run: PromptRun,
  reason: PromptRunInterruptReason,
  now = Date.now(),
): PromptRun {
  return {
    ...run,
    status: 'interrupted',
    interruptedAt: now,
    interruptReason: reason,
  }
}

/** Prompt for Auto resume: original task plus a pointer to the interrupted journal. */
export function buildInterruptedResumePrompt(run: PromptRun): string {
  const journal = run.journalPath?.trim()
  const pointer = journal
    ? `Previous work was interrupted. Continue from the journal at ${journal}.`
    : 'Previous work was interrupted. Continue from where you left off.'
  return `${run.prompt.trim()}\n\n---\n${pointer}`
}
