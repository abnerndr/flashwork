/**
 * In-memory overlay for `provider_catalog_refresh` (Task 4).
 *
 * The checked-in `MODEL_CATALOG` snapshot (Task 1) stays the source of
 * truth on disk and the fallback whenever a provider's refresh fails or
 * hasn't run yet. A successful, user-triggered refresh only updates this
 * process-lifetime overlay — it never mutates `MODEL_CATALOG` itself.
 */
import { MODEL_CATALOG, type ModelEntry, type ProviderId, pickRouterModelFrom } from './modelCatalog'
import type { CatalogModel, CatalogRefreshResult } from '../tauri/providers'

let overlay: Partial<Record<ProviderId, ModelEntry[]>> = {}
/** Session-only; cleared with the overlay on process restart or reset. */
let catalogRefreshedAt: number | null = null

/**
 * Merges a vendor's models-list response into the checked-in Task 1 snapshot for one provider.
 * Every snapshot entry is kept (even if the vendor response omits it — e.g. a router pin the
 * vendor's `/v1/models` didn't return), so the snapshot's `router`/`coding` pins survive a
 * refresh. Vendor ids that already exist in the snapshot only get their `label` refreshed, never
 * their `role`. Brand-new vendor ids (including non-chat ones like embeddings/tts — vendor
 * models-list endpoints aren't filtered by capability) are appended with a default `'coding'`
 * role, which is safe precisely because the snapshot's `router` entry is never dropped.
 */
function mergeModels(vendorModels: CatalogModel[], snapshot: ModelEntry[]): ModelEntry[] {
  const merged = snapshot.map((entry) => ({ ...entry }))
  for (const vendorModel of vendorModels) {
    const known = merged.find((entry) => entry.id === vendorModel.id)
    if (known) {
      known.label = vendorModel.label
    } else {
      merged.push({ id: vendorModel.id, label: vendorModel.label, role: 'coding' })
    }
  }
  return merged
}

/**
 * Merges a `provider_catalog_refresh` result into the overlay, one provider at a time. Providers
 * absent from `result` (per-provider failure) — or the whole call failing before this is even
 * called — are left untouched, so `getModelCatalog` keeps serving the last-known-good overlay or
 * the Task 1 snapshot for them.
 */
export function applyCatalogRefresh(result: CatalogRefreshResult): void {
  for (const providerId of Object.keys(result) as ProviderId[]) {
    const models = result[providerId]
    if (models && models.length > 0) {
      overlay = { ...overlay, [providerId]: mergeModels(models, MODEL_CATALOG[providerId]) }
    }
  }
}

/** The effective catalog for `provider`: the refreshed overlay if present, otherwise the Task 1 fallback. */
export function getModelCatalog(provider: ProviderId): ModelEntry[] {
  return overlay[provider] ?? MODEL_CATALOG[provider]
}

/**
 * Router model id for `provider` using the effective catalog (overlay when present, otherwise
 * the Task 1 snapshot). Production pickers (e.g. P07/Auto model selection) must import this —
 * not `pickRouterModel` from `./modelCatalog`, which only ever sees the static snapshot.
 */
export function pickEffectiveRouterModel(provider: ProviderId): string {
  return pickRouterModelFrom(getModelCatalog(provider))
}

/** Coding model id for `provider` using the effective catalog (first `coding` role, else `[0]`). */
export function pickEffectiveCodingModel(provider: ProviderId): string {
  const models = getModelCatalog(provider)
  return models.find((m) => m.role === 'coding')?.id ?? models[0].id
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
