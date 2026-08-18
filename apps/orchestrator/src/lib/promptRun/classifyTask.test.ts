import { describe, expect, it } from 'vitest'

import { classifyTask } from './classifyTask'

describe('classifyTask', () => {
  it('classifies implementation language as implement', () => {
    expect(classifyTask('refactor the auth middleware and add tests')).toBe('implement')
    expect(classifyTask('implement login with OAuth')).toBe('implement')
  })

  it('classifies review language as review', () => {
    expect(classifyTask('review this PR for security issues')).toBe('review')
    expect(classifyTask('audit the payment flow')).toBe('review')
  })

  it('classifies mechanical language as mechanical', () => {
    expect(classifyTask('run the test suite and fix failures')).toBe('mechanical')
    expect(classifyTask('generate unit tests for src/lib/paths.ts')).toBe('mechanical')
  })

  it('classifies exploration language as explore', () => {
    expect(classifyTask('explain how the PTY spawn path works')).toBe('explore')
    expect(classifyTask('what does projectsStore persist?')).toBe('explore')
  })

  it('returns unknown when nothing matches', () => {
    expect(classifyTask('hello')).toBe('unknown')
  })
})
