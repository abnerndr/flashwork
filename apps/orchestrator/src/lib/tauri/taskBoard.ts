import { invoke } from '@tauri-apps/api/core'

import type { TaskCard } from '../types'

export type TaskBoardProjectFolder = {
  projectId: string
  folder: string
}

export function saveTaskCard(card: TaskCard): Promise<void> {
  return invoke('save_task_card', { card })
}

export function listTaskCards(
  projectId?: string,
  projectFolders?: TaskBoardProjectFolder[],
): Promise<TaskCard[]> {
  return invoke('list_task_cards', {
    projectId: projectId ?? null,
    projectFolders: projectFolders ?? null,
  })
}

export function deleteTaskCard(
  cardId: string,
  folder?: string,
  projectId?: string,
): Promise<void> {
  return invoke('delete_task_card', {
    cardId,
    folder: folder ?? null,
    projectId: projectId ?? null,
  })
}

export function runPlannerCli(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 22_000,
): Promise<string> {
  return invoke('run_planner_cli', { bin, args, cwd, timeoutMs })
}
