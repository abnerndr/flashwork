import { describe, expect, it } from 'vitest'

import { detectHandoffTrigger, handoffTarget } from './detectHandoffTrigger'

describe('detectHandoffTrigger', () => {
  it('fires on Claude 5h quota', () => {
    expect(
      detectHandoffTrigger({
        activeAgent: 'claude',
        claudeFiveHourUtilization: 80,
        codexRateLimited: false,
        ptyChunk: '',
      }),
    ).toEqual({ kind: 'quota' })
  })

  it('does not fire below the threshold', () => {
    expect(
      detectHandoffTrigger({
        activeAgent: 'claude',
        claudeFiveHourUtilization: 79,
        codexRateLimited: false,
        ptyChunk: '',
      }),
    ).toBeNull()
  })

  it('fires when Codex is rate limited', () => {
    expect(
      detectHandoffTrigger({
        activeAgent: 'codex',
        claudeFiveHourUtilization: null,
        codexRateLimited: true,
        ptyChunk: '',
      }),
    ).toEqual({ kind: 'quota' })
  })

  it('fires on rate-limit text in the PTY', () => {
    expect(
      detectHandoffTrigger({
        activeAgent: 'claude',
        claudeFiveHourUtilization: 10,
        codexRateLimited: false,
        ptyChunk: 'Error: HTTP 429 rate limit exceeded',
      }),
    ).toEqual({ kind: 'error' })
  })

  it('ignores OpenCode for automatic handoff in this cycle', () => {
    expect(
      detectHandoffTrigger({
        activeAgent: 'opencode',
        claudeFiveHourUtilization: 99,
        codexRateLimited: true,
        ptyChunk: '429',
      }),
    ).toBeNull()
  })
})

describe('handoffTarget', () => {
  it('swaps claude and codex when the other is installed', () => {
    expect(handoffTarget('claude', ['claude', 'codex'])).toBe('codex')
    expect(handoffTarget('codex', ['claude', 'codex'])).toBe('claude')
  })

  it('returns null when the peer is missing', () => {
    expect(handoffTarget('claude', ['claude'])).toBeNull()
  })
})
