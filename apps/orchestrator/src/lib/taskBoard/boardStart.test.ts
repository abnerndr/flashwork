import { describe, expect, it } from 'vitest'

import {
  boardErrorMessageKey,
  decideBoardStartFailure,
  isIgnorableBoardIoError,
} from './boardStart'

describe('decideBoardStartFailure', () => {
  it('keeps the card in To do when another Auto run is occupying the project', () => {
    expect(decideBoardStartFailure('run-active')).toEqual({
      column: 'todo',
      error: 'run-active',
    })
  })

  it('blocks hard failures so the queue does not retry forever', () => {
    expect(decideBoardStartFailure('no-cwd').column).toBe('blocked')
    expect(decideBoardStartFailure('no-project').column).toBe('blocked')
    expect(decideBoardStartFailure('needs-install').column).toBe('blocked')
  })
})

describe('isIgnorableBoardIoError', () => {
  it('treats a missing Tauri command as optional board I/O', () => {
    expect(isIgnorableBoardIoError('command write_prompt_run_board not found')).toBe(true)
    expect(isIgnorableBoardIoError(new Error('prompt run not found'))).toBe(false)
  })
})

describe('boardErrorMessageKey', () => {
  it('maps start codes to i18n keys', () => {
    expect(boardErrorMessageKey('no-cwd')).toBe('taskBoard.error.noCwd')
    expect(boardErrorMessageKey('a random invoke dump')).toBeNull()
  })
})
