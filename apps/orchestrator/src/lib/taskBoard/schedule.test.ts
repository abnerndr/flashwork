import { describe, expect, it } from 'vitest'

import type { TaskCard } from '../types'
import {
  cardFilesConflict,
  filesOverlap,
  launchableSlices,
  pickNextTaskCard,
  readySlices,
  toCwdRelative,
} from './schedule'

function card(partial: Partial<TaskCard> & Pick<TaskCard, 'id'>): TaskCard {
  return {
    projectId: 'p1',
    cwd: '/tmp/app',
    title: partial.id,
    prompt: 'do it',
    allowedFiles: [],
    priority: 3,
    column: 'todo',
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

describe('filesOverlap', () => {
  it('treats an empty allowlist as a whole-repo lock', () => {
    expect(filesOverlap([], ['src/a.ts'])).toBe(true)
    expect(filesOverlap(['src/a.ts'], [])).toBe(true)
  })

  it('detects overlapping relative paths', () => {
    expect(filesOverlap(['src/a.ts', 'src/b.ts'], ['SRC/B.ts'])).toBe(true)
    expect(filesOverlap(['src/a.ts'], ['src/c.ts'])).toBe(false)
  })
})

describe('toCwdRelative', () => {
  it('strips the project cwd prefix', () => {
    expect(toCwdRelative('/tmp/app', '/tmp/app/src/a.ts')).toBe('src/a.ts')
  })
})

describe('cardFilesConflict', () => {
  it('serializes two empty allowlists in the same cwd', () => {
    expect(cardFilesConflict(card({ id: 'a', allowedFiles: [] }), [card({ id: 'b', allowedFiles: [] })])).toBe(
      true,
    )
  })

  it('allows disjoint files in the same cwd', () => {
    expect(
      cardFilesConflict(card({ id: 'a', allowedFiles: ['src/a.ts'] }), [
        card({ id: 'b', allowedFiles: ['src/b.ts'] }),
      ]),
    ).toBe(false)
  })
})

describe('pickNextTaskCard', () => {
  it('picks the lowest priority first', () => {
    const next = pickNextTaskCard(
      [
        card({ id: 'late', priority: 5, createdAt: 1 }),
        card({ id: 'soon', priority: 1, createdAt: 2 }),
      ],
      new Set(),
    )
    expect(next?.id).toBe('soon')
  })

  it('skips a project that already has a blocking run', () => {
    expect(
      pickNextTaskCard([card({ id: 'queued', projectId: 'p1' })], new Set(['p1'])),
    ).toBeNull()
  })

  it('waits when allowed files overlap a card already doing work', () => {
    const next = pickNextTaskCard(
      [
        card({ id: 'busy', column: 'doing', allowedFiles: ['src/a.ts'] }),
        card({ id: 'queued', allowedFiles: ['src/a.ts'], priority: 1 }),
      ],
      new Set(),
    )
    expect(next).toBeNull()
  })
})

describe('readySlices', () => {
  it('holds a dependent slice until the parent is done', () => {
    const ready = readySlices([
      {
        id: 'impl',
        kind: 'implement',
        agent: 'claude',
        prompt: 'impl',
        dependsOn: [],
        allowedFiles: [],
        status: 'done',
      },
      {
        id: 'review',
        kind: 'review',
        agent: 'gemini',
        prompt: 'review',
        dependsOn: ['impl'],
        allowedFiles: [],
        status: 'pending',
      },
    ])
    expect(ready.map((slice) => slice.id)).toEqual(['review'])
  })
})

describe('launchableSlices', () => {
  it('never falls back to launching dependent slices just because none are ready', () => {
    const launched = launchableSlices([
      {
        id: 'impl',
        kind: 'implement',
        agent: 'claude',
        prompt: 'impl',
        dependsOn: [],
        allowedFiles: [],
        status: 'running',
      },
      {
        id: 'review',
        kind: 'review',
        agent: 'gemini',
        prompt: 'review',
        dependsOn: ['impl'],
        allowedFiles: [],
        status: 'pending',
      },
    ])
    expect(launched).toEqual([])
  })
})
