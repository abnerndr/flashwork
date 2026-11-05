import { flattenInitialPtyInput, submitPtyLine } from '../../lib/ptySubmit'
import { readScopedStorage } from '../../lib/storageNamespace'
import { writePty } from '../../lib/tauri'
import type { AgentType } from '../../lib/types'

export { flattenInitialPtyInput, submitPtyLine }

export const PROMPT_HISTORY_KEY = (id: string) => `prompt-history:${id}`

// Keep IPC payloads bounded without turning a large paste into thousands of calls.
export const PASTE_CHUNK_SIZE = 64 * 1024
export const PASTE_YIELD_EVERY_CHUNKS = 4
export const MAX_TRACKED_PROMPT_LENGTH = 4 * 1024
export const PTY_WRITE_TIMEOUT_MS = 5_000
/** Pause between typing a bootstrap prompt and sending Enter (Linux/WSL Ink composers). */
export const PTY_SUBMIT_ENTER_DELAY_MS = 100
/**
 * Codex PasteBurst treats Enter as newline for ~120ms after a fast char stream
 * (`PASTE_ENTER_SUPPRESS_WINDOW`). Wait past that window before submitting.
 */
export const PTY_SUBMIT_ENTER_DELAY_CODEX_MS = 300
/** Prefer `codex [PROMPT]` over typing when the bootstrap fits (fresh sessions only). */
export const CODEX_ARGV_PROMPT_MAX_CHARS = 80_000

export function ptySubmitEnterDelayMs(agent?: AgentType | null): number {
  return agent === 'codex' ? PTY_SUBMIT_ENTER_DELAY_CODEX_MS : PTY_SUBMIT_ENTER_DELAY_MS
}

/** True when a fresh Codex pane should receive the bootstrap as a CLI positional prompt. */
export function shouldPassCodexPromptAsArgv(
  agent: AgentType | null | undefined,
  prompt: string,
  resumeId?: string | null,
): boolean {
  if (agent !== 'codex' || resumeId) return false
  const flat = flattenInitialPtyInput(prompt)
  return flat.length > 0 && flat.length <= CODEX_ARGV_PROMPT_MAX_CHARS
}

// muita cor/movimento) custam bem mais tempo de parse+render por byte do que

// terminar > qualquer frame individual travando por muito tempo.
export const TERMINAL_WRITE_FRAME_BUDGET = 16 * 1024

export function loadPromptHistory(ptyId: string): string[] {
  const raw = readScopedStorage(PROMPT_HISTORY_KEY(ptyId), true)
  if (!raw) return []
  const history = JSON.parse(raw) as string[]
  return history
}

export type PromptHistoryInputState = {
  currentLine: string
  overflow: boolean
  history: string[]
}

/** Prevents one blocked ConPTY write from holding every subsequent keystroke forever. */
export async function writePtyWithTimeout(id: string, data: string): Promise<void> {
  let timeoutId: number | null = null
  try {
    await Promise.race([
      writePty(id, data),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(() => {
          reject(new Error(`PTY write timed out after ${PTY_WRITE_TIMEOUT_MS} ms`))
        }, PTY_WRITE_TIMEOUT_MS)
      }),
    ])
  } finally {
    if (timeoutId !== null) window.clearTimeout(timeoutId)
  }
}

/** Updates lightweight command history without retaining or scanning large pasted documents. */
export function applyPromptHistoryInput(
  state: PromptHistoryInputState,
  data: string,
  onSubmit?: (line: string) => void,
): boolean {
  if (data.length > MAX_TRACKED_PROMPT_LENGTH) {
    state.currentLine = ''
    state.overflow = !data.endsWith('\r') && !data.endsWith('\n')
    return false
  }

  let historyChanged = false
  for (const character of data) {
    if (character === '\r' || character === '\n') {
      const line = state.overflow ? '' : state.currentLine.trim()
      state.currentLine = ''
      state.overflow = false
      onSubmit?.(line)
      if (line.length < 2 || state.history[state.history.length - 1] === line) continue
      state.history.push(line)
      if (state.history.length > 50) state.history.shift()
      historyChanged = true
    } else if (character === '\b' || character === '\x7f') {
      if (!state.overflow) state.currentLine = state.currentLine.slice(0, -1)
    } else if (character === '\x15') {
      state.currentLine = ''
      state.overflow = false
    } else if (character >= ' ' && !state.overflow) {
      if (state.currentLine.length < MAX_TRACKED_PROMPT_LENGTH) {
        state.currentLine += character
      } else {
        state.currentLine = ''
        state.overflow = true
      }
    }
  }
  return historyChanged
}

/**
 * Types a bootstrap prompt and submits it. Never wraps the line in bracketed paste.
 * Enter is a separate write: Ink-based CLIs on Linux/WSL often leave a trailing `\r`
 * sitting in the composer when it arrives in the same PTY payload as a long prompt.
 * Codex needs a longer pause — its PasteBurst treats Enter as newline for ~120ms after
 * a rapid character stream.
 */
export async function writePtySubmitText(
  id: string,
  text: string,
  options?: { agent?: AgentType | null },
): Promise<void> {
  const body = flattenInitialPtyInput(text)
  if (!body) return

  let index = 0
  let chunkCount = 0
  while (index < body.length) {
    let end = Math.min(index + PASTE_CHUNK_SIZE, body.length)
    if (
      end < body.length &&
      body.charCodeAt(end - 1) >= 0xd800 &&
      body.charCodeAt(end - 1) <= 0xdbff &&
      body.charCodeAt(end) >= 0xdc00 &&
      body.charCodeAt(end) <= 0xdfff
    ) {
      end -= 1
    }
    await writePtyWithTimeout(id, body.slice(index, end))
    index = end
    chunkCount += 1
    if (index < body.length && chunkCount % PASTE_YIELD_EVERY_CHUNKS === 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 0))
    }
  }

  await new Promise((resolve) =>
    window.setTimeout(resolve, ptySubmitEnterDelayMs(options?.agent)),
  )
  await writePtyWithTimeout(id, '\r')
}

export async function writePtyChunked(id: string, text: string, bracketed: boolean): Promise<void> {
  const open = bracketed ? '\x1b[200~' : ''
  const close = bracketed ? '\x1b[201~' : ''

  if (text.length <= PASTE_CHUNK_SIZE) {
    await writePtyWithTimeout(id, `${open}${text}${close}`)
    return
  }

  let failure: unknown = null
  let opened = false
  try {
    if (open) {
      await writePtyWithTimeout(id, open)
      opened = true
    }
    let index = 0
    let chunkCount = 0
    while (index < text.length) {
      let end = Math.min(index + PASTE_CHUNK_SIZE, text.length)
      // Never split a UTF-16 surrogate pair across IPC calls.
      if (
        end < text.length &&
        text.charCodeAt(end - 1) >= 0xd800 &&
        text.charCodeAt(end - 1) <= 0xdbff &&
        text.charCodeAt(end) >= 0xdc00 &&
        text.charCodeAt(end) <= 0xdfff
      ) {
        end -= 1
      }
      await writePtyWithTimeout(id, text.slice(index, end))
      index = end
      chunkCount += 1
      if (index < text.length && chunkCount % PASTE_YIELD_EVERY_CHUNKS === 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 0))
      }
    }
  } catch (error) {
    failure = error
  }

  // A missing closing marker leaves Claude/Codex stuck in bracketed-paste mode.
  if (opened && close) {
    try {
      await writePtyWithTimeout(id, close)
    } catch (error) {
      if (failure === null) failure = error
    }
  }
  if (failure !== null) throw failure
}
