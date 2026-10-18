import type { MessageKey } from './i18n'
import type { FeatureId } from './types'

export type FeatureDefinition = {
  id: FeatureId
  titleKey: MessageKey
  descriptionKey: MessageKey
}

export const FEATURES: readonly FeatureDefinition[] = [
  {
    id: 'git',
    titleKey: 'features.git.title',
    descriptionKey: 'features.git.description',
  },
  {
    id: 'mcp',
    titleKey: 'features.mcp.title',
    descriptionKey: 'features.mcp.description',
  },
]

type StoredFeaturePreferences = {
  // Older files may still carry removed feature ids (todos, browser, aiMemory, canvasFlows,
  // taskBoard, graphify — Graphify is now always on for every project folder).
  enabledFeatures?: Partial<Record<string, boolean>>
  showGitControl?: boolean
}

/** Builds the feature map from persisted preferences, dropping ids of removed features. */
export function normalizeEnabledFeatures(
  raw: StoredFeaturePreferences | undefined,
): Record<FeatureId, boolean> {
  if (raw?.enabledFeatures) {
    return {
      git: raw.enabledFeatures.git ?? true,
      mcp: raw.enabledFeatures.mcp ?? true,
    }
  }
  return {
    git: raw?.showGitControl ?? true,
    mcp: true,
  }
}
