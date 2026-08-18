import { describe, expect, it } from 'vitest'

import { autoHandoffDedupeKey, claimAutoHandoff, isHandoffAborted } from './autoHandoffGate'

describe('autoHandoffDedupeKey', () => {
  it('lets the other agent quota-handoff after the first swap', () => {
    const claudeQuota = autoHandoffDedupeKey('run1', 'claude', 'quota')
    const codexQuota = autoHandoffDedupeKey('run1', 'codex', 'quota')
    expect(claudeQuota).toBe('run1:claude:quota')
    expect(codexQuota).toBe('run1:codex:quota')
    expect(claudeQuota).not.toBe(codexQuota)
  })

  it('still blocks repeating quota on the same agent', () => {
    expect(autoHandoffDedupeKey('run1', 'claude', 'quota')).toBe(
      autoHandoffDedupeKey('run1', 'claude', 'quota'),
    )
  })
})

describe('claimAutoHandoff', () => {
  it('adds inflight synchronously so a second claim cannot start', () => {
    const seen = new Set<string>()
    const inflight = new Set<string>()
    const first = claimAutoHandoff(seen, inflight, 'run1', 'run1:claude:quota')
    const second = claimAutoHandoff(seen, inflight, 'run1', 'run1:claude:error')
    expect(first).toBe(true)
    expect(second).toBe(false)
    expect(inflight.has('run1')).toBe(true)
  })

  it('rejects the same agent and kind even after inflight clears', () => {
    const seen = new Set<string>()
    const inflight = new Set<string>()
    expect(claimAutoHandoff(seen, inflight, 'run1', 'run1:claude:quota')).toBe(true)
    inflight.delete('run1')
    expect(claimAutoHandoff(seen, inflight, 'run1', 'run1:claude:quota')).toBe(false)
    expect(claimAutoHandoff(seen, inflight, 'run1', 'run1:codex:quota')).toBe(true)
  })
})

describe('isHandoffAborted', () => {
  it('aborts when the run is missing, replaced, or cancelled', () => {
    expect(isHandoffAborted(undefined, 'run1')).toBe(true)
    expect(isHandoffAborted({ id: 'run2', status: 'handing-off' }, 'run1')).toBe(true)
    expect(isHandoffAborted({ id: 'run1', status: 'cancelled' }, 'run1')).toBe(true)
  })

  it('lets handing-off and running continue for the same run', () => {
    expect(isHandoffAborted({ id: 'run1', status: 'handing-off' }, 'run1')).toBe(false)
    expect(isHandoffAborted({ id: 'run1', status: 'running' }, 'run1')).toBe(false)
  })
})
