import { beforeEach, describe, expect, it, vi } from 'vitest'

import { omnirouteHealth } from '../tauri/omnirouteSidecar'
import {
  checkOmniRouteHealth,
  OMNIROUTE_DEFAULT_BASE,
  omniRouteAgentEnv,
  withOmniRouteEnv,
} from './omniroute'

vi.mock('../tauri/omnirouteSidecar', () => ({
  omnirouteHealth: vi.fn(),
}))

const probe = vi.mocked(omnirouteHealth)

describe('omniRouteAgentEnv', () => {
  it('always uses IPv4 loopback', () => {
    expect(OMNIROUTE_DEFAULT_BASE).toBe('http://127.0.0.1:20128')
    const env = omniRouteAgentEnv()
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:20128/v1')
    expect(env.OPENAI_BASE_URL).toBe('http://127.0.0.1:20128/v1')
    expect(env.FLASHWORK_OMNIROUTE_URL).toBe('http://127.0.0.1:20128')
    expect(JSON.stringify(env).includes('localhost')).toBe(false)
  })
})

describe('withOmniRouteEnv', () => {
  it('returns the base env when the gateway is off', () => {
    expect(withOmniRouteEnv({ FOO: '1' }, { enabled: false, healthy: true, apiKey: 'k' })).toEqual({
      FOO: '1',
    })
  })

  it('returns the base env when unhealthy or missing key', () => {
    expect(withOmniRouteEnv({}, { enabled: true, healthy: false, apiKey: 'k' })).toEqual({})
    expect(withOmniRouteEnv({}, { enabled: true, healthy: true, apiKey: null })).toEqual({})
  })

  it('merges gateway URLs and the dashboard key when opted in', () => {
    const env = withOmniRouteEnv(
      { FOO: '1' },
      { enabled: true, healthy: true, apiKey: 'gw-key' },
    )
    expect(env.FOO).toBe('1')
    expect(env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:20128/v1')
    expect(env.ANTHROPIC_API_KEY).toBe('gw-key')
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('gw-key')
    expect(env.OPENAI_API_KEY).toBe('gw-key')
  })
})

describe('checkOmniRouteHealth', () => {
  beforeEach(() => {
    probe.mockReset()
  })

  it('uses the Tauri/reqwest probe instead of renderer fetch', async () => {
    probe.mockResolvedValue({
      ok: true,
      baseUrl: OMNIROUTE_DEFAULT_BASE,
      statusCode: 200,
      detail: 'Gateway reachable',
      checkedAt: 1,
    })
    await expect(checkOmniRouteHealth()).resolves.toMatchObject({ ok: true })
    expect(probe).toHaveBeenCalledWith(OMNIROUTE_DEFAULT_BASE)
  })

  it('maps probe failure to unhealthy without throwing', async () => {
    probe.mockRejectedValue(new Error('Failed to fetch'))
    await expect(checkOmniRouteHealth()).resolves.toMatchObject({
      ok: false,
      baseUrl: OMNIROUTE_DEFAULT_BASE,
    })
  })
})
