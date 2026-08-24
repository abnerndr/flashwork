import { describe, expect, it } from 'vitest'

import { shouldIngestContext } from './ingestContext'
import type { PromptRun } from '../types'

function run(partial: Partial<PromptRun> = {}): PromptRun {
  return {
    id: 'run_1',
    projectId: 'p1',
    cwd: '/repo',
    prompt: 'fix auth',
    status: 'running',
    activeAgent: 'claude',
    activeTerminalId: 'term-claude',
    unrestricted: false,
    steps: [{ agent: 'claude', reason: 'heuristic', startedAt: 1, terminalId: 'term-claude' }],
    journalPath: 'runs/run_1/journal.md',
    canonicalClaudeSessionId: 'sess-a',
    canonicalClaudeTerminalId: 'term-claude',
    createdAt: 1,
    ...partial,
  }
}

describe('shouldIngestContext', () => {
  it('is true for the canonical Claude terminal when a session id is set', () => {
    expect(shouldIngestContext(run(), 'term-claude', 'chunk')).toBe(true)
  })

  it('is false when the run has no canonical Claude session', () => {
    expect(
      shouldIngestContext(run({ canonicalClaudeSessionId: undefined }), 'term-claude', 'chunk'),
    ).toBe(false)
  })

  it('is false for a Codex sibling pane', () => {
    expect(
      shouldIngestContext(
        run({
          steps: [
            { agent: 'claude', reason: 'heuristic', startedAt: 1, terminalId: 'term-claude' },
            { agent: 'codex', reason: 'heuristic', startedAt: 1, terminalId: 'term-codex' },
          ],
        }),
        'term-codex',
        'chunk',
      ),
    ).toBe(false)
  })
})
