import { describe, expect, it } from 'vitest'

import {
  detectHandoffTrigger,
  handoffTarget,
  isAgentAuthError,
  isAgentLoginBlock,
} from './detectHandoffTrigger'

describe('isAgentAuthError', () => {
  it('matches Gemini API key failures', () => {
    expect(isAgentAuthError('API key not valid. Please pass a valid API key.')).toBe(true)
    expect(isAgentAuthError('API_KEY_INVALID')).toBe(true)
    expect(isAgentAuthError('rate limit exceeded')).toBe(false)
  })
})

describe('isAgentLoginBlock', () => {
  it('matches device-login and API-key prompts, not generic splash chrome', () => {
    expect(isAgentLoginBlock('Open https://github.com/login/device in your browser')).toBe(true)
    expect(isAgentLoginBlock('Please enter an API key')).toBe(true)
    expect(isAgentLoginBlock('Please sign in to continue')).toBe(false)
    expect(isAgentLoginBlock('Type your message')).toBe(false)
  })
})

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

  it('does not treat a boot sign-in hint as a failed lane', () => {
    expect(
      detectHandoffTrigger({
        activeAgent: 'claude',
        claudeFiveHourUtilization: 10,
        codexRateLimited: false,
        ptyChunk: 'Please sign in to continue',
      }),
    ).toBeNull()
  })

  it('fires when Gemini reports an invalid API key', () => {
    expect(
      detectHandoffTrigger({
        activeAgent: 'gemini',
        claudeFiveHourUtilization: null,
        codexRateLimited: false,
        ptyChunk:
          'API key not valid. Please pass a valid API key. API_KEY_INVALID Error when talking to Gemini API',
      }),
    ).toEqual({ kind: 'error' })
  })

  it('fires on OpenCode rate-limit text so another CLI can continue', () => {
    expect(
      detectHandoffTrigger({
        activeAgent: 'opencode',
        claudeFiveHourUtilization: 99,
        codexRateLimited: true,
        ptyChunk: '429 rate limit exceeded',
      }),
    ).toEqual({ kind: 'error' })
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

  it('hands Gemini off to Claude when both are installed', () => {
    expect(handoffTarget('gemini', ['gemini', 'claude'])).toBe('claude')
  })

  it('skips a busy sibling and picks Codex', () => {
    expect(handoffTarget('gemini', ['gemini', 'claude', 'codex'], ['claude'])).toBe('codex')
  })

  it('returns null when Gemini is the only installed CLI', () => {
    expect(handoffTarget('gemini', ['gemini'])).toBeNull()
  })
})
