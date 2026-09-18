import { invoke } from '@tauri-apps/api/core'

import type { ProviderId } from '../providers/modelCatalog'

export type ProviderKeyStatus = {
  saved: boolean
}

export type ChatRole = 'user' | 'assistant' | 'system'

export type ChatMessage = {
  role: ChatRole
  content: string
}

export type ProviderChatResult = {
  text: string
}

/** Locked contract (Task 4): router-role calls default to this timeout. */
export const ROUTER_TIMEOUT_MS = 2_500
/** Locked contract (Task 4): coding-role calls use this timeout. */
export const CODING_TIMEOUT_MS = 120_000

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

/**
 * Calls the vendor's official chat-completions endpoint directly (no
 * third-party LLM gateway of any kind — see ADR 006/009/010) and resolves
 * with only the assistant's text. `timeoutMs` should be `ROUTER_TIMEOUT_MS`
 * for router-role calls or `CODING_TIMEOUT_MS` for coding-role calls;
 * omitting it (or passing `0`) defaults to `ROUTER_TIMEOUT_MS` on the backend.
 */
export async function providerChat(
  provider: ProviderId,
  model: string,
  messages: ChatMessage[],
  timeoutMs = 0,
): Promise<ProviderChatResult> {
  return invoke<ProviderChatResult>('provider_chat', { provider, model, messages, timeoutMs })
}

export type CatalogModel = {
  id: string
  label: string
}

/** Only providers whose GET succeeded are present as keys. */
export type CatalogRefreshResult = Partial<Record<ProviderId, CatalogModel[]>>

/**
 * User-triggered refresh of each vendor's official models list, using the
 * saved key when present. Never rejects — a provider missing from the
 * result (or the whole call failing) means the caller should keep its
 * existing (Task 1) catalog snapshot for that provider.
 */
export async function providerCatalogRefresh(): Promise<CatalogRefreshResult> {
  return invoke<CatalogRefreshResult>('provider_catalog_refresh')
}
