import { beforeEach, describe, expect, it, vi } from 'vitest'

import { omnirouteGetGatewayKey } from '../tauri/omnirouteSidecar'
import { checkOmniRouteHealth } from './omniroute'
import { resolveOmniRouteSpawnEnv } from './omniRouteSpawn'

vi.mock('../tauri/omnirouteSidecar', () => ({
  omnirouteGetGatewayKey: vi.fn(),
}))

vi.mock('./omniroute', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./omniroute')>()
  return {
    ...actual,
    checkOmniRouteHealth: vi.fn(),
  }
})

const getKey = vi.mocked(omnirouteGetGatewayKey)
const health = vi.mocked(checkOmniRouteHealth)

function okHealth() {
  return {
    ok: true,
    baseUrl: 'http://127.0.0.1:20128',
    detail: 'Gateway reachable',
    checkedAt: 1,
  }
}

describe('resolveOmniRouteSpawnEnv', () => {
  beforeEach(() => {
    getKey.mockReset()
    health.mockReset()
  })

  it('skips gateway env when opt-in is off', async () => {
    const env = await resolveOmniRouteSpawnEnv({ FOO: '1' }, { omniRouteEnabled: false })
    expect(env).toEqual({ FOO: '1' })
    expect(health).not.toHaveBeenCalled()
    expect(getKey).not.toHaveBeenCalled()
  })

  it('skips gateway env when enabled but key is missing', async () => {
    health.mockResolvedValue(okHealth())
    getKey.mockRejectedValue(new Error('missing key'))
    const env = await resolveOmniRouteSpawnEnv({}, { omniRouteEnabled: true })
    expect(env).toEqual({})
    expect(env?.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('skips gateway env when enabled but offline', async () => {
    health.mockResolvedValue({ ...okHealth(), ok: false, detail: 'Offline' })
    getKey.mockResolvedValue('gw-key')
    const env = await resolveOmniRouteSpawnEnv({}, { omniRouteEnabled: true })
    expect(env).toEqual({})
    expect(env?.ANTHROPIC_BASE_URL).toBeUndefined()
  })

  it('merges gateway env when opted in, healthy, and keyed', async () => {
    health.mockResolvedValue(okHealth())
    getKey.mockResolvedValue('gw-key')
    const env = await resolveOmniRouteSpawnEnv({ FOO: '1' }, { omniRouteEnabled: true })
    expect(env?.FOO).toBe('1')
    expect(env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:20128/v1')
    expect(env?.ANTHROPIC_API_KEY).toBe('gw-key')
  })

  it('does not throw when health lookup fails', async () => {
    health.mockRejectedValue(new Error('boom'))
    getKey.mockResolvedValue('gw-key')
    await expect(resolveOmniRouteSpawnEnv({}, { omniRouteEnabled: true })).resolves.toEqual({})
  })
})
