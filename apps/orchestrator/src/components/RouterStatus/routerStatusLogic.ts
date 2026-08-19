import { OMNIROUTE_DEFAULT_BASE } from '../../lib/flashwork/omniroute'

export function normalizeOmniRouteBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/localhost/gi, '127.0.0.1').replace(/\/+$/, '')
  return trimmed || OMNIROUTE_DEFAULT_BASE
}

export function omniRouteDashboardUrl(baseUrl: string): string {
  return `${normalizeOmniRouteBaseUrl(baseUrl)}/dashboard`
}

export function generateOmniRoutePassword(
  bytes: Uint8Array = crypto.getRandomValues(new Uint8Array(16)),
): string {
  const entropy = bytes.length >= 16 ? bytes.slice(0, 16) : bytes
  return Array.from(entropy, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export function needsOmniRouteNode(
  toolchain: { npm: boolean } | null,
  installed: boolean,
): boolean {
  return !installed && !toolchain?.npm
}

export function gatewayKeyPlaceholder(hasStoredKey: boolean): string {
  return hasStoredKey ? '••••' : ''
}

export function shouldShowPortBusy(healthOk: boolean, alreadyRunning: boolean): boolean {
  return healthOk && alreadyRunning
}

export async function openOmniRouteDashboard(opts: {
  baseUrl: string
  projectId: string | null
  paneName: string
  createWebPane: (projectId: string, args: { url: string; name?: string }) => void
  openInBrowser: (url: string) => Promise<void>
}): Promise<'pane' | 'browser'> {
  const url = omniRouteDashboardUrl(opts.baseUrl)
  if (opts.projectId) {
    opts.createWebPane(opts.projectId, { url, name: opts.paneName })
    return 'pane'
  }
  await opts.openInBrowser(url)
  return 'browser'
}
