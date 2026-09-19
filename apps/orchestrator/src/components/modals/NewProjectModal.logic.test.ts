import { describe, expect, it, vi } from 'vitest'

import type { Project } from '../../lib/types'
import {
  clearedNewProjectConflictState,
  createProjectInFolder,
  isProjectFolderMissing,
  openExistingProject,
  shouldApplySubmitResult,
  type NewProjectRegistration,
} from './NewProjectModal.logic'

function project(id: string): Project {
  return {
    id,
    name: 'Example',
    groupId: null,
    defaultCwd: '/workspace/example',
    terminals: [],
    layoutMode: 'auto',
    collapsed: false,
    createdAt: 1,
  }
}

const registration: NewProjectRegistration = {
  name: 'Example',
  mode: 'standard',
  color: '#ffffff',
  groupId: null,
  defaultCwd: '  /workspace/example  ',
}

describe('new project folder flow', () => {
  it('only applies the current submit result', () => {
    expect(shouldApplySubmitResult(2, 2)).toBe(true)
    expect(shouldApplySubmitResult(1, 2)).toBe(false)
  })

  it('requires a non-empty destination folder', () => {
    expect(isProjectFolderMissing('')).toBe(true)
    expect(isProjectFolderMissing('   ')).toBe(true)
    expect(isProjectFolderMissing('/workspace/example')).toBe(false)
  })

  it('bootstraps the folder before registering the project', async () => {
    const calls: string[] = []
    const created = project('generated-id')
    const result = await createProjectInFolder(registration, {
      generateId: () => 'generated-id',
      projectBootstrap: async (folder, id) => {
        calls.push(`bootstrap:${folder}:${id}`)
        return `${folder}/.flashwork`
      },
      createProject: (args) => {
        calls.push(`create:${args.defaultCwd}:${args.id}`)
        return created
      },
    })

    expect(result).toEqual({ kind: 'created', project: created })
    expect(calls).toEqual([
      'bootstrap:/workspace/example:generated-id',
      'create:/workspace/example:generated-id',
    ])
  })

  it('registers the project before fire-and-forget RAG and does not wait on it', async () => {
    const calls: string[] = []
    const created = project('generated-id')
    let releaseRag!: () => void
    const ragReleased = new Promise<void>((resolve) => {
      releaseRag = resolve
    })
    let ragStarted!: () => void
    const ragBegan = new Promise<void>((resolve) => {
      ragStarted = resolve
    })

    const result = await createProjectInFolder(registration, {
      generateId: () => 'generated-id',
      projectBootstrap: async (folder, id) => {
        calls.push(`bootstrap:${folder}:${id}`)
        return `${folder}/.flashwork`
      },
      bootstrapRag: async (folder) => {
        ragStarted()
        await ragReleased
        calls.push(`rag:${folder}`)
        throw new Error('graphify unavailable')
      },
      createProject: (args) => {
        calls.push(`create:${args.defaultCwd}:${args.id}`)
        return created
      },
    })

    expect(result).toEqual({ kind: 'created', project: created })
    expect(calls).toEqual([
      'bootstrap:/workspace/example:generated-id',
      'create:/workspace/example:generated-id',
    ])
    await ragBegan
    expect(calls).not.toContain('rag:/workspace/example')
    releaseRag()
    await Promise.resolve()
    expect(calls).toEqual([
      'bootstrap:/workspace/example:generated-id',
      'create:/workspace/example:generated-id',
      'rag:/workspace/example',
    ])
  })

  it('does not bootstrap RAG when the folder already belongs to another project', async () => {
    const bootstrapRag = vi.fn()
    const result = await createProjectInFolder(registration, {
      generateId: () => 'generated-id',
      projectBootstrap: async () => {
        throw new Error('flashwork_exists:existing-id')
      },
      bootstrapRag,
      createProject: vi.fn(),
    })

    expect(result).toEqual({ kind: 'flashworkExists' })
    expect(bootstrapRag).not.toHaveBeenCalled()
  })

  it('offers the existing-project path without registering a new id', async () => {
    const createProject = vi.fn()
    const result = await createProjectInFolder(registration, {
      generateId: () => 'generated-id',
      projectBootstrap: async () => {
        throw new Error('flashwork_exists:existing-id')
      },
      createProject,
    })

    expect(result).toEqual({ kind: 'flashworkExists' })
    expect(createProject).not.toHaveBeenCalled()
  })

  it('does not register a project when the bootstrap result is stale', async () => {
    const createProject = vi.fn()
    const result = await createProjectInFolder(registration, {
      generateId: () => 'generated-id',
      projectBootstrap: async () => '/workspace/example/.flashwork',
      createProject,
      shouldApplyResult: () => false,
    })

    expect(result).toEqual({ kind: 'stale' })
    expect(createProject).not.toHaveBeenCalled()
  })

  it('clears flashwork_exists conflict flags on modal reset', async () => {
    const createProject = vi.fn()
    const result = await createProjectInFolder(registration, {
      generateId: () => 'generated-id',
      projectBootstrap: async () => {
        throw new Error('flashwork_exists:existing-id')
      },
      createProject,
    })

    expect(result).toEqual({ kind: 'flashworkExists' })

    const afterReset = clearedNewProjectConflictState()
    expect(afterReset.flashworkExists).toBe(false)
    expect(afterReset.folderMissing).toBe(false)
    expect(afterReset.operationError).toBe('')
  })

  it('registers the detected id when opening an existing folder', async () => {
    const detected = project('existing-id')
    const createProject = vi.fn(() => detected)

    const result = await openExistingProject(registration, {
      projectDetect: async () => ({
        id: 'existing-id',
        createdAt: '1970-01-01T00:00:00Z',
        schemaVersion: 1,
      }),
      findProject: () => undefined,
      createProject,
    })

    expect(result).toBe(detected)
    expect(createProject).toHaveBeenCalledWith({
      ...registration,
      id: 'existing-id',
      defaultCwd: '/workspace/example',
    })
  })

  it('activates an already registered detected id without duplicating it', async () => {
    const existing = project('existing-id')
    const createProject = vi.fn()

    const result = await openExistingProject(registration, {
      projectDetect: async () => ({
        id: 'existing-id',
        createdAt: '1970-01-01T00:00:00Z',
        schemaVersion: 1,
      }),
      findProject: (id) => (id === existing.id ? existing : undefined),
      createProject,
    })

    expect(result).toBe(existing)
    expect(createProject).not.toHaveBeenCalled()
  })
})
