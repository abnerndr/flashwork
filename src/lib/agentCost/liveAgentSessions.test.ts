import { describe, expect, it } from 'vitest'

import { listPaneCostCandidates, selectLiveCostTargets } from './liveAgentSessions'

describe('selectLiveCostTargets', () => {
  it('includes gemini panes without a session id', () => {
    const rows = selectLiveCostTargets([
      { ptyId: 'p1', alive: true, agent: 'gemini', cwd: '/repo', sessionId: undefined },
      { ptyId: 'p2', alive: true, agent: 'claude', cwd: '/repo', sessionId: 'abc' },
      { ptyId: 'p3', alive: false, agent: 'gemini', cwd: '/repo', sessionId: 'x' },
      { ptyId: 'p4', alive: true, agent: 'shell', cwd: '/repo', sessionId: undefined },
    ])
    expect(rows.map((r) => r.agent).sort()).toEqual(['claude', 'gemini'])
  })

  it('keeps copilot, antigravity, mimo and freebuff without a session id', () => {
    const rows = selectLiveCostTargets([
      { ptyId: 'p1', alive: true, agent: 'copilot', cwd: '/repo', sessionId: undefined },
      { ptyId: 'p2', alive: true, agent: 'antigravity', cwd: '/repo', sessionId: undefined },
      { ptyId: 'p3', alive: true, agent: 'mimo', cwd: '/repo', sessionId: undefined },
      { ptyId: 'p4', alive: true, agent: 'freebuff', cwd: '/repo', sessionId: undefined },
    ])
    expect(rows.map((r) => r.agent).sort()).toEqual(['antigravity', 'copilot', 'freebuff', 'mimo'])
  })

  it('preserves session ids when present and leaves missing ones undefined', () => {
    const rows = selectLiveCostTargets([
      { ptyId: 'p1', alive: true, agent: 'gemini', cwd: '/repo', sessionId: undefined },
      { ptyId: 'p2', alive: true, agent: 'claude', cwd: '/repo', sessionId: 'abc' },
    ])
    expect(rows.find((r) => r.agent === 'claude')?.sessionId).toBe('abc')
    expect(rows.find((r) => r.agent === 'gemini')?.sessionId).toBeUndefined()
  })
})

describe('listPaneCostCandidates', () => {
  it('maps ptyId to pane agent type and terminals-store alive flags', () => {
    const rows = listPaneCostCandidates(
      [
        {
          terminals: [
            {
              tabs: [
                { type: 'gemini', cwd: '/repo', ptyId: 'p1' },
                { type: 'claude', cwd: '/repo', ptyId: 'p2', sessionId: 'tab-claude' },
                { type: 'shell', cwd: '/repo', ptyId: 'p4' },
                { type: 'gemini', cwd: '/repo', ptyId: null },
              ],
            },
          ],
        },
      ],
      { p1: { alive: true }, p2: { alive: true }, p4: { alive: true } },
      {
        p2: {
          sessionId: 'pty-2',
          claudeSessionId: 'abc',
          cwd: '/repo',
          agent: 'claude',
          timestamp: 1,
        },
      },
    )
    expect(rows).toEqual([
      { ptyId: 'p1', alive: true, agent: 'gemini', cwd: '/repo', sessionId: undefined },
      { ptyId: 'p2', alive: true, agent: 'claude', cwd: '/repo', sessionId: 'abc' },
      { ptyId: 'p4', alive: true, agent: 'shell', cwd: '/repo', sessionId: undefined },
    ])
  })
})
