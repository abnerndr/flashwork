import { describe, expect, it } from 'vitest'

import { cliNameAliases, cliPathMatchesAgent } from './agentCliPath'

describe('cliPathMatchesAgent', () => {
  it('accepts the Antigravity CLI and rejects the desktop application', () => {
    expect(cliPathMatchesAgent('antigravity', String.raw`C:\Tools\agy.exe`)).toBe(true)
    expect(cliPathMatchesAgent('antigravity', String.raw`C:\Apps\Antigravity.exe`)).toBe(false)
  })

  it('accepts Windows launcher extensions for GitHub Copilot', () => {
    expect(cliPathMatchesAgent('copilot', String.raw`C:\npm\copilot.cmd`)).toBe(true)
  })

  it('accepts gemini and gemini-cli as aliases for Gemini', () => {
    expect(cliPathMatchesAgent('gemini', '/home/u/.nvm/versions/node/v22.11.0/bin/gemini')).toBe(
      true,
    )
    expect(cliPathMatchesAgent('gemini', '/usr/local/bin/gemini-cli')).toBe(true)
    expect(
      cliPathMatchesAgent('gemini', String.raw`C:\Users\u\AppData\Roaming\npm\gemini-cli.cmd`),
    ).toBe(true)
  })
})

describe('cliNameAliases', () => {
  it('lists gemini then gemini-cli for agent gemini', () => {
    expect(cliNameAliases('gemini')).toEqual(['gemini', 'gemini-cli'])
  })

  it('puts the asked name first for gemini-cli', () => {
    expect(cliNameAliases('gemini-cli')).toEqual(['gemini-cli', 'gemini'])
  })

  it('does not invent aliases for other agents', () => {
    expect(cliNameAliases('copilot')).toEqual(['copilot'])
    expect(cliNameAliases('claude')).toEqual(['claude'])
  })
})
