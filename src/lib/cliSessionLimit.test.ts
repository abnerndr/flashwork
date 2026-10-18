import { describe, expect, it } from 'vitest'

import { formatWindowMinutes, resolveCliSessionSnapshot } from './cliSessionLimit'
import type { CliUsageBundle } from './cliSessionLimit'

const empty: CliUsageBundle = {
  claude: null,
  codex: null,
  antigravity: null,
  gemini: null,
  opencode: null,
}

describe('formatWindowMinutes', () => {
  it('formats minutes, hours, and days', () => {
    expect(formatWindowMinutes(45)).toBe('45m')
    expect(formatWindowMinutes(60)).toBe('1h')
    expect(formatWindowMinutes(180)).toBe('3h')
    expect(formatWindowMinutes(300)).toBe('5h')
    expect(formatWindowMinutes(60 * 24 * 7)).toBe('7d')
  })

  it('returns empty for unknown windows', () => {
    expect(formatWindowMinutes(0)).toBe('')
    expect(formatWindowMinutes(-1)).toBe('')
  })
})

describe('resolveCliSessionSnapshot', () => {
  it('builds a Claude 5h badge from utilization', () => {
    const snap = resolveCliSessionSnapshot('claude', {
      ...empty,
      claude: {
        five_hour: { utilization: 72.4, resets_at: '2026-01-01T00:00:00Z' },
        seven_day: { utilization: 10, resets_at: '' },
        seven_day_opus: { utilization: 5, resets_at: '' },
      },
    })
    expect(snap).toEqual({
      usedPercent: 72.4,
      windowLabel: '5h',
      badge: '72% · 5h',
      critical: false,
    })
  })

  it('uses Codex window_minutes instead of a hardcoded 5h label', () => {
    const snap = resolveCliSessionSnapshot('codex', {
      ...empty,
      codex: {
        primary: { used_percent: 40, window_minutes: 180, resets_at_ms: 0 },
        secondary: { used_percent: 10, window_minutes: 10080, resets_at_ms: 0 },
        plan: 'plus',
        rate_limited: false,
        reset_credits: 1,
      },
    })
    expect(snap?.windowLabel).toBe('3h')
    expect(snap?.badge).toBe('40% · 3h')
  })

  it('returns null when the CLI has no usage payload', () => {
    expect(resolveCliSessionSnapshot('claude', empty)).toBeNull()
    expect(resolveCliSessionSnapshot('shell', empty)).toBeNull()
  })
})
