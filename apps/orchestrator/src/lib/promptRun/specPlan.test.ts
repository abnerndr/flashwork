import { describe, expect, it } from 'vitest'

import type { SpecTask } from '../types'
import {
  MAX_SPEC_TASKS,
  buildSpecPlannerPrompt,
  filesOverlap,
  heuristicSpecTasks,
  normalizeSpecTasks,
  parseSpecPlan,
  projectBoardRelativePath,
  readySpecTasks,
  removeSpecTask,
  renderSpecBoard,
  specRunSettled,
  type SpecPlanContext,
} from './specPlan'

const ctx = (installed: SpecPlanContext['installedAgents'] = ['claude', 'codex']): SpecPlanContext => ({
  spec: 'Add login to the API, the web app and the docs',
  enabledAgents: installed,
  installedAgents: installed,
  claudeFiveHourUtilization: null,
  codexRateLimited: false,
})

const task = (overrides: Partial<SpecTask> & Pick<SpecTask, 'id'>): SpecTask => ({
  title: overrides.id,
  prompt: `do ${overrides.id}`,
  files: [],
  kind: 'implement',
  agent: 'claude',
  dependsOn: [],
  status: 'pending',
  ...overrides,
})

describe('parseSpecPlan', () => {
  it('reads one task per area and keeps installed agents', () => {
    const text = `Some preamble\n${JSON.stringify({
      tasks: [
        { id: 't1', title: 'API', prompt: 'api login', files: ['server/'], kind: 'implement', agent: 'claude' },
        { id: 't2', title: 'Web', prompt: 'web login', files: ['web/'], kind: 'ui', agent: 'codex' },
        { id: 't3', title: 'Docs', prompt: 'docs', files: ['docs/login.md'], kind: 'mechanical', agent: 'codex' },
      ],
    })}`
    const tasks = parseSpecPlan(text, ctx())
    expect(tasks.map((item) => item.id)).toEqual(['t1', 't2', 't3'])
    expect(tasks.map((item) => item.agent)).toEqual(['claude', 'codex', 'codex'])
    expect(tasks.every((item) => item.dependsOn.length === 0)).toBe(true)
    expect(tasks.every((item) => item.status === 'pending')).toBe(true)
  })

  it('falls back to a local pick when the agent is not installed', () => {
    const tasks = parseSpecPlan(
      JSON.stringify({ tasks: [{ id: 'a', title: 'x', prompt: 'implement x', agent: 'opencode', kind: 'implement' }] }),
      ctx(['codex']),
    )
    expect(tasks[0].agent).toBe('codex')
  })

  it('turns shell tasks into plain terminals with their command', () => {
    const tasks = parseSpecPlan(
      JSON.stringify({
        tasks: [{ id: 's', title: 'dev server', prompt: '', shell: true, command: 'npm run dev', files: ['x'] }],
      }),
      ctx(),
    )
    expect(tasks[0]).toMatchObject({ kind: 'shell', agent: 'shell', command: 'npm run dev', files: [] })
  })

  it('returns no tasks for unusable replies', () => {
    expect(parseSpecPlan('I cannot help with that', ctx())).toEqual([])
    expect(parseSpecPlan('{"tasks": "nope"}', ctx())).toEqual([])
    expect(parseSpecPlan('{"tasks":[{"id":"t1"}]}', ctx())).toEqual([])
  })

  it('caps the plan and dedupes ids', () => {
    const rows = Array.from({ length: 12 }, (_, index) => ({
      id: 'same',
      prompt: `p${index}`,
      files: [`area${index}/`],
      agent: 'claude',
    }))
    const tasks = parseSpecPlan(JSON.stringify({ tasks: rows }), ctx())
    expect(tasks).toHaveLength(MAX_SPEC_TASKS)
    expect(new Set(tasks.map((item) => item.id)).size).toBe(MAX_SPEC_TASKS)
  })

  it('drops unknown and self dependencies', () => {
    const tasks = parseSpecPlan(
      JSON.stringify({
        tasks: [
          { id: 't1', prompt: 'a', files: ['a/'], dependsOn: ['t1', 'ghost'] },
          { id: 't2', prompt: 'b', files: ['b/'], dependsOn: ['t1'] },
        ],
      }),
      ctx(),
    )
    expect(tasks[0].dependsOn).toEqual([])
    expect(tasks[1].dependsOn).toEqual(['t1'])
  })
})

describe('normalizeSpecTasks', () => {
  it('serializes writers that claim the same file and drops the shared ownership', () => {
    const tasks = normalizeSpecTasks([
      task({ id: 't1', files: ['src/auth.ts'] }),
      task({ id: 't2', files: ['src/auth.ts', 'src/login.tsx'] }),
      task({ id: 't3', files: ['docs/'] }),
    ])
    expect(tasks[1].dependsOn).toEqual(['t1'])
    expect(tasks[1].files).toEqual(['src/login.tsx'])
    expect(tasks[2].dependsOn).toEqual([])
  })

  it('treats a folder as owning the files inside it', () => {
    expect(filesOverlap(['src/'], ['src/a.ts'])).toBe(true)
    expect(filesOverlap(['./src/a.ts'], ['src\\a.ts'])).toBe(true)
    expect(filesOverlap(['src/a.ts'], ['src/ab.ts'])).toBe(false)
    expect(filesOverlap([], ['x'])).toBe(true)
  })

  it('makes reviews wait for every writer', () => {
    const tasks = normalizeSpecTasks([
      task({ id: 't1', files: ['a/'] }),
      task({ id: 't2', files: ['b/'], kind: 'ui' }),
      task({ id: 'r', kind: 'review' }),
      task({ id: 'e', kind: 'explore' }),
    ])
    expect(tasks.find((item) => item.id === 'r')?.dependsOn.sort()).toEqual(['t1', 't2'])
    expect(tasks.find((item) => item.id === 'e')?.dependsOn).toEqual([])
  })

  it('breaks dependency cycles', () => {
    const tasks = normalizeSpecTasks([
      task({ id: 'a', files: ['a/'], dependsOn: ['b'] }),
      task({ id: 'b', files: ['b/'], dependsOn: ['a'] }),
    ])
    expect(tasks[0].dependsOn).toEqual([])
    expect(tasks[1].dependsOn).toEqual(['a'])
  })
})

describe('scheduling', () => {
  it('releases dependents only after their deps are done', () => {
    const plan = [task({ id: 'a' }), task({ id: 'b', dependsOn: ['a'] })]
    expect(readySpecTasks(plan).map((item) => item.id)).toEqual(['a'])
    const afterA = plan.map((item) => (item.id === 'a' ? { ...item, status: 'done' as const } : item))
    expect(readySpecTasks(afterA).map((item) => item.id)).toEqual(['b'])
  })

  it('settles when the rest is stuck behind a failed task', () => {
    const plan = [
      task({ id: 'a', status: 'failed' }),
      task({ id: 'b', dependsOn: ['a'] }),
      task({ id: 'c', dependsOn: ['b'] }),
    ]
    expect(specRunSettled(plan)).toBe(true)
    expect(specRunSettled([task({ id: 'a', status: 'running' })])).toBe(false)
  })

  it('removing a task also removes edges that pointed at it', () => {
    const next = removeSpecTask([task({ id: 'a' }), task({ id: 'b', dependsOn: ['a'] })], 'a')
    expect(next).toEqual([task({ id: 'b' })])
  })
})

describe('planner prompt and board', () => {
  it('lists only installed coding CLIs and asks for strict JSON', () => {
    const prompt = buildSpecPlannerPrompt({ spec: '# Login', agents: ['claude', 'codex', 'shell'] })
    expect(prompt).toContain('- claude (Claude Code)')
    expect(prompt).toContain('- codex (Codex)')
    expect(prompt).not.toContain('- shell')
    expect(prompt).toContain('"tasks"')
    expect(prompt).toContain('No two tasks may own the same file')
    expect(prompt).toContain('# Login')
  })

  it('keeps the board inside the project with a relative path', () => {
    expect(projectBoardRelativePath('run_1')).toBe('.flashwork/runs/run_1/board.md')
    const board = renderSpecBoard({
      runId: 'run_1',
      spec: 'Spec body',
      tasks: [task({ id: 't1', files: ['src/'] })],
    })
    expect(board).toContain('Spec body')
    expect(board).toContain('t1 · t1 · Claude Code · implement · pending · files: src/')
    expect(board).toContain('Do not redo a sibling task')
  })
})

describe('heuristicSpecTasks', () => {
  it('produces at least one task from the installed CLIs', () => {
    const tasks = heuristicSpecTasks(ctx(['codex']))
    expect(tasks.length).toBeGreaterThan(0)
    expect(tasks.every((item) => item.agent === 'codex')).toBe(true)
  })

  it('returns nothing when no coding CLI is installed', () => {
    expect(heuristicSpecTasks(ctx([]))).toEqual([])
  })
})
