import { describe, expect, it } from 'vitest'

import type { SpecTask } from '../types'
import { parseContinueNudges, stalledSpecTasks } from './specContinue'

const task = (overrides: Partial<SpecTask> & Pick<SpecTask, 'id'>): SpecTask => ({
  title: overrides.id,
  prompt: `do ${overrides.id}`,
  files: [],
  kind: 'implement',
  agent: 'claude',
  dependsOn: [],
  status: 'running',
  terminalId: overrides.id,
  ...overrides,
})

describe('stalledSpecTasks', () => {
  it('nudges only when every running lane is idle and work remains', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b', status: 'pending', terminalId: undefined })]
    const now = 50_000
    expect(
      stalledSpecTasks(tasks, { a: { status: 'waiting', lastIoAt: 0 } }, now).map((item) => item.id),
    ).toEqual(['a'])
    expect(
      stalledSpecTasks(tasks, { a: { status: 'working', lastIoAt: 0 } }, now),
    ).toEqual([])
  })

  it('does nothing after the SPEC is finished', () => {
    expect(
      stalledSpecTasks(
        [task({ id: 'a', status: 'done' })],
        { a: { status: 'waiting', lastIoAt: 0 } },
        50_000,
      ),
    ).toEqual([])
  })
})

describe('parseContinueNudges', () => {
  it('reads a message per task and fills a fallback when JSON is missing', () => {
    const tasks = [task({ id: 'a' }), task({ id: 'b' })]
    const parsed = parseContinueNudges(
      'ok {"nudges":[{"id":"a","message":"Finish the login tests."}]}',
      tasks,
    )
    expect(parsed.a).toBe('Finish the login tests.')
    expect(parsed.b.length).toBeGreaterThan(10)
  })
})
