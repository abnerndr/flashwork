import { osFamily, type OSFamily } from './platform'
import type { AgentType } from './types'

export type { OSFamily }

export type InstallToolchain = {
  node: string | null
  npm: boolean
  winget: boolean
  scoop: boolean
  choco: boolean
  bun: boolean
  pnpm: boolean
  brew: boolean
  /** Probe OS family (`windows` | `macos` | `linux`). Optional so fixtures need not set it. */
  os?: string
}

export type InstallMethodId = 'native' | 'brew' | 'npm' | 'winget' | 'scoop' | 'choco'

export type InstallMethod = {
  id: InstallMethodId
  command: string
  requires?: keyof InstallToolchain
  /**
   * CLI to probe to decide whether the install worked. Defaults to the agent's own command; a
   * toolchain install (Node) has to be verified against the toolchain instead.
   */
  verifyCommand?: string
  /** Inverts the check: the run succeeded when the CLI is gone, not when it is found. */
  verifyAbsent?: boolean
  /** Hide this method when Node is missing or older than this major version. */
  minNodeMajor?: number
  /** Restrict to these OS families. Omitted means every OS. */
  os?: OSFamily | OSFamily[]
}

export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download'

export type AgentInstallCatalogEntry = {
  docsUrl: string
  methods: InstallMethod[]
}

const METHOD_ORDER: InstallMethodId[] = ['native', 'brew', 'npm', 'winget', 'scoop', 'choco']

export function nodeMajor(version: string | null | undefined): number | null {
  if (!version) return null
  const match = /^v?(\d+)/.exec(version.trim())
  if (!match) return null
  const major = Number.parseInt(match[1], 10)
  return Number.isFinite(major) ? major : null
}

function methodMatchesOs(method: InstallMethod, os: OSFamily): boolean {
  if (!method.os) return true
  const allowed = Array.isArray(method.os) ? method.os : [method.os]
  return allowed.includes(os)
}

function methodIsViable(
  method: InstallMethod,
  toolchain: InstallToolchain | null,
  os: OSFamily,
): boolean {
  if (!methodMatchesOs(method, os)) return false
  if (method.minNodeMajor) {
    const major = nodeMajor(toolchain?.node)
    if (major === null || major < method.minNodeMajor) return false
  }
  if (!method.requires) return true
  if (!toolchain) return false
  return Boolean(toolchain[method.requires])
}

function commandTarget(command: string): string | undefined {
  return command.trim().split(/\s+/).pop()
}

// Commands are fixed literals, never user input: they are handed straight to a
// shell PTY. Verified against each vendor's official install documentation.
export const AGENT_INSTALL_CATALOG: Partial<Record<AgentType, AgentInstallCatalogEntry>> = {
  claude: {
    docsUrl: 'https://code.claude.com/docs/en/setup',
    methods: [
      { id: 'native', command: 'irm https://claude.ai/install.ps1 | iex', os: 'windows' },
      {
        id: 'native',
        command: 'curl -fsSL https://claude.ai/install.sh | bash',
        os: ['linux', 'macos'],
      },
      {
        id: 'winget',
        command: 'winget install Anthropic.ClaudeCode',
        requires: 'winget',
        os: 'windows',
      },
      { id: 'npm', command: 'npm install -g @anthropic-ai/claude-code', requires: 'npm' },
    ],
  },
  codex: {
    docsUrl: 'https://github.com/openai/codex',
    methods: [
      { id: 'native', command: 'irm https://chatgpt.com/codex/install.ps1 | iex', os: 'windows' },
      { id: 'npm', command: 'npm install -g @openai/codex', requires: 'npm' },
    ],
  },
  copilot: {
    docsUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/cli-getting-started',
    methods: [
      { id: 'winget', command: 'winget install GitHub.Copilot', requires: 'winget', os: 'windows' },
      { id: 'npm', command: 'npm install -g @github/copilot', requires: 'npm' },
    ],
  },
  antigravity: {
    docsUrl: 'https://antigravity.google/docs/cli/install',
    methods: [
      {
        id: 'native',
        command: 'irm https://antigravity.google/cli/install.ps1 | iex',
        os: 'windows',
      },
      {
        id: 'native',
        command: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
        os: ['linux', 'macos'],
      },
    ],
  },
  gemini: {
    docsUrl: 'https://github.com/google-gemini/gemini-cli',
    methods: [
      {
        id: 'npm',
        command: 'npm install -g @google/gemini-cli',
        requires: 'npm',
        minNodeMajor: 20,
      },
    ],
  },
  mimo: {
    docsUrl: 'https://github.com/XiaomiMiMo/MiMo-Code',
    methods: [
      { id: 'native', command: 'irm https://mimo.xiaomi.com/install.ps1 | iex', os: 'windows' },
      {
        id: 'native',
        command: 'curl -fsSL https://mimo.xiaomi.com/install | bash',
        os: ['linux', 'macos'],
      },
      { id: 'npm', command: 'npm install -g @mimo-ai/cli', requires: 'npm' },
    ],
  },
  freebuff: {
    docsUrl: 'https://freebuff.com',
    methods: [{ id: 'npm', command: 'npm install -g freebuff', requires: 'npm' }],
  },
  opencode: {
    docsUrl: 'https://opencode.ai/docs/',
    methods: [
      { id: 'npm', command: 'npm install -g opencode-ai', requires: 'npm' },
      { id: 'brew', command: 'brew install opencode', requires: 'brew', os: 'macos' },
      { id: 'scoop', command: 'scoop install opencode', requires: 'scoop', os: 'windows' },
      { id: 'choco', command: 'choco install opencode', requires: 'choco', os: 'windows' },
    ],
  },
}

export function installDocsUrl(agent: AgentType): string | undefined {
  return AGENT_INSTALL_CATALOG[agent]?.docsUrl
}

/**
 * Methods that will actually work on this machine, best first. A method without
 * `requires` needs nothing beyond a shell, so it always qualifies.
 */
export function installMethodsFor(
  agent: AgentType,
  toolchain: InstallToolchain | null,
  os: OSFamily = osFamily(),
): InstallMethod[] {
  const entry = AGENT_INSTALL_CATALOG[agent]
  if (!entry) return []
  return entry.methods
    .filter((method) => methodIsViable(method, toolchain, os))
    .sort((a, b) => METHOD_ORDER.indexOf(a.id) - METHOD_ORDER.indexOf(b.id))
}

// Official package identifiers for the Node.js LTS line, in the same order of preference used for
// agents: a real package manager first, and the download page as the always-available fallback.
const NODE_INSTALL_METHODS: InstallMethod[] = [
  {
    id: 'winget',
    command: 'winget install OpenJS.NodeJS.LTS',
    requires: 'winget',
    verifyCommand: 'npm',
  },
  { id: 'scoop', command: 'scoop install nodejs-lts', requires: 'scoop', verifyCommand: 'npm' },
  { id: 'choco', command: 'choco install nodejs-lts', requires: 'choco', verifyCommand: 'npm' },
]

/**
 * True when the agent would be installable here if Node were present: it has installers, but every
 * one of them needs npm and npm is missing. Agents with a native installer never qualify.
 */
export function needsNodeToolchain(
  agent: AgentType,
  toolchain: InstallToolchain | null,
  os: OSFamily = osFamily(),
): boolean {
  const entry = AGENT_INSTALL_CATALOG[agent]
  if (!entry || entry.methods.length === 0) return false
  if (installMethodsFor(agent, toolchain, os).length > 0) return false
  return entry.methods.some(
    (method) =>
      methodMatchesOs(method, os) && (method.requires === 'npm' || Boolean(method.minNodeMajor)),
  )
}

/** Node installers that work on this machine, best first. Empty means "send them to the website". */
export function nodeInstallMethods(toolchain: InstallToolchain | null): InstallMethod[] {
  if (!toolchain) return []
  return NODE_INSTALL_METHODS.filter((method) =>
    method.requires ? Boolean(toolchain[method.requires]) : true,
  )
}

// Every documented install command ends in the package or package id, so the uninstall counterpart
// is derived from it rather than duplicated in the catalog.
const UNINSTALL_TEMPLATE: Partial<Record<InstallMethodId, (target: string) => string>> = {
  npm: (target) => `npm uninstall -g ${target}`,
  winget: (target) => `winget uninstall ${target}`,
  scoop: (target) => `scoop uninstall ${target}`,
  choco: (target) => `choco uninstall ${target} -y`,
  brew: (target) => `brew uninstall ${target}`,
}

/**
 * How this agent can be removed on this machine, best first. `native` installers are skipped: none
 * of the vendors documents an uninstall for their install script, and guessing would delete the
 * wrong thing. An empty list means "we cannot remove it for you".
 */
export function uninstallMethodsFor(
  agent: AgentType,
  toolchain: InstallToolchain | null,
  os: OSFamily = osFamily(),
): InstallMethod[] {
  return installMethodsFor(agent, toolchain, os).flatMap((method) => {
    const template = UNINSTALL_TEMPLATE[method.id]
    if (!template) return []
    const target = commandTarget(method.command)
    if (!target) return []
    return [{ ...method, command: template(target), verifyAbsent: true }]
  })
}

function updateCommandFor(method: InstallMethod): string | null {
  switch (method.id) {
    case 'npm': {
      const pkg = commandTarget(method.command)
      if (!pkg) return null
      return `npm install -g ${pkg}@latest`
    }
    case 'native':
      return method.command
    case 'winget': {
      const id = commandTarget(method.command)
      if (!id) return null
      return `winget upgrade ${id}`
    }
    case 'brew': {
      const formula = commandTarget(method.command)
      if (!formula) return null
      return `brew upgrade ${formula}`
    }
    default:
      return null
  }
}

/**
 * How this agent can be updated on this machine, best first. Reuses install methods for the OS,
 * then maps each to its upgrade counterpart. Native installers are re-run as-is.
 */
export function updateMethodsFor(
  agent: AgentType,
  toolchain: InstallToolchain | null,
  os: OSFamily = osFamily(),
): InstallMethod[] {
  return installMethodsFor(agent, toolchain, os).flatMap((method) => {
    const command = updateCommandFor(method)
    if (!command) return []
    return [{ ...method, command }]
  })
}

/** Interactive shell the installer PTY must spawn so a ps1/sh line is never written into cmd.exe. */
export function installerPtyCommand(os: OSFamily = osFamily()): 'pwsh' | 'bash' {
  return os === 'windows' ? 'pwsh' : 'bash'
}

/** Line handed to the shell PTY: run the installer, then close the shell. */
export function installShellLine(command: string, os: OSFamily = osFamily()): string {
  if (os === 'windows') {
    const usesCmd = /^(npm|npx|pnpm|yarn|winget|scoop|choco)\b/i.test(command.trim())
    const body = usesCmd ? `cmd /c "${command.replace(/"/g, '\\"')}"` : command
    return `$env:npm_config_prefix=$null; $env:npm_config_global_prefix=$null; ${body}; exit $LASTEXITCODE\r`
  }
  return `unset npm_config_prefix npm_config_global_prefix; ${command} && exit 0 || exit 1\r`
}

/** Parent directory of a CLI path. Splits on `/` and `\\` so we do not depend on Node `path`. */
export function parentPath(path: string): string {
  const cleaned = path.replace(/[/\\]+$/, '')
  const idx = Math.max(cleaned.lastIndexOf('/'), cleaned.lastIndexOf('\\'))
  return idx > 0 ? cleaned.slice(0, idx) : cleaned
}

/** True when the installer PTY printed an error that will never reach a clean `exit`. */
export function installOutputIsFatal(log: string): boolean {
  return /nvm is not compatible with the ["']npm_config_prefix["']/i.test(log)
}
