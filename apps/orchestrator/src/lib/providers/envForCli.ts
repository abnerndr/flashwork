/** Maps provider API keys onto the coding-agent CLI env vars that read them.
 *
 * The real secret never travels through Zustand/IPC. `providerSpawnFlags`
 * only tells `spawn_pty` / `restart_pty` which provider's keyring entry to
 * read; the Rust side (`providers.rs`, ADR 010) resolves the actual value at
 * spawn time and merges it into the child process env. `cliProviderEnv` is a
 * pure mapping helper — useful for tests and for documenting exactly which
 * env var names get injected — and returns a placeholder value, never a real
 * key.
 */

import type { AgentType, Preferences } from '../types'
import type { ProviderId } from './modelCatalog'

/** Locked mapping (ADR 010): provider id -> CLI env var name(s) it feeds. */
export const PROVIDER_CLI_ENV: Record<ProviderId, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: ['OPENAI_API_KEY'],
  google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
}

/** Which coding-agent CLI receives which provider's key. Agents with no entry
 * here (shell, opencode, copilot, mimo, freebuff) never get provider env. */
export const CLI_PROVIDER: Partial<Record<AgentType, ProviderId>> = {
  claude: 'anthropic',
  codex: 'openai',
  gemini: 'google',
  antigravity: 'google',
}

type CliKeyToggleKey = 'useAnthropicKeyOnCli' | 'useOpenaiKeyOnCli' | 'useGoogleKeyOnCli'

const TOGGLE_KEY_FOR_PROVIDER: Record<ProviderId, CliKeyToggleKey> = {
  anthropic: 'useAnthropicKeyOnCli',
  openai: 'useOpenaiKeyOnCli',
  google: 'useGoogleKeyOnCli',
}

/** Only the three booleans this module cares about; callers can pass the full
 * `Preferences` object or a partial test fixture. */
export type CliProviderPrefs = Partial<Pick<Preferences, CliKeyToggleKey>>

function providerForAgent(agent: AgentType, prefs: CliProviderPrefs): ProviderId | undefined {
  const provider = CLI_PROVIDER[agent]
  if (!provider) return undefined
  return prefs[TOGGLE_KEY_FOR_PROVIDER[provider]] ? provider : undefined
}

/**
 * Pure mapping used for tests/documentation: which env vars would be injected
 * for `agent` given the current CLI-key toggles and known key presence. The
 * real spawn path never calls this to build IPC payloads — see
 * `providerSpawnFlags` — so the `'from-backend'` placeholder never leaves
 * this module.
 */
export function cliProviderEnv(
  agent: AgentType,
  prefs: CliProviderPrefs,
  hasKey: Partial<Record<ProviderId, boolean>>,
): Record<string, string> {
  const provider = providerForAgent(agent, prefs)
  if (!provider || !hasKey[provider]) return {}
  const env: Record<string, string> = {}
  for (const name of PROVIDER_CLI_ENV[provider]) {
    env[name] = 'from-backend'
  }
  return env
}

export type ProviderSpawnFlags = { useProviderKey: true; provider: ProviderId } | Record<string, never>

/**
 * Flags to spread into the `spawn_pty` / `restart_pty` IPC payload. Never
 * carries the secret — only which keyring entry Rust should read. If the
 * toggle is on but nothing is stored, Rust spawns normally and injects
 * nothing.
 */
export function providerSpawnFlags(agent: AgentType, prefs: CliProviderPrefs): ProviderSpawnFlags {
  const provider = providerForAgent(agent, prefs)
  if (!provider) return {}
  return { useProviderKey: true, provider }
}
