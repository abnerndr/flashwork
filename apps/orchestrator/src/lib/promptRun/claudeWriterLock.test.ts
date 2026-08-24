import { afterEach, describe, expect, it } from 'vitest'

import {
  canonicalClaudeSessionId,
  clearClaudeWriterLocks,
  rememberCanonicalClaude,
  releaseClaudeWriter,
  tryAcquireClaudeWriter,
} from './claudeWriterLock'

describe('claudeWriterLock', () => {
  afterEach(() => {
    clearClaudeWriterLocks()
  })

  it('lets the first Claude lane create the session and the second resume it', () => {
    rememberCanonicalClaude('run1', 'sess-a')
    expect(tryAcquireClaudeWriter('run1', 'term-1')).toBe('acquired')
    expect(tryAcquireClaudeWriter('run1', 'term-2')).toBe('wait')
    releaseClaudeWriter('run1', 'term-1')
    expect(tryAcquireClaudeWriter('run1', 'term-2')).toBe('acquired')
    expect(canonicalClaudeSessionId('run1')).toBe('sess-a')
  })
})
