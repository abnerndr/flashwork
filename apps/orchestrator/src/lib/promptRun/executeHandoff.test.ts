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

const failingPrepare = {
  prepareAgentHandoff: async () => {
    throw new Error('no session')
  },
  materializeAgentHandoff: async () => {
    throw new Error('should not materialize')
  },
}

describe('executeAutoHandoff', () => {
  it('falls back to the journal path and prompt when prepare fails', async () => {
    const result = await executeAutoHandoff(
      {
        source: 'claude',
        target: 'codex',
        cwd: '/repo',
        extraArgs: [],
        paneName: 'Handoff to Codex',
        runId: 'r1',
        journalPath: '/profile/runs/r1/journal.md',
        prompt: 'implement login',
        sourceSessionId: 'sess',
      },
      failingPrepare,
    )
    expect(result.usedFallback).toBe(true)
    expect(result.artifact).toBeNull()
    expect(result.terminalArgs.firstTab.initialInput).toContain('/profile/runs/r1/journal.md')
    expect(result.terminalArgs.firstTab.initialInput).toContain('implement login')
    expect(result.terminalArgs.firstTab.handoff).toBeUndefined()
  })

  it('omits a logical journal path and still includes the prompt', async () => {
    const result = await executeAutoHandoff(
      {
        source: 'claude',
        target: 'codex',
        cwd: '/repo',
        extraArgs: [],
        paneName: 'Handoff to Codex',
        runId: 'run_test',
        journalPath: 'runs/run_test/journal.md',
        prompt: 'implement login',
      },
      {
        ...failingPrepare,
        loadPromptRun: async () => null,
      },
    )
    expect(result.usedFallback).toBe(true)
    expect(result.terminalArgs.firstTab.initialInput).toContain('implement login')
    expect(result.terminalArgs.firstTab.initialInput).not.toContain('runs/run_test/journal.md')
  })

  it('resolves a logical journal path through loadPromptRun', async () => {
    const result = await executeAutoHandoff(
      {
        source: 'claude',
        target: 'codex',
        cwd: '/repo',
        extraArgs: [],
        paneName: 'Handoff to Codex',
        runId: 'run_test',
        journalPath: 'runs/run_test/journal.md',
        prompt: 'implement login',
      },
      {
        ...failingPrepare,
        loadPromptRun: async (runId) => {
          expect(runId).toBe('run_test')
          return { journalPath: '/profile/runs/run_test/journal.md' }
        },
      },
    )
    expect(result.usedFallback).toBe(true)
    expect(result.terminalArgs.firstTab.initialInput).toContain('/profile/runs/run_test/journal.md')
    expect(result.terminalArgs.firstTab.initialInput).toContain('implement login')
    expect(result.terminalArgs.firstTab.initialInput).not.toContain('"runs/run_test/journal.md"')
  })

  it('skips the Claude↔Codex capsule when Gemini fails and continues on Claude', async () => {
    const prepareAgentHandoff = async () => {
      throw new Error('should not prepare a Gemini capsule')
    }
    const result = await executeAutoHandoff(
      {
        source: 'gemini',
        target: 'claude',
        cwd: '/repo',
        extraArgs: [],
        paneName: 'Handoff to Claude Code',
        journalPath: '/profile/runs/r1/journal.md',
        prompt: 'implement login',
        errorNote: 'Gemini failed: API key not valid.',
      },
      { prepareAgentHandoff, materializeAgentHandoff: async () => ({ handoffId: 'x', contextDir: '', contextPath: '' }) },
    )
    expect(result.usedFallback).toBe(true)
    expect(result.terminalArgs.firstTab.type).toBe('claude')
    expect(result.terminalArgs.firstTab.initialInput).toContain('API key not valid')
    expect(result.terminalArgs.firstTab.initialInput).toContain('implement login')
  })

  it('points the target at the chunk hub instead of dumping the capsule', async () => {
    const capsule = 'FULL CAPSULE BODY '.repeat(40)
    const result = await executeAutoHandoff(
      {
        source: 'claude',
        target: 'codex',
        cwd: '/repo',
        extraArgs: [],
        paneName: 'Handoff to Codex',
        prompt: 'implement login',
        sourceSessionId: 'sess',
      },
      {
        prepareAgentHandoff: async () => ({
          sourceProvider: 'claude',
          targetProvider: 'codex',
          sourceSessionId: 'sess',
          cwd: '/repo',
          title: 'login',
          content: capsule,
          includedEventCount: 2,
          omittedEventCount: 0,
          redactionCount: 0,
          usedFallback: false,
        }),
        materializeAgentHandoff: async () => ({
          handoffId: 'h1',
          contextDir: '/profile/handoffs/h1/context',
          contextPath: '/profile/handoffs/h1/context/manifest.json',
        }),
      },
    )
    expect(result.usedFallback).toBe(false)
    expect(result.terminalArgs.firstTab.initialInput).toContain('manifest.json')
    expect(result.terminalArgs.firstTab.initialInput).toContain('/profile/handoffs/h1/context')
    expect(result.terminalArgs.firstTab.initialInput).toContain('implement login')
    expect(result.terminalArgs.firstTab.initialInput.length).toBeLessThan(1500)
    expect(result.terminalArgs.firstTab.initialInput).not.toContain('FULL CAPSULE BODY')
  })
})
