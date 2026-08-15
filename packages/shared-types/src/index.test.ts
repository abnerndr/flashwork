import { describe, expect, it } from 'vitest'

import type { CanvasNodeKind, Floor, PTYMessage, RouterStatus } from './index.js'

describe('@flashwork/shared-types smoke', () => {
  it('defines Floor shape', () => {
    const floor: Floor = {
      id: 'floor-1',
      name: 'MVP',
      worktreePath: '/tmp/flashwork/floor-1',
      branch: 'feat/prd-mvp',
      createdAt: new Date(0).toISOString(),
    }

    expect(floor.id).toBe('floor-1')
    expect(floor.branch).toBe('feat/prd-mvp')
  })

  it('lists canvas node kinds', () => {
    const kinds: CanvasNodeKind[] = [
      'terminal',
      'ide',
      'portal',
      'sticky-note',
      'router-status',
      'floor-container',
    ]
    expect(kinds).toHaveLength(6)
  })

  it('accepts PTYMessage variants', () => {
    const message: PTYMessage = {
      type: 'data',
      sessionId: 'pty-1',
      data: 'hello',
    }
    expect(message.type).toBe('data')
  })

  it('accepts RouterStatus shape', () => {
    const status: RouterStatus = {
      activeProvider: 'openai',
      fallbackActive: false,
      providers: [{ id: 'openai', status: 'healthy', quotaRemaining: 100 }],
      updatedAt: new Date(0).toISOString(),
    }
    expect(status.fallbackActive).toBe(false)
  })
})
