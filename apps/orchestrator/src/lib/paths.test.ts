import { describe, expect, it } from 'vitest'

import { basename, pathSegments, sameCwd } from './paths'

describe('pathSegments', () => {
  it('separa caminhos POSIX', () => {
    expect(pathSegments('/home/kauam/dev')).toEqual(['home', 'kauam', 'dev'])
  })

  it('separa caminhos Windows', () => {
    expect(pathSegments('D:\\projects\\flashwork')).toEqual(['D:', 'projects', 'flashwork'])
  })

  it('colapsa separadores repetidos', () => {
    expect(pathSegments('a//b\\c')).toEqual(['a', 'b', 'c'])
  })

  it('ignora separador final', () => {
    expect(pathSegments('/a/b/')).toEqual(['a', 'b'])
  })

  it('retorna array vazio para caminho vazio', () => {
    expect(pathSegments('')).toEqual([])
  })

  it('retorna array vazio para separador único', () => {
    expect(pathSegments('/')).toEqual([])
    expect(pathSegments('\\')).toEqual([])
  })

  it('aceita separadores mistos', () => {
    expect(pathSegments('C:\\dev/flashwork')).toEqual(['C:', 'dev', 'flashwork'])
  })
})

describe('basename', () => {
  it('retorna o último segmento', () => {
    expect(basename('/a/b')).toBe('b')
    expect(basename('D:\\projects\\flashwork')).toBe('flashwork')
  })

  it('retorna vazio para caminho vazio ou separador único', () => {
    expect(basename('')).toBe('')
    expect(basename('/')).toBe('')
    expect(basename('\\')).toBe('')
  })

  it('ignora separador final', () => {
    expect(basename('/a/b/')).toBe('b')
  })
})

describe('sameCwd', () => {
  it('normaliza separadores de caminhos Windows', () => {
    expect(sameCwd('C:\\dev\\flashwork', 'C:/dev/flashwork')).toBe(true)
  })

  it('normaliza caixa apenas para caminhos Windows', () => {
    expect(sameCwd('C:\\Dev\\Flashwork', 'c:\\dev\\flashwork')).toBe(true)
    expect(sameCwd('/home/User/Project', '/home/user/project')).toBe(false)
  })

  it('retorna false para caminhos diferentes', () => {
    expect(sameCwd('/a/b', '/a/c')).toBe(false)
    expect(sameCwd('C:\\dev\\a', 'C:\\dev\\b')).toBe(false)
  })
})
