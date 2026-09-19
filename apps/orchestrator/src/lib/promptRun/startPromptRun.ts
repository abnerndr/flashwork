import { nanoid } from 'nanoid'

import { pickEffectiveCodingModel } from '../providers/catalogOverlay'
import type { ProviderId } from '../providers/modelCatalog'
import { CODING_TIMEOUT_MS, providerChat, type ChatMessage } from '../tauri/providers'
import { writeTextFile } from '../tauri/filesystem'
import {
  UNRESTRICTED_FLAG,
  type AgentType,
  type PromptRun,
  type PromptRunStatus,
  type PromptRunStep,
} from '../types'
import { buildRunBootstrapInput } from './bootstrapPrompt'
import {
  canonicalClaudeSessionId,
  canonicalClaudeTerminalId,
  rememberCanonicalClaude,
} from './claudeWriterLock'
import { isPromptRunBlocking } from './isPromptRunBlocking'
import { planAutoLanes, type AutoLane, type SkillCatalogEntry } from './planAutoLanes'
import { isApiAgentId, providerFromApiAgent, routedAgentLabel } from './routedAgent'

export type StartPromptRunResult =
  | { ok: true; run: PromptRun }
  | { ok: false; code: 'no-project' | 'no-cwd' | 'run-active' | 'needs-install' | 'needs-setup-api' }

export type StartPromptRunProject = {
  id: string
  name: string
  reviewAgentProvider?: AgentType
  conflictAgentProvider?: AgentType
  lastUsedAgent?: AgentType
}

export type CreateAgentTerminal = (
  projectId: string,
  args: {
    name: string
    cwd: string
    firstTab: {
      type: AgentType
      cwd: string
      extraArgs?: string[]
      initialInput?: string
      sessionId?: string
      sessionCreate?: boolean
    }
  },
) => Promise<{ id: string; sessionId?: string }>

export type StartPromptRunInput = {
  project: StartPromptRunProject | null
  cwd: string
  prompt: string
  unrestricted: boolean
  enabledAgents: AgentType[]
  installedAgents: AgentType[]
  claudeFiveHourUtilization: number | null
  codexRateLimited: boolean
  activeRunStatus?: PromptRunStatus
  activeTerminalId?: string
  activeRunTerminalIds?: readonly string[]
  liveTerminalIds?: readonly string[]
  skills?: SkillCatalogEntry[]
  lanes?: AutoLane[]
  includeOrchestrator?: boolean
  allowedFiles?: string[]
  boardPath?: string
  attachmentsDir?: string
  toolsJsonPath?: string
  createId?: () => string
  createUuid?: () => string
  now?: () => number
  ensureContextDir?: (runId: string) => Promise<string>
  createAgentTerminal: CreateAgentTerminal
  chat?: (
    provider: ProviderId,
    model: string,
    messages: ChatMessage[],
    timeoutMs: number,
  ) => Promise<{ text: string }>
  pickCodingModel?: (provider: ProviderId) => string
  writeApiReply?: (path: string, text: string) => Promise<void>
}

export type LaunchPromptRunLanesInput = {
  projectId: string
  cwd: string
  runId: string
  unrestricted: boolean
  lanes: AutoLane[]
  allowedFiles?: string[]
  boardPath?: string
  contextDir?: string
  attachmentsDir?: string
  toolsJsonPath?: string
  createUuid?: () => string
  now?: () => number
  createAgentTerminal: CreateAgentTerminal
  chat?: (
    provider: ProviderId,
    model: string,
    messages: ChatMessage[],
    timeoutMs: number,
  ) => Promise<{ text: string }>
  pickCodingModel?: (provider: ProviderId) => string
  writeApiReply?: (path: string, text: string) => Promise<void>
}

export async function launchPromptRunLanes(
  input: LaunchPromptRunLanesInput,
): Promise<PromptRunStep[]> {
  const createdAt = (input.now ?? Date.now)()
  const createUuid = input.createUuid ?? (() => crypto.randomUUID())
  const chat = input.chat ?? providerChat
  const pickCodingModel = input.pickCodingModel ?? pickEffectiveCodingModel
  const writeApiReply =
    input.writeApiReply ?? ((path: string, text: string) => writeTextFile(path, text))
  const steps: PromptRunStep[] = []
  for (const lane of input.lanes) {
    if (isApiAgentId(lane.agent)) {
      const provider = providerFromApiAgent(lane.agent)
      const model = pickCodingModel(provider)
      const promptText = buildRunBootstrapInput({
        runId: input.runId,
        prompt: lane.slicePrompt,
        agent: lane.agent,
        role: lane.role,
        skillNames: lane.skillNames,
        allowedFiles: input.allowedFiles,
        boardPath: input.boardPath,
        contextDir: input.contextDir,
        attachmentsDir: input.attachmentsDir,
        toolsJsonPath: input.toolsJsonPath,
      })
      const reply = await chat(
        provider,
        model,
        [{ role: 'user', content: promptText }],
        CODING_TIMEOUT_MS,
      )
      const replyPath = `${input.contextDir ?? `runs/${input.runId}/context`}/api-reply.md`
      await writeApiReply(replyPath, reply.text)
      const endedAt = (input.now ?? Date.now)()
      steps.push({
        agent: lane.agent,
        reason: lane.reason,
        startedAt: createdAt,
        endedAt,
        terminalId: `api:${provider}:${input.runId}`,
      })
      continue
    }
    const flag = input.unrestricted ? UNRESTRICTED_FLAG[lane.agent] : null
    const extraArgs = flag ? [flag] : undefined
    const paneName =
      lane.role === 'orchestrator'
        ? `Auto · ${routedAgentLabel(lane.agent)}`
        : routedAgentLabel(lane.agent)
    let sessionId: string | undefined
    let sessionCreate: boolean | undefined
    if (lane.agent === 'claude') {
      const existing = canonicalClaudeSessionId(input.runId)
      if (existing) {
        sessionId = existing
      } else {
        sessionId = createUuid()
        sessionCreate = true
        rememberCanonicalClaude(input.runId, sessionId)
      }
    }
    const terminal = await input.createAgentTerminal(input.projectId, {
      name: paneName,
      cwd: input.cwd,
      firstTab: {
        type: lane.agent,
        cwd: input.cwd,
        extraArgs,
        sessionId,
        sessionCreate,
        initialInput: buildRunBootstrapInput({
          runId: input.runId,
          prompt: lane.slicePrompt,
          agent: lane.agent,
          role: lane.role,
          skillNames: lane.skillNames,
          allowedFiles: input.allowedFiles,
          boardPath: input.boardPath,
          contextDir: input.contextDir,
          attachmentsDir: input.attachmentsDir,
          toolsJsonPath: input.toolsJsonPath,
        }),
      },
    })
    if (lane.agent === 'claude' && sessionId) {
      rememberCanonicalClaude(input.runId, sessionId, terminal.id)
    }
    steps.push({
      agent: lane.agent,
      reason: lane.reason,
      startedAt: createdAt,
      terminalId: terminal.id,
    })
  }
  return steps
}

export async function startPromptRun(input: StartPromptRunInput): Promise<StartPromptRunResult> {
  if (!input.project) return { ok: false, code: 'no-project' }
  if (!input.cwd.trim()) return { ok: false, code: 'no-cwd' }
  const runTerminalIds = [
    ...(input.activeRunTerminalIds ?? []),
    ...(input.activeTerminalId ? [input.activeTerminalId] : []),
  ]
  if (isPromptRunBlocking(input.activeRunStatus, runTerminalIds, input.liveTerminalIds)) {
    return { ok: false, code: 'run-active' }
  }

  const lanes = (
    input.lanes ??
    planAutoLanes({
      prompt: input.prompt,
      enabledAgents: input.enabledAgents,
      installedAgents: input.installedAgents,
      claudeFiveHourUtilization: input.claudeFiveHourUtilization,
      codexRateLimited: input.codexRateLimited,
      reviewAgentProvider: input.project.reviewAgentProvider,
      conflictAgentProvider: input.project.conflictAgentProvider,
      lastUsedAgent: input.project.lastUsedAgent,
      skills: input.skills,
      includeOrchestrator: input.includeOrchestrator,
    })
  ).filter((lane) => input.includeOrchestrator !== false || lane.role !== 'orchestrator')
  if (lanes.length === 0) return { ok: false, code: 'needs-install' }

  const createId = input.createId ?? nanoid
  const now = input.now ?? Date.now
  const runId = createId()
  const createdAt = now()
  const journalPath = `runs/${runId}/journal.md`
  const cwd = input.cwd.trim()
  const ensureContextDir =
    input.ensureContextDir ?? (async (id: string) => `runs/${id}/context`)
  const contextDir = await ensureContextDir(runId)
  const steps = await launchPromptRunLanes({
    projectId: input.project.id,
    cwd,
    runId,
    unrestricted: input.unrestricted,
    lanes,
    allowedFiles: input.allowedFiles,
    boardPath: input.boardPath,
    contextDir,
    attachmentsDir: input.attachmentsDir,
    toolsJsonPath: input.toolsJsonPath,
    createUuid: input.createUuid,
    now,
    createAgentTerminal: input.createAgentTerminal,
    chat: input.chat,
    pickCodingModel: input.pickCodingModel,
    writeApiReply: input.writeApiReply,
  })
  const apiOnly = lanes.length > 0 && lanes.every((lane) => isApiAgentId(lane.agent))
  const run: PromptRun = {
    id: runId,
    projectId: input.project.id,
    cwd,
    prompt: input.prompt,
    status: apiOnly ? 'done' : 'running',
    activeAgent: lanes[0].agent,
    activeTerminalId: steps[0]?.terminalId ?? '',
    unrestricted: input.unrestricted,
    steps,
    journalPath,
    contextDir,
    canonicalClaudeSessionId: canonicalClaudeSessionId(runId),
    canonicalClaudeTerminalId: canonicalClaudeTerminalId(runId),
    createdAt,
  }

  return { ok: true, run }
}
