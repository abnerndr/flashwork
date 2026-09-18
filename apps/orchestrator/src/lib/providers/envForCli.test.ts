import { describe, expect, it } from 'vitest'

import { cliProviderEnv, PROVIDER_CLI_ENV, providerSpawnFlags } from './envForCli'

describe('cliProviderEnv', () => {
  it('injects ANTHROPIC_API_KEY for claude when enabled and key present', () => {
    expect(cliProviderEnv('claude', { useAnthropicKeyOnCli: true }, { anthropic: true })).toEqual({
      ANTHROPIC_API_KEY: 'from-backend', // placeholder — the spawn path never sends this over IPC
    })
  })

  it('does not inject when the toggle is off', () => {
    expect(cliProviderEnv('claude', { useAnthropicKeyOnCli: false }, { anthropic: true })).toEqual(
      {},
    )
  })

  it('does not inject when the toggle is on but no key is stored', () => {
    expect(cliProviderEnv('claude', { useAnthropicKeyOnCli: true }, { anthropic: false })).toEqual(
      {},
    )
  })

  it('injects OPENAI_API_KEY for codex', () => {
    expect(cliProviderEnv('codex', { useOpenaiKeyOnCli: true }, { openai: true })).toEqual({
      OPENAI_API_KEY: 'from-backend',
    })
  })

  it('injects both GEMINI_API_KEY and GOOGLE_API_KEY for gemini', () => {
    expect(cliProviderEnv('gemini', { useGoogleKeyOnCli: true }, { google: true })).toEqual({
      GEMINI_API_KEY: 'from-backend',
      GOOGLE_API_KEY: 'from-backend',
    })
  })

  it('injects the same google keys for antigravity', () => {
    expect(cliProviderEnv('antigravity', { useGoogleKeyOnCli: true }, { google: true })).toEqual({
      GEMINI_API_KEY: 'from-backend',
      GOOGLE_API_KEY: 'from-backend',
    })
  })

  it('returns empty for agents with no provider mapping', () => {
    expect(cliProviderEnv('opencode', {}, {})).toEqual({})
    expect(cliProviderEnv('shell', {}, {})).toEqual({})
    expect(cliProviderEnv('copilot', {}, {})).toEqual({})
  })
})

describe('providerSpawnFlags', () => {
  it('adds useProviderKey + provider for claude when the toggle is on', () => {
    expect(providerSpawnFlags('claude', { useAnthropicKeyOnCli: true })).toEqual({
      useProviderKey: true,
      provider: 'anthropic',
    })
  })

  it('returns no flags when the toggle is off', () => {
    expect(providerSpawnFlags('claude', { useAnthropicKeyOnCli: false })).toEqual({})
  })

  it('returns no flags for agents without a provider mapping', () => {
    expect(providerSpawnFlags('opencode', {})).toEqual({})
    expect(providerSpawnFlags('shell', {})).toEqual({})
  })

  it('does not depend on whether a key is actually stored (Rust decides that)', () => {
    expect(providerSpawnFlags('codex', { useOpenaiKeyOnCli: true })).toEqual({
      useProviderKey: true,
      provider: 'openai',
    })
  })
})

describe('PROVIDER_CLI_ENV', () => {
  it('matches the locked mapping from ADR 010', () => {
    expect(PROVIDER_CLI_ENV).toEqual({
      anthropic: ['ANTHROPIC_API_KEY'],
      openai: ['OPENAI_API_KEY'],
      google: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    })
  })
})
