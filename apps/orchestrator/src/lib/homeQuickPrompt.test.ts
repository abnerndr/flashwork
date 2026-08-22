import { describe, expect, it } from 'vitest'

import { resolveHomeQuickPrompt } from './homeQuickPrompt'

describe('resolveHomeQuickPrompt', () => {
  it('keeps the typed draft when returning to Home', () => {
    expect(resolveHomeQuickPrompt('build the auth flow')).toBe('build the auth flow')
  })

  it('does not restore a finished Auto run prompt after the draft was cleared', () => {
    expect(resolveHomeQuickPrompt('  ')).toBe('')
  })

  it('returns empty when nothing was saved', () => {
    expect(resolveHomeQuickPrompt('')).toBe('')
  })
})
