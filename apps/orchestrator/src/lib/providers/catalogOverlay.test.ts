import { afterEach, describe, expect, it } from 'vitest'

import { MODEL_CATALOG } from './modelCatalog'
import {
  applyCatalogRefresh,
  getModelCatalog,
  hasCatalogOverlay,
  resetCatalogOverlay,
} from './catalogOverlay'

afterEach(() => {
  resetCatalogOverlay()
})

describe('catalogOverlay', () => {
  it('falls back to MODEL_CATALOG when nothing has been refreshed yet', () => {
    expect(hasCatalogOverlay()).toBe(false)
    expect(getModelCatalog('anthropic')).toBe(MODEL_CATALOG.anthropic)
  })

  it('overlays a successful refresh without mutating MODEL_CATALOG', () => {
    const before = MODEL_CATALOG.openai.map((entry) => ({ ...entry }))

    applyCatalogRefresh({
      openai: [
        { id: 'gpt-5', label: 'GPT-5 (refreshed)' },
        { id: 'gpt-6-preview', label: 'GPT-6 preview' },
      ],
    })

    expect(hasCatalogOverlay()).toBe(true)
    expect(MODEL_CATALOG.openai).toEqual(before)

    const overlaid = getModelCatalog('openai')
    expect(overlaid).toHaveLength(2)
    expect(overlaid.find((m) => m.id === 'gpt-6-preview')?.label).toBe('GPT-6 preview')
  })

  it('preserves the known role for an id that already existed in the fallback', () => {
    const routerId = MODEL_CATALOG.google.find((m) => m.role === 'router')?.id
    expect(routerId).toBeTruthy()

    applyCatalogRefresh({
      google: [{ id: routerId as string, label: 'Refreshed label' }],
    })

    const refreshed = getModelCatalog('google').find((m) => m.id === routerId)
    expect(refreshed?.role).toBe('router')
    expect(refreshed?.label).toBe('Refreshed label')
  })

  it('defaults a brand-new (never-seen) id to the coding role', () => {
    applyCatalogRefresh({ anthropic: [{ id: 'claude-new-model', label: 'New model' }] })

    const refreshed = getModelCatalog('anthropic').find((m) => m.id === 'claude-new-model')
    expect(refreshed?.role).toBe('coding')
  })

  it('leaves other providers untouched when only one provider succeeds', () => {
    applyCatalogRefresh({ anthropic: [{ id: 'claude-x', label: 'X' }] })

    expect(getModelCatalog('openai')).toBe(MODEL_CATALOG.openai)
    expect(getModelCatalog('google')).toBe(MODEL_CATALOG.google)
  })

  it('ignores an empty models array for a provider (kept as per-provider failure)', () => {
    applyCatalogRefresh({ anthropic: [] })
    expect(getModelCatalog('anthropic')).toBe(MODEL_CATALOG.anthropic)
  })
})
