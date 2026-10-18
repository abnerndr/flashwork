import { describe, expect, it } from 'vitest'

import { buildRunBootstrapInput, buildSpecTaskBootstrap } from './bootstrapPrompt'

describe('buildRunBootstrapInput', () => {
  it('includes allowed files and the shared board path for workers', () => {
    const text = buildRunBootstrapInput({
      runId: 'run_1',
      prompt: 'implement login',
      agent: 'claude',
      role: 'worker',
      allowedFiles: ['src/auth.ts'],
      boardPath: '/profile/runs/run_1/board.md',
    })
    expect(text).toContain('src/auth.ts')
    expect(text).toContain('/profile/runs/run_1/board.md')
    expect(text).toContain('implement login')
  })

  it('does not mention an orchestrator TUI in the worker bootstrap', () => {
    const text = buildRunBootstrapInput({
      runId: 'run_1',
      prompt: 'implement login',
      agent: 'gemini',
      role: 'worker',
    })
    expect(text.toLowerCase()).not.toContain('freebuff')
    expect(text).toContain('worker (Gemini)')
  })

  it('points at the context hub without dumping a transcript', () => {
    const text = buildRunBootstrapInput({
      runId: 'run_1',
      prompt: 'implement login',
      agent: 'codex',
      role: 'worker',
      contextDir: '/profile/runs/run_1/context',
    })
    expect(text).toContain('/profile/runs/run_1/context')
    expect(text).toContain('manifest.json')
    expect(text).not.toContain('context capsule')
    expect(text.length).toBeLessThan(2000)
  })
})

describe('buildSpecTaskBootstrap', () => {
  it('points at the project-relative board, graphify and sibling ownership', () => {
    const text = buildSpecTaskBootstrap({
      runId: 'run_1',
      task: { id: 't1', title: 'API', prompt: 'add login route', files: ['server/'], agent: 'claude' },
      siblings: [
        { id: 't1', title: 'API', files: ['server/'], agent: 'claude' },
        { id: 't2', title: 'Web', files: ['web/'], agent: 'codex' },
      ],
      boardPath: '.flashwork/runs/run_1/board.md',
    })
    expect(text).toContain('.flashwork/runs/run_1/board.md (path relative to the project root)')
    expect(text).toContain('graphify query')
    expect(text).toContain('Do not redo sibling tasks')
    expect(text).toContain('- server/')
    expect(text).toContain('- t2 · Web · Codex · web/')
    expect(text).not.toContain('- t1 · API')
    expect(text.trim().endsWith('add login route')).toBe(true)
  })
})
