export type FlowHttpPolicy = {
  allowLoopback: boolean
  allowlistHosts: string[]
  confirmedHosts: string[]
}

const LOOPBACK_HOST = '127.0.0.1'

function hostAllowed(host: string, list: string[]): boolean {
  const normalized = host.trim().toLowerCase()
  return list.some((item) => item.trim().toLowerCase() === normalized)
}

export function assertFlowHttpUrl(raw: string, policy: FlowHttpPolicy): URL {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error('url_invalid')
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (scheme !== 'https' && scheme !== 'http') {
    throw new Error('url_scheme')
  }
  const host = parsed.hostname.toLowerCase()
  if (!host) throw new Error('url_host')
  if (scheme === 'http') {
    if (host === LOOPBACK_HOST) {
      if (!policy.allowLoopback) throw new Error('url_loopback_denied')
    } else if (!hostAllowed(host, policy.allowlistHosts)) {
      throw new Error('url_not_allowlisted')
    }
  }
  if (!hostAllowed(host, policy.confirmedHosts)) {
    throw new Error('url_unconfirmed')
  }
  return parsed
}

export function defaultHttpBody(explicit: unknown, input: string): string {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit
  return JSON.stringify({ text: input })
}

export function flowHttpHosts(urls: string[]): string[] {
  const hosts: string[] = []
  for (const raw of urls) {
    try {
      const parsed = new URL(raw)
      const host = parsed.hostname.toLowerCase()
      if (host && !hosts.includes(host)) hosts.push(host)
    } catch {
      /* skip malformed — the request path still validates */
    }
  }
  return hosts
}
