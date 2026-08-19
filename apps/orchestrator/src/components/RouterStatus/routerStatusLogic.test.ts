import { describe, expect, it, vi } from 'vitest'

import { OMNIROUTE_DEFAULT_BASE } from '../../lib/flashwork/omniroute'
import {
  gatewayKeyPlaceholder,
  generateOmniRoutePassword,
  needsOmniRouteNode,
  normalizeOmniRouteBaseUrl,
  omniRouteDashboardUrl,
  openOmniRouteDashboard,
  shouldShowPortBusy,
} from './routerStatusLogic'

describe('normalizeOmniRouteBaseUrl', () => {
  it('keeps loopback and strips a trailing slash', () => {
    expect(normalizeOmniRouteBaseUrl('http://127.0.0.1:20128/')).toBe(OMNIROUTE_DEFAULT_BASE)
  })

  it('rewrites localhost to 127.0.0.1', () => {
    expect(normalizeOmniRouteBaseUrl('http://localhost:20128')).toBe('http://127.0.0.1:20128')
    expect(normalizeOmniRouteBaseUrl('http://LOCALHOST:9')).toBe('http://127.0.0.1:9')
  })

  it('falls back to the default when empty', () => {
    expect(normalizeOmniRouteBaseUrl('   ')).toBe(OMNIROUTE_DEFAULT_BASE)
  })
})

describe('omniRouteDashboardUrl', () => {
  it('appends /dashboard to the normalized base', () => {
    expect(omniRouteDashboardUrl('http://127.0.0.1:20128/')).toBe(
      'http://127.0.0.1:20128/dashboard',
    )
  })
})

describe('generateOmniRoutePassword', () => {
  it('encodes 16 bytes as 32 hex characters', () => {
    const bytes = new Uint8Array(16).fill(0xab)
    expect(generateOmniRoutePassword(bytes)).toBe('ab'.repeat(16))
  })
})

describe('needsOmniRouteNode', () => {
  it('asks for Node only when 9router is missing and npm is absent', () => {
    expect(needsOmniRouteNode({ npm: false }, false)).toBe(true)
    expect(needsOmniRouteNode(null, false)).toBe(true)
    expect(needsOmniRouteNode({ npm: true }, false)).toBe(false)
    expect(needsOmniRouteNode({ npm: false }, true)).toBe(false)
  })
})

describe('gatewayKeyPlaceholder', () => {
  it('never echoes a stored key', () => {
    expect(gatewayKeyPlaceholder(true)).toBe('••••')
    expect(gatewayKeyPlaceholder(false)).toBe('')
  })
})

describe('shouldShowPortBusy', () => {
  it('warns only when health is ok and start attached to a live listener', () => {
    expect(shouldShowPortBusy(true, true)).toBe(true)
    expect(shouldShowPortBusy(true, false)).toBe(false)
    expect(shouldShowPortBusy(false, true)).toBe(false)
  })
})

describe('openOmniRouteDashboard', () => {
  it('opens a web pane on the active project without creating one', async () => {
    const createWebPane = vi.fn()
    const openInBrowser = vi.fn()
    await expect(
      openOmniRouteDashboard({
        baseUrl: OMNIROUTE_DEFAULT_BASE,
        projectId: 'proj-1',
        paneName: 'OmniRoute',
        createWebPane,
        openInBrowser,
      }),
    ).resolves.toBe('pane')
    expect(createWebPane).toHaveBeenCalledWith('proj-1', {
      url: 'http://127.0.0.1:20128/dashboard',
      name: 'OmniRoute',
    })
    expect(openInBrowser).not.toHaveBeenCalled()
  })

  it('falls back to the system browser when no project is active', async () => {
    const createWebPane = vi.fn()
    const openInBrowser = vi.fn().mockResolvedValue(undefined)
    await expect(
      openOmniRouteDashboard({
        baseUrl: OMNIROUTE_DEFAULT_BASE,
        projectId: null,
        paneName: 'OmniRoute',
        createWebPane,
        openInBrowser,
      }),
    ).resolves.toBe('browser')
    expect(createWebPane).not.toHaveBeenCalled()
    expect(openInBrowser).toHaveBeenCalledWith('http://127.0.0.1:20128/dashboard')
  })
})
