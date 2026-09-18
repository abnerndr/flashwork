import { describe, expect, it } from 'vitest'

import {
  MODEL_CATALOG,
  type ModelEntry,
  type ProviderId,
  pickRouterModel,
} from './modelCatalog'

const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'google']

describe('MODEL_CATALOG', () => {
  it('lists every supported provider', () => {
    expect(Object.keys(MODEL_CATALOG).sort()).toEqual([...PROVIDER_IDS].sort())
  })

  it.each(PROVIDER_IDS)('%s has at least one router and one coding model', (provider) => {
    const models = MODEL_CATALOG[provider]
    expect(models.length).toBeGreaterThan(0)
    expect(models.some((m) => m.role === 'router')).toBe(true)
    expect(models.some((m) => m.role === 'coding')).toBe(true)
  })

  it.each(PROVIDER_IDS)('%s entries have id, label, and role', (provider) => {
    for (const entry of MODEL_CATALOG[provider]) {
      expect(entry.id).toEqual(expect.any(String))
      expect(entry.id.length).toBeGreaterThan(0)
      expect(entry.label).toEqual(expect.any(String))
      expect(entry.label.length).toBeGreaterThan(0)
      expect(['router', 'coding', 'ui']).toContain(entry.role)
    }
  })
})

describe('pickRouterModel', () => {
  it.each(PROVIDER_IDS)('returns a router model id for %s without throwing', (provider) => {
    expect(() => pickRouterModel(provider)).not.toThrow()
    const id = pickRouterModel(provider)
    expect(typeof id).toBe('string')
    expect(id.length).toBeGreaterThan(0)

    const routerEntry = MODEL_CATALOG[provider].find((m: ModelEntry) => m.role === 'router')
    if (routerEntry) {
      expect(id).toBe(routerEntry.id)
    }
  })
})
