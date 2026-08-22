import { afterEach, describe, expect, it } from 'vitest'

import { clearFailedAgents, excludeFailedAgents, markAgentAuthFailed } from './failedAgents'

describe('failedAgents', () => {
  afterEach(() => {
    clearFailedAgents()
  })

  it('keeps a CLI that has not failed', () => {
    expect(excludeFailedAgents(['claude', 'gemini', 'codex'])).toEqual(['claude', 'gemini', 'codex'])
  })

  it('omits a CLI after an auth or login failure', () => {
    markAgentAuthFailed('gemini')
    expect(excludeFailedAgents(['claude', 'gemini', 'codex'])).toEqual(['claude', 'codex'])
  })
})
