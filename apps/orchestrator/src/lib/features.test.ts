import { describe, expect, it } from 'vitest'

import { normalizeEnabledFeatures } from './features'

describe('normalizeEnabledFeatures', () => {
  it('enables the initial modules for a fresh profile', () => {
    expect(normalizeEnabledFeatures(undefined)).toEqual({
      git: true,
      mcp: true,
    })
  })

  it('preserves legacy Git visibility', () => {
    expect(normalizeEnabledFeatures({ showGitControl: false })).toEqual({
      git: false,
      mcp: true,
    })
  })

  it('preserves explicit modular preferences', () => {
    expect(normalizeEnabledFeatures({ enabledFeatures: { git: false, mcp: false } })).toEqual({
      git: false,
      mcp: false,
    })
  })

  it('drops ids of removed features', () => {
    const features = normalizeEnabledFeatures({
      enabledFeatures: {
        todos: true,
        browser: true,
        aiMemory: true,
        canvasFlows: true,
        taskBoard: true,
        graphify: false,
      },
    })
    expect(Object.keys(features).sort()).toEqual(['git', 'mcp'])
  })
})
