import { invoke } from '@tauri-apps/api/core'

import type { ProviderId } from '../providers/modelCatalog'

export type ProviderKeyStatus = {
  saved: boolean
}

/** Stores `key` in the OS keyring for `id`. Rejected by the backend if `key` is empty/whitespace. */
export async function providerKeySet(id: ProviderId, key: string): Promise<void> {
  await invoke('provider_key_set', { id, key })
}

/** Never resolves with the secret itself — only whether one is stored. */
export async function providerKeyStatus(id: ProviderId): Promise<ProviderKeyStatus> {
  return invoke<ProviderKeyStatus>('provider_key_status', { id })
}

export async function providerKeyClear(id: ProviderId): Promise<void> {
  await invoke('provider_key_clear', { id })
}
