import { invoke } from '@tauri-apps/api/core'

export function ensurePromptRunContext(runId: string): Promise<string> {
  return invoke('ensure_prompt_run_context', { runId })
}

export function ingestRunContext(
  runId: string,
  source: string,
  sessionId: string,
  cwd: string,
): Promise<string> {
  return invoke('ingest_run_context', { runId, source, sessionId, cwd })
}

export function searchRunContext(
  runId: string,
  terms: string[],
  file?: string,
): Promise<string[]> {
  return invoke('search_run_context', { runId, file, terms })
}
