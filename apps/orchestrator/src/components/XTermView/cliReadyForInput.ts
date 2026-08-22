import { isAgentAuthError, isAgentLoginBlock } from '../../lib/promptRun/detectHandoffTrigger'
import type { AgentType } from '../../lib/types'

const CSI_OR_OSC = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|].*?(?:\x07|\x1b\\))/g

const READY_PATTERNS: Partial<Record<AgentType, RegExp[]>> = {
  gemini: [/Type your message/i, /Type a message/i],
  claude: [/\? for shortcuts/i, /Try "\/help"/i, /Bypassing Permissions/i, /shift\+tab to/i],
  codex: [/To get started/i, /ctrl\+c to (stop|exit)/i, /send with (enter|return)/i],
}

const SETTLE_AFTER_READY_MS = 350
const GEMINI_FALLBACK_MS = 22_000
const DEFAULT_FALLBACK_MS = 12_000
const QUIET_WITHOUT_MARKER_MS = 700
const EARLIEST_WITHOUT_MARKER_MS = 1_500
const MIN_BOOT_CHARS = 24

export type InitialInputDecision = 'wait' | 'send' | 'abort'

export function stripTerminalControl(text: string): string {
  return text.replace(CSI_OR_OSC, '').replace(/\x1b./g, '')
}

export function isCliReadyForInitialInput(
  agent: AgentType | null | undefined,
  bootText: string,
): boolean {
  const patterns = agent ? READY_PATTERNS[agent] : undefined
  if (!patterns?.length) return false
  const text = stripTerminalControl(bootText)
  return patterns.some((pattern) => pattern.test(text))
}

export type InitialInputWaitInput = {
  agent: AgentType | null | undefined
  now: number
  startedAt: number
  lastIoAt: number
  alive: boolean
  bootText: string
}

export function shouldFlushInitialPtyInput(decision: InitialInputDecision): boolean {
  return decision === 'send'
}

function isBlockedBoot(agent: AgentType | null | undefined, bootText: string): boolean {
  const text = stripTerminalControl(bootText)
  if (isAgentAuthError(text)) return true
  if (isCliReadyForInitialInput(agent, bootText)) return false
  return isAgentLoginBlock(text)
}

/**
 * Gemini (and similar TUIs) are quiet before the splash. Sending on "quiet for
 * 700ms" dumps Auto bootstrap into the boot scrollback instead of the composer.
 * Login and auth-error screens must never receive the worker prompt. Missing a
 * ready marker after the fallback must still send — the composer strings drift
 * across CLI versions and aborting leaves panes idle.
 */
export function shouldSendInitialPtyInput(input: InitialInputWaitInput): InitialInputDecision {
  if (!input.alive) return 'wait'
  if (isBlockedBoot(input.agent, input.bootText)) return 'abort'

  const elapsed = input.now - input.startedAt
  const quietFor = input.now - input.lastIoAt
  const agent = input.agent ?? 'shell'
  const fallbackMs = agent === 'gemini' ? GEMINI_FALLBACK_MS : DEFAULT_FALLBACK_MS
  if (elapsed >= fallbackMs) return 'send'

  if (isCliReadyForInitialInput(agent, input.bootText)) {
    return quietFor >= SETTLE_AFTER_READY_MS ? 'send' : 'wait'
  }

  if (agent === 'gemini') return 'wait'

  const visibleBoot = stripTerminalControl(input.bootText).trim()
  if (visibleBoot.length < MIN_BOOT_CHARS) return 'wait'
  if (elapsed >= EARLIEST_WITHOUT_MARKER_MS && quietFor >= QUIET_WITHOUT_MARKER_MS) return 'send'
  return 'wait'
}
