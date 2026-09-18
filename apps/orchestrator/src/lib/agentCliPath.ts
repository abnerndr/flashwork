import { basename } from './paths'
import { agentCliCommand, type AgentType } from './types'

const EXECUTABLE_SUFFIX = /\.(cmd|exe|bat|ps1)$/i

/** Mirrors Rust `cli_name_aliases`. Gemini ships as `gemini` or `gemini-cli`. */
export function cliNameAliases(command: string): string[] {
  if (command === 'gemini') return ['gemini', 'gemini-cli']
  if (command === 'gemini-cli') return ['gemini-cli', 'gemini']
  return [command]
}

/**
 * Whether the picked file looks like the agent's CLI rather than something else that carries the
 * vendor's name. Antigravity is the case this exists for: its CLI is `agy`, while `antigravity.exe`
 * is the desktop app — pointing an override at the app launches a window instead of a terminal.
 * Gemini also accepts `gemini-cli`.
 */
export function cliPathMatchesAgent(agent: AgentType, path: string): boolean {
  const expected = agentCliCommand(agent)
  if (!expected) return true
  const file = basename(path).toLowerCase().replace(EXECUTABLE_SUFFIX, '')
  return cliNameAliases(expected).some((alias) => file === alias.toLowerCase())
}
