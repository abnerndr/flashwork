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
    expect(text).toContain('Worker Gemini')
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
    expect(text).toContain('Board (project-relative): .flashwork/runs/run_1/board.md')
    expect(text).toContain('graphify query')
    expect(text).toContain('do not redo siblings')
    expect(text).toContain('Own files only: server/')
    expect(text).toContain('- t2 · Web · Codex · web/')
    expect(text).not.toContain('- t1 · API')
    expect(text.trim().endsWith('add login route')).toBe(true)
  })

  it('caps inlined siblings and points the rest at the board', () => {
    const siblings = Array.from({ length: 9 }, (_, index) => ({
      id: `t${index + 1}`,
      title: `Task ${index + 1}`,
      files: [`area${index + 1}/`],
      agent: 'claude' as const,
    }))
    const text = buildSpecTaskBootstrap({
      runId: 'run_1',
      task: siblings[0]!,
      siblings,
      boardPath: '.flashwork/runs/run_1/board.md',
    })
    expect(text).toContain('- t2 · Task 2 · Claude Code · area2/')
    expect(text).toContain('- t7 · Task 7 · Claude Code · area7/')
    expect(text).not.toContain('- t8 · Task 8')
    expect(text).toContain('+2 more on the board')
    expect(text.length).toBeLessThan(1600)
  })
})
