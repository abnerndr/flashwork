import { invoke } from '@tauri-apps/api/core'

export type OmniRouteStartResult = {
  startedByApp: boolean
  alreadyRunning: boolean
}

export function omnirouteStart(password: string, baseUrl: string): Promise<OmniRouteStartResult> {
  return invoke('omniroute_start', { password, baseUrl })
}

export function omnirouteStop(): Promise<void> {
  return invoke('omniroute_stop')
}

export function omnirouteSetGatewayKey(key: string): Promise<void> {
  return invoke('omniroute_set_gateway_key', { key })
}

export function omnirouteGetGatewayKey(): Promise<string | null> {
  return invoke('omniroute_get_gateway_key')
}
