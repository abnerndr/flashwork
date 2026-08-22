import { describe, expect, it } from 'vitest'

import {
  isCliReadyForInitialInput,
  shouldFlushInitialPtyInput,
  shouldSendInitialPtyInput,
} from './cliReadyForInput'

const GEMINI_READY = [
  'Gemini CLI v0.56.0',
  'Authenticated with gemini-api-key /auth',
  'auto-accept edits Shift+Tab to plan',
  '> Type your message or @path/to/file',
].join('\n')

const GEMINI_BOOT_ONLY = 'Gemini CLI v0.56.0\nAuthenticated with gemini-api-key /auth'

describe('isCliReadyForInitialInput', () => {
  it('treats Gemini as not ready until the composer placeholder appears', () => {
    expect(isCliReadyForInitialInput('gemini', '')).toBe(false)
    expect(isCliReadyForInitialInput('gemini', GEMINI_BOOT_ONLY)).toBe(false)
    expect(
      isCliReadyForInitialInput(
        'gemini',
        '[Flashwork Auto] You are a worker (Gemini) for run abc. Do the assigned slice.',
      ),
    ).toBe(false)
    expect(isCliReadyForInitialInput('gemini', GEMINI_READY)).toBe(true)
  })

  it('still matches Gemini when ANSI noise wraps the composer hint', () => {
    expect(
      isCliReadyForInitialInput('gemini', `\x1b[90m> \x1b[0mType your message or @path/to/file`),
    ).toBe(true)
  })
})

describe('shouldSendInitialPtyInput', () => {
  const startedAt = 1_000

  it('does not send into Gemini pre-splash silence', () => {
    expect(
      shouldSendInitialPtyInput({
        agent: 'gemini',
        now: startedAt + 2_000,
        startedAt,
        lastIoAt: startedAt,
        alive: true,
        bootText: '',
      }),
    ).toBe('wait')
  })

  it('does not send at the old 4s force-window while Gemini is still booting', () => {
    expect(
      shouldSendInitialPtyInput({
        agent: 'gemini',
        now: startedAt + 4_200,
        startedAt,
        lastIoAt: startedAt + 4_100,
        alive: true,
        bootText: GEMINI_BOOT_ONLY,
      }),
    ).toBe('wait')
  })

  it('sends after Gemini shows Type your message and the TUI goes quiet', () => {
    expect(
      shouldSendInitialPtyInput({
        agent: 'gemini',
        now: startedAt + 6_000,
        startedAt,
        lastIoAt: startedAt + 5_600,
        alive: true,
        bootText: GEMINI_READY,
      }),
    ).toBe('send')
  })

  it('waits a short settle even after the Gemini composer is visible', () => {
    expect(
      shouldSendInitialPtyInput({
        agent: 'gemini',
        now: startedAt + 6_000,
        startedAt,
        lastIoAt: startedAt + 5_950,
        alive: true,
        bootText: GEMINI_READY,
      }),
    ).toBe('wait')
  })

  it('sends to Claude after the fallback even when the shortcut hint never appears', () => {
    expect(
      shouldSendInitialPtyInput({
        agent: 'claude',
        now: startedAt + 12_500,
        startedAt,
        lastIoAt: startedAt + 8_000,
        alive: true,
        bootText: 'Claude Code v2.1\nBypassing Permissions\n❯ ',
      }),
    ).toBe('send')
  })

  it('sends once the composer is ready even if an earlier boot line mentioned sign-in', () => {
    expect(
      shouldSendInitialPtyInput({
        agent: 'claude',
        now: startedAt + 4_000,
        startedAt,
        lastIoAt: startedAt + 3_500,
        alive: true,
        bootText: ['Please sign in to continue', '? for shortcuts'].join('\n'),
      }),
    ).toBe('send')
  })

  it('sends to Gemini after the fallback when the composer placeholder never appears', () => {
    expect(
      shouldSendInitialPtyInput({
        agent: 'gemini',
        now: startedAt + 22_500,
        startedAt,
        lastIoAt: startedAt + 8_000,
        alive: true,
        bootText: GEMINI_BOOT_ONLY,
      }),
    ).toBe('send')
  })

  it('aborts when the TUI is on a login or auth-error screen', () => {
    expect(
      shouldSendInitialPtyInput({
        agent: 'codex',
        now: startedAt + 4_000,
        startedAt,
        lastIoAt: startedAt + 3_500,
        alive: true,
        bootText: 'Open https://github.com/login/device in your browser and enter the code',
      }),
    ).toBe('abort')
    expect(
      shouldSendInitialPtyInput({
        agent: 'gemini',
        now: startedAt + 6_000,
        startedAt,
        lastIoAt: startedAt + 5_600,
        alive: true,
        bootText: 'API key not valid. Please pass a valid API key. API_KEY_INVALID',
      }),
    ).toBe('abort')
  })
})

describe('shouldFlushInitialPtyInput', () => {
  it('only flushes when the waiter decided to send', () => {
    expect(shouldFlushInitialPtyInput('send')).toBe(true)
    expect(shouldFlushInitialPtyInput('wait')).toBe(false)
    expect(shouldFlushInitialPtyInput('abort')).toBe(false)
  })
})
