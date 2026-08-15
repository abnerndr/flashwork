import { describe, expect, it } from 'vitest'

import {
  CanvasNodeKindSchema,
  FloorSchema,
  PTYMessageSchema,
  RouterStatusSchema,
  type CanvasNodeKind,
  type Floor,
  type PTYMessage,
  type RouterStatus,
} from './index.js'

describe('@flashwork/shared-types smoke', () => {
  it('defines Floor shape', () => {
    const floor: Floor = {
      id: 'floor-1',
      name: 'MVP',
      worktreePath: '/tmp/flashwork/floor-1',
      branch: 'feat/prd-mvp',
      createdAt: new Date(0).toISOString(),
    }

    expect(FloorSchema.parse(floor).id).toBe('floor-1')
    expect(floor.branch).toBe('feat/prd-mvp')
  })

  it('lists canvas node kinds', () => {
    const kinds: CanvasNodeKind[] = [
      'terminal',
      'ide',
      'portal',
      'sticky',
      'routerStatus',
      'floorContainer',
    ]
    expect(kinds).toHaveLength(6)
    expect(CanvasNodeKindSchema.options).toEqual(kinds)
  })

  it('accepts PTYMessage variants', () => {
    const message: PTYMessage = {
      type: 'data',
      sessionId: 'pty-1',
      data: 'hello',
    }
    expect(PTYMessageSchema.parse(message).type).toBe('data')
  })

  it('accepts RouterStatus shape', () => {
    const status: RouterStatus = {
      provider: 'openai',
      fallbackActive: false,
      quotaRemaining: 100,
    }
    expect(RouterStatusSchema.parse(status).fallbackActive).toBe(false)
  })
})
