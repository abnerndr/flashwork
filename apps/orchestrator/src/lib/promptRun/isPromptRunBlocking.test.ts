import { describe, expect, it } from 'vitest'

import { isPromptRunBlocking } from './isPromptRunBlocking'

describe('isPromptRunBlocking', () => {
  it('blocks a live running pane', () => {
    expect(isPromptRunBlocking('running', 'term-1', ['term-1', 'term-2'])).toBe(true)
  })

  it('does not block a running run whose terminal is gone', () => {
    expect(isPromptRunBlocking('running', 'term-gone', ['term-2'])).toBe(false)
  })

  it('does not block cancelled or done runs', () => {
    expect(isPromptRunBlocking('cancelled', 'term-1', ['term-1'])).toBe(false)
    expect(isPromptRunBlocking('done', 'term-1', ['term-1'])).toBe(false)
  })

  it('blocks when live terminals are unknown so a real in-memory run stays exclusive', () => {
    expect(isPromptRunBlocking('running', 'term-1')).toBe(true)
  })
})
