import { describe, expect, it } from 'vitest'

import { buildRunBootstrapInput } from './bootstrapPrompt'

describe('buildRunBootstrapInput', () => {
  it('includes allowed files and the shared board path for workers', () => {
    const text = buildRunBootstrapInput({
      runId: 'run_1',
      prompt: 'implement login',
      agent: 'claude',
      role: 'worker',
      allowedFiles: ['src/auth.ts'],
      boardPath: '/profile/runs/run_1/board.md',
    })
    expect(text).toContain('src/auth.ts')
    expect(text).toContain('/profile/runs/run_1/board.md')
    expect(text).toContain('implement login')
  })

  it('does not mention an orchestrator TUI in the worker bootstrap', () => {
    const text = buildRunBootstrapInput({
      runId: 'run_1',
      prompt: 'implement login',
      agent: 'gemini',
      role: 'worker',
    })
    expect(text.toLowerCase()).not.toContain('freebuff')
    expect(text).toContain('worker (Gemini)')
  })
})
