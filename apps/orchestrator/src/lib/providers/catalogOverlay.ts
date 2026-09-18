/**
 * In-memory overlay for `provider_catalog_refresh` (Task 4).
 *
 * The checked-in `MODEL_CATALOG` snapshot (Task 1) stays the source of
 * truth on disk and the fallback whenever a provider's refresh fails or
 * hasn't run yet. A successful, user-triggered refresh only updates this
 * process-lifetime overlay — it never mutates `MODEL_CATALOG` itself.
 */
import { MODEL_CATALOG, type ModelEntry, type ProviderId } from './modelCatalog'
import type { CatalogModel, CatalogRefreshResult } from '../tauri/providers'

let overlay: Partial<Record<ProviderId, ModelEntry[]>> = {}
/** Session-only; cleared with the overlay on process restart or reset. */
let catalogRefreshedAt: number | null = null

/**
 * Refreshed vendor models don't carry a `role`. When an id already exists in
 * the fallback snapshot, its role is preserved (router/coding pins matter
 * for auto-selection); brand-new ids default to `'coding'`.
 */
function toModelEntries(models: CatalogModel[], fallback: ModelEntry[]): ModelEntry[] {
  return models.map((model) => {
    const known = fallback.find((entry) => entry.id === model.id)
    return { id: model.id, label: model.label, role: known?.role ?? 'coding' }
  })
}

/** Merges a `provider_catalog_refresh` result into the overlay. Providers absent from `result` (per-provider failure) are left untouched. */
export function applyCatalogRefresh(result: CatalogRefreshResult): void {
  for (const providerId of Object.keys(result) as ProviderId[]) {
    const models = result[providerId]
    if (models && models.length > 0) {
      overlay = { ...overlay, [providerId]: toModelEntries(models, MODEL_CATALOG[providerId]) }
    }
  }
}

/** The effective catalog for `provider`: the refreshed overlay if present, otherwise the Task 1 fallback. */
export function getModelCatalog(provider: ProviderId): ModelEntry[] {
  return overlay[provider] ?? MODEL_CATALOG[provider]
}

/** True once at least one provider has a refreshed overlay for this process. */
export function hasCatalogOverlay(): boolean {
  return Object.keys(overlay).length > 0
}

/** Epoch ms of the last successful catalog refresh in this process, or null if none yet. */
export function getCatalogRefreshedAt(): number | null {
  return catalogRefreshedAt
}

/** Records a successful refresh timestamp for the current session overlay. */
export function markCatalogRefreshed(at: number = Date.now()): void {
  catalogRefreshedAt = at
}

/** Test-only: clears the overlay so tests don't leak state across cases. */
export function resetCatalogOverlay(): void {
  overlay = {}
  catalogRefreshedAt = null
}
