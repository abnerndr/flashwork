/** OmniRoute local gateway helpers (Flashwork PRD — optional sidecar). */

export const OMNIROUTE_DEFAULT_BASE = 'http://127.0.0.1:20128'

export type OmniRouteHealth = {
  ok: boolean
  baseUrl: string
  statusCode?: number
  detail: string
  checkedAt: number
}

export async function checkOmniRouteHealth(
  baseUrl: string = OMNIROUTE_DEFAULT_BASE,
): Promise<OmniRouteHealth> {
  const checkedAt = Date.now()
  const url = `${baseUrl.replace(/\/$/, '')}/`
  try {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 2500)
    const response = await fetch(url, {
      method: 'GET',
      signal: controller.signal,
      mode: 'cors',
    })
    window.clearTimeout(timer)
    return {
      ok: response.ok || response.status < 500,
      baseUrl,
      statusCode: response.status,
      detail: response.ok ? 'Gateway reachable' : `HTTP ${response.status}`,
      checkedAt,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const offline =
      message.includes('Failed to fetch') ||
      message.includes('NetworkError') ||
      message.includes('aborted')
    return {
      ok: false,
      baseUrl,
      detail: offline ? 'Offline — start OmniRoute sidecar on 127.0.0.1:20128' : message,
      checkedAt,
    }
  }
}

/** Env hints for agent CLIs pointed at the local gateway. */
export function omniRouteAgentEnv(baseUrl: string = OMNIROUTE_DEFAULT_BASE): Record<string, string> {
  const root = (baseUrl || OMNIROUTE_DEFAULT_BASE)
    .replace(/localhost/gi, '127.0.0.1')
    .replace(/\/$/, '')
  return {
    ANTHROPIC_BASE_URL: `${root}/v1`,
    OPENAI_BASE_URL: `${root}/v1`,
    FLASHWORK_OMNIROUTE_URL: root,
  }
}

export type OmniRouteSpawnOptions = {
  enabled: boolean
  healthy: boolean
  apiKey: string | null
  baseUrl?: string
}

export function withOmniRouteEnv(
  base: Record<string, string> | undefined,
  options: OmniRouteSpawnOptions,
): Record<string, string> | undefined {
  const merged = { ...(base ?? {}) }
  if (!options.enabled || !options.healthy || !options.apiKey) {
    return base === undefined ? undefined : merged
  }
  Object.assign(merged, omniRouteAgentEnv(options.baseUrl), {
    ANTHROPIC_API_KEY: options.apiKey,
    ANTHROPIC_AUTH_TOKEN: options.apiKey,
    OPENAI_API_KEY: options.apiKey,
  })
  return merged
}
