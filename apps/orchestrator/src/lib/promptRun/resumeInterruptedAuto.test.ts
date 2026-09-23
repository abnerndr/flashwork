import { describe, expect, it } from 'vitest'

import { buildInterruptedResumePrompt } from './interruptedResume'
import type { PromptRun } from '../types'

describe('resumeInterruptedAuto prompt', () => {
  it('keeps the original prompt for Auto submit', () => {
    const run: PromptRun = {
      id: 'run-1',
      projectId: 'p',
      cwd: '/repo',
      prompt: 'Finish the auth gate',
      status: 'interrupted',
      activeAgent: 'claude',
      activeTerminalId: 't1',
      unrestricted: true,
      steps: [],
      journalPath: 'runs/run-1/journal.md',
      createdAt: 1,
      interruptedAt: 2,
      interruptReason: 'quit',
    }
    expect(buildInterruptedResumePrompt(run)).toMatch(/Finish the auth gate/)
    expect(buildInterruptedResumePrompt(run)).toMatch(/journal\.md/)
  })
})
