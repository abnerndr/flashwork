import { nanoid } from 'nanoid'

import {
  createProjectInFolder,
  openExistingProject,
  type NewProjectRegistration,
} from '../components/modals/NewProjectModal.logic'
import { bootstrapProjectRag } from './projectRagBootstrap'
import {
  aiMemoryMcpConfigPath,
  graphifyEnsureGraph,
  projectBootstrap,
  projectDetect,
  projectWriteRagStatus,
} from './tauri'
import type { Project } from './types'
import { useProjectsStore } from '../stores/projectsStore'

function bootstrapFolderRag(folder: string): Promise<void> {
  const features = useProjectsStore.getState().preferences.enabledFeatures
  return bootstrapProjectRag(folder, {
    graphifyEnabled: features.graphify,
    aiMemoryEnabled: features.aiMemory,
    graphifyEnsureGraph,
    aiMemoryMcpConfigPath,
    writeRagStatus: projectWriteRagStatus,
  }).then(() => undefined)
}

/** Bootstrap a new home or register the existing `.flashwork` id. RAG is fire-and-forget. */
export async function registerOrOpenFolderProject(
  registration: NewProjectRegistration,
): Promise<Project | null> {
  const createProject = (args: NewProjectRegistration) =>
    useProjectsStore.getState().createProject(args)

  const created = await createProjectInFolder(registration, {
    generateId: nanoid,
    projectBootstrap,
    bootstrapRag: bootstrapFolderRag,
    createProject,
  })
  if (created.kind === 'stale') return null
  if (created.kind === 'created') return created.project

  return openExistingProject(registration, {
    projectDetect,
    findProject: (id) => useProjectsStore.getState().projects.find((item) => item.id === id),
    createProject,
  })
}
