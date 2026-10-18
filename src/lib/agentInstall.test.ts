import { describe, expect, it } from 'vitest'

import {
  installMethodsFor,
  installerPtyCommand,
  installOutputIsFatal,
  installShellLine,
  type InstallToolchain,
  needsNodeToolchain,
  parentPath,
  uninstallMethodsFor,
  updateMethodsFor,
} from './agentInstall'

const BARE: InstallToolchain = {
  node: null,
  npm: false,
  winget: false,
  scoop: false,
  choco: false,
  bun: false,
  pnpm: false,
  brew: false,
}

describe('installMethodsFor', () => {
  it('offers the native installer first even when npm is available', () => {
    const methods = installMethodsFor('claude', { ...BARE, node: 'v22.3.0', npm: true }, 'windows')
    expect(methods.map((method) => method.id)).toEqual(['native', 'npm'])
    expect(methods[0].command).toContain('claude.ai/install.ps1')
  })

  it('hides npm when the machine has no npm', () => {
    const methods = installMethodsFor('codex', BARE, 'windows')
    expect(methods.map((method) => method.id)).toEqual(['native'])
  })

  it('surfaces winget for Claude only when winget exists', () => {
    expect(installMethodsFor('claude', BARE, 'windows').map((m) => m.id)).toEqual(['native'])
    expect(
      installMethodsFor('claude', { ...BARE, winget: true }, 'windows').map((m) => m.id),
    ).toEqual(['native', 'winget'])
  })

  it('offers the official Copilot CLI packages available on the machine', () => {
    const methods = installMethodsFor('copilot', { ...BARE, winget: true, npm: true }, 'windows')
    expect(methods.map((method) => method.id)).toEqual(['npm', 'winget'])
    expect(methods.map((method) => method.command)).toEqual([
      'npm install -g @github/copilot',
      'winget install GitHub.Copilot',
    ])
  })

  it('falls back to scoop and choco for OpenCode when there is no npm', () => {
    const methods = installMethodsFor('opencode', { ...BARE, scoop: true, choco: true }, 'windows')
    expect(methods.map((method) => method.id)).toEqual(['scoop', 'choco'])
  })

  it('returns nothing for agents without a known installer', () => {
    expect(installMethodsFor('shell', { ...BARE, npm: true })).toEqual([])
  })

  it('treats a missing toolchain probe as "only requirement-free methods"', () => {
    expect(installMethodsFor('opencode', null)).toEqual([])
    expect(installMethodsFor('antigravity', null, 'windows').map((m) => m.id)).toEqual(['native'])
  })

  it('installs Freebuff through npm and Mimo through its own script', () => {
    expect(installMethodsFor('freebuff', { ...BARE, npm: true })[0].command).toBe(
      'npm install -g freebuff',
    )
    expect(installMethodsFor('mimo', BARE, 'windows').map((method) => method.id)).toEqual(['native'])
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

  it('hides brew methods when Homebrew is missing and surfaces them when present', () => {
    expect(
      installMethodsFor('opencode', { ...BARE, brew: false }, 'macos').map((m) => m.id),
    ).not.toContain('brew')
    const methods = installMethodsFor('opencode', { ...BARE, brew: true }, 'macos')
    expect(methods.some((m) => m.command === 'brew install opencode')).toBe(true)
  })

  it('does not offer PowerShell native install on linux', () => {
    const methods = installMethodsFor('claude', { ...BARE, npm: true }, 'linux')
    expect(methods.some((m) => m.command.includes('install.ps1'))).toBe(false)
    expect(methods.some((m) => m.command.includes('install.sh'))).toBe(true)
  })

  it('offers PowerShell native install on windows even without npm', () => {
    const methods = installMethodsFor('claude', BARE, 'windows')
    expect(methods[0].command).toContain('install.ps1')
  })
})

describe('updateMethodsFor', () => {
  it('update prefers npm latest when npm installed the cli', () => {
    const methods = updateMethodsFor('gemini', { ...BARE, npm: true, node: 'v22.0.0' }, 'linux')
    expect(methods[0].command).toBe('npm install -g @google/gemini-cli@latest')
  })

  it('update re-runs unix native installer when there is no npm', () => {
    const methods = updateMethodsFor('claude', BARE, 'macos')
    expect(methods[0].command).toContain('install.sh')
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
    expect(needsNodeToolchain('opencode', BARE, 'windows')).toBe(true)
    expect(needsNodeToolchain('opencode', { ...BARE, scoop: true }, 'windows')).toBe(false)
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
    expect(uninstallMethodsFor('antigravity', { ...BARE, npm: true }, 'windows')).toEqual([])
    expect(uninstallMethodsFor('claude', BARE, 'windows')).toEqual([])
  })

  it('uses the package manager that exists on the machine', () => {
    expect(uninstallMethodsFor('opencode', { ...BARE, choco: true }, 'windows')[0].command).toBe(
      'choco uninstall opencode -y',
    )
    expect(uninstallMethodsFor('claude', { ...BARE, winget: true }, 'windows')[0].command).toBe(
      'winget uninstall Anthropic.ClaudeCode',
    )
  })
})

describe('installShellLine', () => {
  it('closes the shell so the runner can detect completion', () => {
    expect(installShellLine('npm install -g opencode-ai', 'linux')).toBe(
      'unset npm_config_prefix npm_config_global_prefix; npm install -g opencode-ai && exit 0 || exit 1\r',
    )
  })

  it('propagates npm exit code on Windows PowerShell', () => {
    expect(installShellLine('npm install -g @google/gemini-cli', 'windows')).toBe(
      '$env:npm_config_prefix=$null; $env:npm_config_global_prefix=$null; cmd /c "npm install -g @google/gemini-cli"; exit $LASTEXITCODE\r',
    )
  })

  it('never wraps npm in cmd /c on unix', () => {
    expect(installShellLine('npm install -g opencode-ai', 'linux')).not.toContain('cmd /c')
    expect(installShellLine('npm install -g opencode-ai', 'macos')).not.toContain('cmd /c')
  })

  it('does not wrap native PowerShell pipelines in cmd /c', () => {
    const line = installShellLine('irm https://claude.ai/install.ps1 | iex', 'windows')
    expect(line).toContain('irm https://claude.ai/install.ps1 | iex')
    expect(line).not.toContain('cmd /c')
  })
})

describe('installerPtyCommand', () => {
  it('picks pwsh on Windows and bash on unix', () => {
    expect(installerPtyCommand('windows')).toBe('pwsh')
    expect(installerPtyCommand('linux')).toBe('bash')
    expect(installerPtyCommand('macos')).toBe('bash')
  })
})

describe('parentPath', () => {
  it('splits on forward and back slashes', () => {
    expect(parentPath('/home/a/.local/bin/claude')).toBe('/home/a/.local/bin')
    expect(parentPath('C:\\Users\\a\\.local\\bin\\claude.exe')).toBe('C:\\Users\\a\\.local\\bin')
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
