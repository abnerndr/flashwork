import { describe, expect, it } from 'vitest'

import { insertTextAtCaret } from './clipboardPaste'

describe('insertTextAtCaret', () => {
  it('inserts at the caret and moves selection after the insert', () => {
    const input = document.createElement('input')
    input.value = 'ab'
    input.setSelectionRange(1, 1)
    insertTextAtCaret(input, 'X')
    expect(input.value).toBe('aXb')
    expect(input.selectionStart).toBe(2)
    expect(input.selectionEnd).toBe(2)
  })

  it('replaces the current selection', () => {
    const input = document.createElement('input')
    input.value = 'hello'
    input.setSelectionRange(1, 4)
    insertTextAtCaret(input, 'i')
    expect(input.value).toBe('hio')
    expect(input.selectionStart).toBe(2)
  })
})
