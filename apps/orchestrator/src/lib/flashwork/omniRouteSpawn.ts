import { omnirouteGetGatewayKey } from '../tauri/omnirouteSidecar'
import { checkOmniRouteHealth, OMNIROUTE_DEFAULT_BASE, withOmniRouteEnv } from './omniroute'

export type OmniRouteSpawnPrefs = {
  omniRouteEnabled?: boolean
  omniRouteBaseUrl?: string
}

/**
 * Prefs are passed in to avoid an import cycle with projectsStore.
 * Gateway env is applied only when opted in, healthy, and keyed; spawn is never blocked.
 */
export async function resolveOmniRouteSpawnEnv(
  base?: Record<string, string>,
  prefs?: OmniRouteSpawnPrefs,
): Promise<Record<string, string> | undefined> {
  if (!prefs?.omniRouteEnabled) {
    return withOmniRouteEnv(base, {
      enabled: false,
      healthy: false,
      apiKey: null,
    })
  }
  const baseUrl = prefs.omniRouteBaseUrl || OMNIROUTE_DEFAULT_BASE
  try {
    const [health, apiKey] = await Promise.all([
      checkOmniRouteHealth(baseUrl),
      omnirouteGetGatewayKey().catch(() => null),
    ])
    return withOmniRouteEnv(base, {
      enabled: true,
      healthy: health.ok,
      apiKey,
      baseUrl,
    })
  } catch {
    return withOmniRouteEnv(base, {
      enabled: true,
      healthy: false,
      apiKey: null,
    })
  }
}
