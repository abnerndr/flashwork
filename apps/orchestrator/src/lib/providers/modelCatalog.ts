export type ProviderId = 'anthropic' | 'openai' | 'google'

export type ModelEntry = {
  id: string
  label: string
  role: 'router' | 'coding' | 'ui'
}

/** Dated 2026-09 snapshot; ids may be updated in-place when vendors rename models. */
export const MODEL_CATALOG: Record<ProviderId, ModelEntry[]> = {
  anthropic: [
    { id: 'claude-haiku-4-5-20251001', label: 'Haiku', role: 'router' },
    { id: 'claude-sonnet-4-5-20250929', label: 'Sonnet', role: 'coding' },
    { id: 'claude-opus-4-1-20250805', label: 'Opus', role: 'coding' },
  ],
  openai: [
    { id: 'gpt-5-mini', label: 'GPT-5 mini', role: 'router' },
    { id: 'gpt-5', label: 'GPT-5', role: 'coding' },
  ],
  google: [
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', role: 'router' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', role: 'coding' },
  ],
}

/** Pure selector: the `router`-role entry in `models`, or its first entry as a fallback. */
export function pickRouterModelFrom(models: ModelEntry[]): string {
  return models.find((m) => m.role === 'router')?.id ?? models[0].id
}

/** Router model id from the checked-in Task 1 snapshot only (ignores any catalog overlay). */
export function pickRouterModel(provider: ProviderId): string {
  return pickRouterModelFrom(MODEL_CATALOG[provider])
}
