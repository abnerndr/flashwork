import { describe, expect, it } from 'vitest'

import { classifyTask, classifyTaskKinds } from './classifyTask'

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

  it('classifies UI and visual work', () => {
    expect(classifyTask('restyle the settings screen and fix the CSS of the modal')).toBe('ui')
    expect(classifyTask('arrume o layout da tela de configurações e o botão')).toBe('ui')
  })

  it('classifies Portuguese implementation language', () => {
    expect(classifyTask('implementar login com OAuth')).toBe('implement')
  })

  it('lists every matching kind so Auto can split the work', () => {
    expect(classifyTaskKinds('implement login and generate unit tests for the parser')).toEqual([
      'implement',
      'mechanical',
    ])
    expect(classifyTaskKinds('implementar o login e gerar testes unitários')).toEqual([
      'implement',
      'mechanical',
    ])
    expect(classifyTaskKinds('hello')).toEqual([])
    expect(classifyTaskKinds('restyle the settings screen')).toEqual(['ui'])
  })
})
