import { describe, expect, it, vi } from 'vitest'

import { readErrorPlacement, resolveFailedOpen, shouldCloseBuffer } from './editorPaneLogic'

describe('shouldCloseBuffer', () => {
  it('closes a clean buffer without prompting', () => {
    const confirmDiscard = vi.fn(() => false)
    expect(shouldCloseBuffer({ value: 'a', savedValue: 'a' }, confirmDiscard)).toBe(true)
    expect(confirmDiscard).not.toHaveBeenCalled()
  })

  it('closes when there is no buffer', () => {
    expect(shouldCloseBuffer(undefined, () => false)).toBe(true)
  })

  it('keeps a dirty buffer when the user cancels', () => {
    const confirmDiscard = vi.fn(() => false)
    expect(shouldCloseBuffer({ value: 'edited', savedValue: 'saved' }, confirmDiscard)).toBe(false)
    expect(confirmDiscard).toHaveBeenCalledOnce()
  })

  it('closes a dirty buffer when the user confirms', () => {
    expect(shouldCloseBuffer({ value: 'edited', savedValue: 'saved' }, () => true)).toBe(true)
  })
})

describe('resolveFailedOpen', () => {
  it('toasts a too-large file without attaching the error to another active buffer', () => {
    const result = resolveFailedOpen({
      failedRel: 'assets/huge.bin',
      message: 'too large',
      tooLarge: true,
      activeRel: 'src/a.ts',
    })
    expect(result.openBuffer).toBe(false)
    expect(result.readError).toBeNull()
    expect(result.toast).toBe(true)
  })

  it('shows an inline error when a too-large file is opened with no active buffer', () => {
    const result = resolveFailedOpen({
      failedRel: 'assets/huge.bin',
      message: 'too large',
      tooLarge: true,
      activeRel: null,
    })
    expect(result.openBuffer).toBe(false)
    expect(result.readError).toEqual({ rel: 'assets/huge.bin', message: 'too large' })
    expect(result.toast).toBe(false)
  })

  it('ties a generic read failure to the failed rel', () => {
    const result = resolveFailedOpen({
      failedRel: 'src/missing.ts',
      message: 'could not read',
      tooLarge: false,
      activeRel: 'src/a.ts',
    })
    expect(result.openBuffer).toBe(false)
    expect(result.readError).toEqual({ rel: 'src/missing.ts', message: 'could not read' })
    expect(result.toast).toBe(true)
  })
})

describe('readErrorPlacement', () => {
  it('does not banner a different open file', () => {
    expect(readErrorPlacement({ rel: 'assets/huge.bin', message: 'too large' }, 'src/a.ts')).toBe(
      'none',
    )
  })

  it('shows inline when no file is active', () => {
    expect(readErrorPlacement({ rel: 'assets/huge.bin', message: 'too large' }, null)).toBe('inline')
  })

  it('banners only when the error belongs to the active tab', () => {
    expect(readErrorPlacement({ rel: 'src/a.ts', message: 'could not read' }, 'src/a.ts')).toBe(
      'banner',
    )
  })
})
