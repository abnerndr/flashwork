import type { ModelEntry } from '../providers/modelCatalog'

/** Two or more of these, in a SPEC long enough to be real work, selects the coder model. */
const IMPLEMENTATION_SIGNAL =
  /\b(implement(?:ation|ing)?|refactor(?:ing)?|migrat(?:e|ion)|unit tests?|fix(?:es|ing)? (?:the |a )?(?:bug|regression)|write (?:the |a )?(?:code|tests?)|add (?:a |an |the )?(?:feature|endpoint|tests?))\b/gi

const MIN_HEAVY_SPEC_CHARS = 120

let deepseekPlannerUnavailable = false

/** A failed DeepSeek plan stays skipped until the app process restarts. */
export function markDeepseekPlannerUnavailable(): void {
  deepseekPlannerUnavailable = true
}

export function isDeepseekPlannerUnavailable(): boolean {
  return deepseekPlannerUnavailable
}

/** Test-only. Production availability resets when the process restarts. */
export function resetDeepseekPlannerAvailability(): void {
  deepseekPlannerUnavailable = false
}

/**
 * True when the SPEC is clearly coding work. A single mention of "implement"
 * in a review note stays on the cheap planner model.
 */
export function isImplementationHeavySpec(spec: string): boolean {
  const text = spec.trim()
  if (text.length < MIN_HEAVY_SPEC_CHARS) return false
  return (text.match(IMPLEMENTATION_SIGNAL)?.length ?? 0) >= 2
}

/** Router model by default; coder-class model only for an implementation-heavy SPEC. */
export function pickDeepseekPlannerModel(spec: string, models: readonly ModelEntry[]): string {
  const router = models.find((model) => model.role === 'router')?.id ?? models[0]?.id ?? 'deepseek-flash'
  if (!isImplementationHeavySpec(spec)) return router
  return models.find((model) => model.role === 'coding')?.id ?? router
}
