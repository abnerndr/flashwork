import { describe, expect, it } from 'vitest'

import type { PromptRun } from '../types'
import {
  buildInterruptedResumePrompt,
  INTERRUPTED_RUN_TTL_MS,
  isInterruptedRunOfferable,
  markRunInterrupted,
} from './interruptedResume'

function sampleRun(overrides: Partial<PromptRun> = {}): PromptRun {
  return {
    id: 'run-1',
    projectId: 'proj',
    cwd: '/work',
    prompt: 'Ship the fix',
    status: 'running',
    activeAgent: 'claude',
    activeTerminalId: 'term-1',
    unrestricted: false,
    steps: [],
    journalPath: 'runs/run-1/journal.md',
    createdAt: 1_000,
    ...overrides,
  }
}

describe('interruptedResume', () => {
  it('marks a run interrupted with reason and timestamp', () => {
    const next = markRunInterrupted(sampleRun(), 'quit', 5_000)
    expect(next.status).toBe('interrupted')
    expect(next.interruptedAt).toBe(5_000)
    expect(next.interruptReason).toBe('quit')
  })

  it('offers interrupted runs only within the 7-day TTL', () => {
    const interrupted = markRunInterrupted(sampleRun(), 'orphan-pty', 1_000)
    expect(isInterruptedRunOfferable(interrupted, 1_000 + INTERRUPTED_RUN_TTL_MS)).toBe(true)
    expect(isInterruptedRunOfferable(interrupted, 1_000 + INTERRUPTED_RUN_TTL_MS + 1)).toBe(false)
    expect(isInterruptedRunOfferable(sampleRun({ status: 'cancelled' }), 2_000)).toBe(false)
  })

  it('builds a resume prompt that keeps the original task and points at the journal', () => {
    const run = markRunInterrupted(sampleRun(), 'unclean-exit')
    const prompt = buildInterruptedResumePrompt(run)
    expect(prompt).toContain('Ship the fix')
    expect(prompt).toContain('runs/run-1/journal.md')
  })
})
