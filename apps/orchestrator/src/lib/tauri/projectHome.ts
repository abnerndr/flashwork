import { invoke } from '@tauri-apps/api/core'

import type { RagStatusJson } from '../projectRagBootstrap'

export type { RagStatusJson }

export type ProjectHomeMeta = {
  id: string
  createdAt: string
  schemaVersion: number
}

export async function projectBootstrap(folder: string, projectId: string): Promise<string> {
  return invoke<string>('project_bootstrap', { folder, projectId })
}

export async function projectDetect(folder: string): Promise<ProjectHomeMeta | null> {
  return invoke<ProjectHomeMeta | null>('project_detect', { folder })
}

export async function projectWriteRagStatus(
  folder: string,
  status: RagStatusJson,
): Promise<string> {
  return invoke<string>('project_write_rag_status', { folder, status })
}
