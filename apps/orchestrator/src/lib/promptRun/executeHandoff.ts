import { getLocale, translate } from '../i18n'
import {
  type HandoffArtifact,
  type HandoffDraft,
  type HandoffProvider,
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

export function looksLikeFilesystemPath(path: string): boolean {
  if (!path) return false
  if (path.startsWith('/')) return true
  if (path.startsWith('\\\\')) return true
  return /^[A-Za-z]:[\\/]/.test(path)
}

export function buildFallbackBootstrap(journalPath: string, prompt: string): string {
  if (looksLikeFilesystemPath(journalPath)) {
    return `Read the run journal at "${journalPath}" and continue this user request.\n\n${prompt}`
  }
  return `Continue this user request.\n\n${prompt}`
}

export type ExecuteAutoHandoffInput = {
  source: HandoffProvider
  target: HandoffProvider
  sourceSessionId?: string
  cwd: string
  extraArgs?: string[]
  paneName: string
  journalPath: string
  prompt: string
  bootstrapForCapsule?: (path: string) => string
}

export type ExecuteAutoHandoffDeps = {
  prepareAgentHandoff?: typeof prepareAgentHandoff
  materializeAgentHandoff?: typeof materializeAgentHandoff
  bootstrapForCapsule?: (path: string) => string
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

function syntheticDraft(
  input: ExecuteAutoHandoffInput,
  bootstrap: string,
): HandoffDraft {
  return {
    sourceProvider: input.source,
    targetProvider: input.target,
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

export async function executeAutoHandoff(
  input: ExecuteAutoHandoffInput,
  deps: ExecuteAutoHandoffDeps = {},
): Promise<ExecuteAutoHandoffResult> {
  const prepare = deps.prepareAgentHandoff ?? prepareAgentHandoff
  const materialize = deps.materializeAgentHandoff ?? materializeAgentHandoff
  const bootstrapForCapsule =
    deps.bootstrapForCapsule ?? input.bootstrapForCapsule ?? defaultCapsuleBootstrap

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
    const bootstrap = buildFallbackBootstrap(input.journalPath, input.prompt)
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
}
