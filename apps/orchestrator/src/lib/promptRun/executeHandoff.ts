import { getLocale, translate } from '../i18n'
import {
  type HandoffArtifact,
  type HandoffDraft,
  type HandoffProvider,
  loadPromptRun,
  materializeAgentHandoff,
  prepareAgentHandoff,
} from '../tauri'
import type { AgentHandoffBootstrap, AgentType } from '../types'

export type HandoffTerminalArgs = {
  name: string
  cwd: string
  firstTab: {
    type: AgentType
    cwd: string
    extraArgs?: string[]
    initialInput?: string
    handoff?: AgentHandoffBootstrap
  }
}

export type BuildHandoffTerminalArgsInput = {
  target: AgentType
  cwd: string
  bootstrap: string
  extraArgs?: string[]
  handoff?: AgentHandoffBootstrap
  paneName: string
}

export function buildHandoffTerminalArgs(input: BuildHandoffTerminalArgsInput): HandoffTerminalArgs {
  return {
    name: input.paneName,
    cwd: input.cwd,
    firstTab: {
      type: input.target,
      cwd: input.cwd,
      extraArgs: input.extraArgs ?? [],
      initialInput: input.bootstrap,
      handoff: input.handoff,
    },
  }
}

export function stripVerbatimPrefix(path: string): string {
  return path.replace(/^\\\\\?\\/, '')
}

export function looksLikeFilesystemPath(path: string): boolean {
  if (!path) return false
  const normalized = stripVerbatimPrefix(path)
  if (normalized.startsWith('/')) return true
  if (normalized.startsWith('\\\\')) return true
  return /^[A-Za-z]:[\\/]/.test(normalized)
}

export function buildFallbackBootstrap(
  journalPath: string | undefined,
  prompt: string,
  note?: string,
): string {
  const prefix = note?.trim() ? `${note.trim()}\n\n` : ''
  if (journalPath && looksLikeFilesystemPath(journalPath)) {
    const absolute = stripVerbatimPrefix(journalPath)
    return `${prefix}Read the run journal at "${absolute}" and continue this user request.\n\n${prompt}`
  }
  return `${prefix}Continue this user request.\n\n${prompt}`
}

function isCapsuleProvider(agent: AgentType): agent is HandoffProvider {
  return agent === 'claude' || agent === 'codex'
}

export type ExecuteAutoHandoffInput = {
  source: AgentType
  target: AgentType
  sourceSessionId?: string
  cwd: string
  extraArgs?: string[]
  paneName: string
  runId?: string
  journalPath?: string
  prompt: string
  errorNote?: string
  bootstrapForCapsule?: (path: string) => string
}

export type LoadPromptRunJournal = (runId: string) => Promise<{ journalPath: string } | null>

export type ExecuteAutoHandoffDeps = {
  prepareAgentHandoff?: typeof prepareAgentHandoff
  materializeAgentHandoff?: typeof materializeAgentHandoff
  bootstrapForCapsule?: (path: string) => string
  loadPromptRun?: LoadPromptRunJournal
}

export type ExecuteAutoHandoffResult = {
  draft: HandoffDraft
  artifact: HandoffArtifact | null
  terminalArgs: HandoffTerminalArgs
  usedFallback: boolean
}

function defaultCapsuleBootstrap(path: string): string {
  return translate(getLocale(), 'handoff.bootstrapPrompt', { path })
}

async function resolveJournalPath(
  input: ExecuteAutoHandoffInput,
  load: LoadPromptRunJournal,
): Promise<string | undefined> {
  if (input.journalPath && looksLikeFilesystemPath(input.journalPath)) {
    return stripVerbatimPrefix(input.journalPath)
  }
  if (!input.runId) return undefined
  try {
    const loaded = await load(input.runId)
    if (loaded?.journalPath && looksLikeFilesystemPath(loaded.journalPath)) {
      return stripVerbatimPrefix(loaded.journalPath)
    }
  } catch {
    return undefined
  }
  return undefined
}

function syntheticDraft(input: ExecuteAutoHandoffInput, bootstrap: string): HandoffDraft {
  return {
    sourceProvider: isCapsuleProvider(input.source) ? input.source : 'claude',
    targetProvider: isCapsuleProvider(input.target) ? input.target : 'claude',
    sourceSessionId: input.sourceSessionId ?? '',
    cwd: input.cwd,
    title: 'Fallback handoff',
    content: bootstrap,
    includedEventCount: 0,
    omittedEventCount: 0,
    redactionCount: 0,
    usedFallback: true,
  }
}

async function fallbackHandoff(
  input: ExecuteAutoHandoffInput,
  load: LoadPromptRunJournal,
  prepared: HandoffDraft | null,
): Promise<ExecuteAutoHandoffResult> {
  const journalPath = await resolveJournalPath(input, load)
  const bootstrap = buildFallbackBootstrap(journalPath, input.prompt, input.errorNote)
  return {
    draft: prepared ?? syntheticDraft(input, bootstrap),
    artifact: null,
    usedFallback: true,
    terminalArgs: buildHandoffTerminalArgs({
      target: input.target,
      cwd: input.cwd,
      bootstrap,
      extraArgs: input.extraArgs,
      paneName: input.paneName,
    }),
  }
}

export async function executeAutoHandoff(
  input: ExecuteAutoHandoffInput,
  deps: ExecuteAutoHandoffDeps = {},
): Promise<ExecuteAutoHandoffResult> {
  const prepare = deps.prepareAgentHandoff ?? prepareAgentHandoff
  const materialize = deps.materializeAgentHandoff ?? materializeAgentHandoff
  const load = deps.loadPromptRun ?? loadPromptRun
  const bootstrapForCapsule =
    deps.bootstrapForCapsule ?? input.bootstrapForCapsule ?? defaultCapsuleBootstrap

  if (!isCapsuleProvider(input.source) || !isCapsuleProvider(input.target)) {
    return fallbackHandoff(input, load, null)
  }

  let prepared: HandoffDraft | null = null
  try {
    prepared = await prepare({
      sourceProvider: input.source,
      targetProvider: input.target,
      sourceSessionId: input.sourceSessionId,
      cwd: input.cwd,
    })
    const artifact = await materialize(prepared.content)
    return {
      draft: prepared,
      artifact,
      usedFallback: false,
      terminalArgs: buildHandoffTerminalArgs({
        target: input.target,
        cwd: input.cwd,
        bootstrap: bootstrapForCapsule(artifact.contextPath),
        extraArgs: input.extraArgs,
        paneName: input.paneName,
        handoff: {
          id: artifact.handoffId,
          contextDir: artifact.contextDir,
          contextPath: artifact.contextPath,
          sourceProvider: input.source,
          sourceSessionId: prepared.sourceSessionId,
        },
      }),
    }
  } catch {
    return fallbackHandoff(input, load, prepared)
  }
}
