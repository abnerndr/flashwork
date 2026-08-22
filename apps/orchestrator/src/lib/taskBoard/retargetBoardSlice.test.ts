import { describe, expect, it } from 'vitest'

import type { TaskSlicePlan } from '../types'
import { boardCardSettled, failSlicePlan, retargetSlicePlan } from './retargetBoardSlice'

function slice(partial: Partial<TaskSlicePlan> & Pick<TaskSlicePlan, 'id' | 'terminalId'>): TaskSlicePlan {
  return {
    kind: 'implement',
    agent: 'gemini',
    prompt: 'do it',
    dependsOn: [],
    allowedFiles: [],
    status: 'running',
    ...partial,
  }
}

describe('retargetSlicePlan', () => {
  it('moves a failed slice onto the replacement agent and pane', () => {
    const next = retargetSlicePlan(
      [
        slice({ id: 'a', terminalId: 'term-gemini', agent: 'gemini' }),
        slice({ id: 'b', terminalId: 'term-claude', agent: 'claude' }),
      ],
      'term-gemini',
      { agent: 'claude', terminalId: 'term-claude-2' },
    )
    expect(next[0]).toMatchObject({
      id: 'a',
      agent: 'claude',
      terminalId: 'term-claude-2',
      status: 'running',
    })
    expect(next[1]?.terminalId).toBe('term-claude')
  })

  it('marks only the failed pane so siblings can keep their own slice', () => {
    const next = failSlicePlan(
      [
        slice({ id: 'a', terminalId: 'term-gemini', agent: 'gemini' }),
        slice({ id: 'b', terminalId: 'term-claude', agent: 'claude' }),
      ],
      'term-gemini',
    )
    expect(next[0]?.status).toBe('failed')
    expect(next[1]?.status).toBe('running')
    expect(boardCardSettled(next)).toBe(false)
  })
})
