import { invoke } from '@tauri-apps/api/core'
import { invokeWithWsl } from './invokeWithWsl'

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

export function writePromptRunFile(
  runId: string,
  fileName: string,
  contents: string,
): Promise<string> {
  return invoke('write_prompt_run_file', { runId, fileName, contents })
}

export function readPromptRunFile(runId: string, fileName: string): Promise<string> {
  return invoke('read_prompt_run_file', { runId, fileName })
}


/** Reads a user-picked SPEC markdown file (`.md`/`.markdown`/`.mdx`, at most 1 MiB). */
export function readSpecMarkdown(path: string): Promise<string> {
  return invoke('read_spec_markdown', { path })
}

/** Writes `<cwd>/.flashwork/runs/<runId>/board.md`; resolves to the project-relative path. */
export function writeProjectRunBoard(cwd: string, runId: string, contents: string): Promise<string> {
  return invoke('write_project_run_board', { cwd, runId, contents })
}

export function appendProjectRunBoard(
  cwd: string,
  runId: string,
  heading: string,
  body: string,
): Promise<string> {
  return invoke('append_project_run_board', { cwd, runId, heading, body })
}

/** Runs a planner CLI headless; `stdin` carries the long prompt. */
export function runPlannerCli(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  stdin?: string,
): Promise<string> {
  return invokeWithWsl('run_planner_cli', { bin, args, cwd, timeoutMs, stdin: stdin ?? null })
}
