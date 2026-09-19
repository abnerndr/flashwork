import { invoke } from '@tauri-apps/api/core'

import type { PromptRun } from '../types'

export function savePromptRun(run: PromptRun): Promise<void> {
  return invoke('save_prompt_run', { run })
}

export function loadPromptRun(runId: string): Promise<PromptRun | null> {
  return invoke('load_prompt_run', { runId })
}

export function listPromptRuns(projectId: string): Promise<PromptRun[]> {
  return invoke('list_prompt_runs', { projectId })
}

export function appendPromptRunJournal(
  runId: string,
  heading: string,
  body: string,
): Promise<string> {
  return invoke('append_prompt_run_journal', { runId, heading, body })
}

export function writePromptRunBoard(runId: string, contents: string): Promise<string> {
  return invoke('write_prompt_run_board', { runId, contents })
}

export function writePromptRunFile(
  runId: string,
  fileName: string,
  contents: string,
): Promise<string> {
  return invoke('write_prompt_run_file', { runId, fileName, contents })
}

export function appendPromptRunBoard(
  runId: string,
  heading: string,
  body: string,
): Promise<string> {
  return invoke('append_prompt_run_board', { runId, heading, body })
}
