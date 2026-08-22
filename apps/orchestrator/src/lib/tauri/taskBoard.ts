import { invoke } from '@tauri-apps/api/core'

import type { TaskCard } from '../types'

export function saveTaskCard(card: TaskCard): Promise<void> {
  return invoke('save_task_card', { card })
}

export function listTaskCards(projectId?: string): Promise<TaskCard[]> {
  return invoke('list_task_cards', { projectId: projectId ?? null })
}

export function deleteTaskCard(cardId: string): Promise<void> {
  return invoke('delete_task_card', { cardId })
}

export function runPlannerCli(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs = 22_000,
): Promise<string> {
  return invoke('run_planner_cli', { bin, args, cwd, timeoutMs })
}
