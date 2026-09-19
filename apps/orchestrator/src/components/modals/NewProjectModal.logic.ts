import type { Project } from '../../lib/types'
import type { ProjectHomeMeta } from '../../lib/tauri'

export type NewProjectRegistration = {
  id?: string
  name: string
  mode?: Project['mode']
  color?: string
  iconUrl?: string
  groupId?: string | null
  defaultCwd: string
}

type CreateProject = (args: NewProjectRegistration) => Project

export function isProjectFolderMissing(folder: string): boolean {
  return !folder.trim()
}

export type NewProjectConflictState = {
  folderMissing: boolean
  flashworkExists: boolean
  operationError: string
}

export function clearedNewProjectConflictState(): NewProjectConflictState {
  return {
    folderMissing: false,
    flashworkExists: false,
    operationError: '',
  }
}

export async function createProjectInFolder(
  registration: NewProjectRegistration,
  dependencies: {
    generateId: () => string
    projectBootstrap: (folder: string, projectId: string) => Promise<string>
    createProject: CreateProject
  },
): Promise<{ kind: 'created'; project: Project } | { kind: 'flashworkExists' }> {
  const folder = registration.defaultCwd.trim()
  const id = dependencies.generateId()

  try {
    await dependencies.projectBootstrap(folder, id)
  } catch (error) {
    if (String(error).includes('flashwork_exists')) return { kind: 'flashworkExists' }
    throw error
  }

  const project = dependencies.createProject({
    ...registration,
    id,
    defaultCwd: folder,
  })
  return { kind: 'created', project }
}

export async function openExistingProject(
  registration: NewProjectRegistration,
  dependencies: {
    projectDetect: (folder: string) => Promise<ProjectHomeMeta | null>
    findProject: (id: string) => Project | undefined
    createProject: CreateProject
  },
): Promise<Project> {
  const folder = registration.defaultCwd.trim()
  const meta = await dependencies.projectDetect(folder)
  if (!meta) throw new Error('flashwork_project_not_found')

  const existing = dependencies.findProject(meta.id)
  if (existing) return existing

  return dependencies.createProject({
    ...registration,
    id: meta.id,
    defaultCwd: folder,
  })
}
