import { describe, expect, it } from 'vitest'

import { parseBoardDrop } from './boardDnd'

describe('parseBoardDrop', () => {
  it('reads a card dropped onto a column', () => {
    expect(parseBoardDrop('card:abc', 'col:todo')).toEqual({ cardId: 'abc', column: 'todo' })
  })

  it('ignores a drop outside any column', () => {
    expect(parseBoardDrop('card:abc', null)).toBeNull()
    expect(parseBoardDrop('card:abc', 'col:nope')).toBeNull()
    expect(parseBoardDrop('pane:1', 'col:todo')).toBeNull()
  })
})
