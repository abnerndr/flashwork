import { describe, expect, it } from 'vitest'

import { buildHandoffTerminalArgs, executeAutoHandoff } from './executeHandoff'

describe('buildHandoffTerminalArgs', () => {
  it('points the target pane at the capsule path', () => {
    const args = buildHandoffTerminalArgs({
      target: 'codex',
      cwd: '/repo',
      bootstrap: 'Read the packet at "/tmp/context.md"',
      extraArgs: ['--dangerously-bypass-approvals-and-sandbox'],
      handoff: {
        id: 'h1',
        contextDir: '/tmp/h1',
        contextPath: '/tmp/h1/context.md',
        sourceProvider: 'claude',
        sourceSessionId: 'sess',
      },
      paneName: 'Handoff to Codex',
    })
    expect(args.cwd).toBe('/repo')
    expect(args.firstTab.type).toBe('codex')
    expect(args.firstTab.handoff?.id).toBe('h1')
    expect(args.firstTab.initialInput).toContain('/tmp/context.md')
  })
})

describe('executeAutoHandoff', () => {
  it('falls back to the journal path and prompt when prepare fails', async () => {
    const result = await executeAutoHandoff(
      {
        source: 'claude',
        target: 'codex',
        cwd: '/repo',
        extraArgs: [],
        paneName: 'Handoff to Codex',
        journalPath: '/profile/runs/r1/journal.md',
        prompt: 'implement login',
        sourceSessionId: 'sess',
      },
      {
        prepareAgentHandoff: async () => {
          throw new Error('no session')
        },
        materializeAgentHandoff: async () => {
          throw new Error('should not materialize')
        },
      },
    )
    expect(result.usedFallback).toBe(true)
    expect(result.artifact).toBeNull()
    expect(result.terminalArgs.firstTab.initialInput).toContain('/profile/runs/r1/journal.md')
    expect(result.terminalArgs.firstTab.initialInput).toContain('implement login')
    expect(result.terminalArgs.firstTab.handoff).toBeUndefined()
  })
})
