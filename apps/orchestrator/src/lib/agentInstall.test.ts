import { describe, expect, it } from 'vitest'

import {
  installMethodsFor,
  installOutputIsFatal,
  installShellLine,
  type InstallToolchain,
  needsNodeToolchain,
  uninstallMethodsFor,
} from './agentInstall'

const BARE: InstallToolchain = {
  node: null,
  npm: false,
  winget: false,
  scoop: false,
  choco: false,
  bun: false,
  pnpm: false,
}

describe('installMethodsFor', () => {
  it('offers the native installer first even when npm is available', () => {
    const methods = installMethodsFor('claude', { ...BARE, node: 'v22.3.0', npm: true })
    expect(methods.map((method) => method.id)).toEqual(['native', 'npm'])
    expect(methods[0].command).toContain('claude.ai/install.ps1')
  })

  it('hides npm when the machine has no npm', () => {
    const methods = installMethodsFor('codex', BARE)
    expect(methods.map((method) => method.id)).toEqual(['native'])
  })

  it('surfaces winget for Claude only when winget exists', () => {
    expect(installMethodsFor('claude', BARE).map((m) => m.id)).toEqual(['native'])
    expect(installMethodsFor('claude', { ...BARE, winget: true }).map((m) => m.id)).toEqual([
      'native',
      'winget',
    ])
  })

  it('offers the official Copilot CLI packages available on the machine', () => {
    const methods = installMethodsFor('copilot', { ...BARE, winget: true, npm: true })
    expect(methods.map((method) => method.id)).toEqual(['npm', 'winget'])
    expect(methods.map((method) => method.command)).toEqual([
      'npm install -g @github/copilot',
      'winget install GitHub.Copilot',
    ])
  })

  it('falls back to scoop and choco for OpenCode when there is no npm', () => {
    const methods = installMethodsFor('opencode', { ...BARE, scoop: true, choco: true })
    expect(methods.map((method) => method.id)).toEqual(['scoop', 'choco'])
  })

  it('returns nothing for agents without a known installer', () => {
    expect(installMethodsFor('shell', { ...BARE, npm: true })).toEqual([])
  })

  it('treats a missing toolchain probe as "only requirement-free methods"', () => {
    expect(installMethodsFor('opencode', null)).toEqual([])
    expect(installMethodsFor('antigravity', null).map((m) => m.id)).toEqual(['native'])
  })

  it('installs Freebuff through npm and Mimo through its own script', () => {
    expect(installMethodsFor('freebuff', { ...BARE, npm: true })[0].command).toBe(
      'npm install -g freebuff',
    )
    expect(installMethodsFor('mimo', BARE).map((method) => method.id)).toEqual(['native'])
  })

  it('installs Gemini CLI through the official npm package', () => {
    expect(installMethodsFor('gemini', { ...BARE, node: 'v22.3.0', npm: true })[0].command).toBe(
      'npm install -g @google/gemini-cli',
    )
    expect(needsNodeToolchain('gemini', BARE)).toBe(true)
  })

  it('hides Gemini npm until Node 20 is present', () => {
    expect(installMethodsFor('gemini', { ...BARE, node: 'v18.20.0', npm: true })).toEqual([])
    expect(needsNodeToolchain('gemini', { ...BARE, node: 'v18.20.0', npm: true })).toBe(true)
  })
})

describe('needsNodeToolchain', () => {
  it('flags npm-only agents when npm is missing', () => {
    expect(needsNodeToolchain('freebuff', BARE)).toBe(true)
    expect(needsNodeToolchain('freebuff', { ...BARE, npm: true })).toBe(false)
  })

  it('stays quiet when the agent has a installer that does not need Node', () => {
    expect(needsNodeToolchain('claude', BARE)).toBe(false)
    expect(needsNodeToolchain('mimo', BARE)).toBe(false)
  })

  it('stays quiet for agents with no installer at all', () => {
    expect(needsNodeToolchain('shell', BARE)).toBe(false)
  })

  it('flags OpenCode only when every package manager is missing', () => {
    expect(needsNodeToolchain('opencode', BARE)).toBe(true)
    expect(needsNodeToolchain('opencode', { ...BARE, scoop: true })).toBe(false)
  })
})

describe('uninstallMethodsFor', () => {
  it('derives the uninstall command from the install command', () => {
    const [method] = uninstallMethodsFor('opencode', { ...BARE, npm: true })
    expect(method.command).toBe('npm uninstall -g opencode-ai')
    expect(method.verifyAbsent).toBe(true)
  })

  it('keeps scoped package names intact', () => {
    expect(uninstallMethodsFor('codex', { ...BARE, npm: true })[0].command).toBe(
      'npm uninstall -g @openai/codex',
    )
  })

  it('never offers to undo a native install script', () => {
    expect(uninstallMethodsFor('antigravity', { ...BARE, npm: true })).toEqual([])
    expect(uninstallMethodsFor('claude', BARE)).toEqual([])
  })

  it('uses the package manager that exists on the machine', () => {
    expect(uninstallMethodsFor('opencode', { ...BARE, choco: true })[0].command).toBe(
      'choco uninstall opencode -y',
    )
    expect(uninstallMethodsFor('claude', { ...BARE, winget: true })[0].command).toBe(
      'winget uninstall Anthropic.ClaudeCode',
    )
  })
})

describe('installShellLine', () => {
  it('closes the shell so the runner can detect completion', () => {
    expect(installShellLine('npm install -g opencode-ai', false)).toBe(
      'unset npm_config_prefix npm_config_global_prefix; npm install -g opencode-ai && exit 0 || exit 1\r',
    )
  })

  it('propagates npm exit code on Windows PowerShell', () => {
    expect(installShellLine('npm install -g @google/gemini-cli', true)).toBe(
      '$env:npm_config_prefix=$null; $env:npm_config_global_prefix=$null; cmd /c "npm install -g @google/gemini-cli"; exit $LASTEXITCODE\r',
    )
  })
})

describe('installOutputIsFatal', () => {
  it('treats nvm prefix conflicts as a failed install so the modal can close', () => {
    expect(
      installOutputIsFatal(
        'nvm is not compatible with the "npm_config_prefix" environment variable: currently set to "/home/abner/www/ruperth/flashwork/apps/orchestrator"',
      ),
    ).toBe(true)
    expect(installOutputIsFatal('added 1 package in 3s')).toBe(false)
  })
})
