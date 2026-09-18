import { nanoid } from 'nanoid'
import { getCachedClaudeUsage } from '../claudeUsageCache'
import { getCachedCodexUsage } from '../codexUsageCache'
import { groupSkillsByName } from '../skills'
import { ALL_AGENT_TYPES, AGENT_TYPE_LABELS, type AgentType, type TaskCard, type TaskSlicePlan } from '../types'
import { notifyAgentDone } from '../notifications'
import {
  appendPromptRunBoard,
  appendPromptRunJournal,
  findCliLauncher,
  runPlannerCli,
  runValidation,
  skillsScan,
  writePromptRunBoard,
  writeTextFile,
  ensurePromptRunContext,
} from '../tauri'
import { useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'
import { useTaskBoardStore } from '../../stores/taskBoardStore'
import { probeInstalledAgents } from '../promptRun/probeInstalled'
import { launchPromptRunLanes, startPromptRun } from '../promptRun/startPromptRun'
import type { AutoLane } from '../promptRun/planAutoLanes'
import { isPromptRunBlocking } from '../promptRun/isPromptRunBlocking'
import { isAgentAuthError } from '../promptRun/detectHandoffTrigger'
import { excludeFailedAgents, markAgentAuthFailed } from '../promptRun/failedAgents'
import { attachmentsDirFor, buildToolsJsonPayload, joinAttachmentsPath } from './attachments'
import { appendBoardNote, renderBoardMarkdown } from './boardMarkdown'
import { buildPlannerPrompt, planBoardSlices } from './planner'
import { boardInvokeError, decideBoardStartFailure } from './boardStart'
import { launchableSlices, pickNextTaskCard, readySlices } from './schedule'
import { boardCardSettled, failSlicePlan, laneContextFromPlan, retargetSlicePlan } from './retargetBoardSlice'
import { toAutoPromptRunProject } from '../promptRun/submitAutoPromptRun'
import { getProjectDefaultCwd } from '../terminalFactory'

const startingCards = new Set<string>()
let skipGeminiPlanner = false
const PLANNER_TIMEOUT_MS = 8_000

const DEFAULT_TOOL_SELECTION = { mode: 'projectDefault' as const, mcpServerIds: [], skillNames: [] }

/**
 * When the card has attachments, resolves the shared attachments directory
 * and writes `tools.json` (the resolved MCP/skill allowlist) beside them so
 * workers can read pointers on disk instead of having the prompt paste
 * attachment markdown or the full tool catalog inline.
 */
async function prepareCardAttachments(
  card: TaskCard,
): Promise<{ attachmentsDir?: string; toolsJsonPath?: string }> {
  const attachmentsDir = attachmentsDirFor(card.attachments)
  if (!attachmentsDir) return {}
  const selection = card.toolSelection ?? DEFAULT_TOOL_SELECTION
  const payload = buildToolsJsonPayload(selection, { mcpServerIds: [], skillNames: [] })
  const toolsJsonPath = joinAttachmentsPath(attachmentsDir, 'tools.json')
  try {
    await writeTextFile(toolsJsonPath, JSON.stringify(payload, null, 2))
  } catch (cause) {
    console.warn('[task-board] tools.json write failed:', cause)
    return { attachmentsDir }
  }
  return { attachmentsDir, toolsJsonPath }
}

function sliceToLane(slice: TaskSlicePlan): AutoLane {
  return {
    agent: slice.agent,
    role: 'worker',
    taskKind: slice.kind,
    reason: 'heuristic',
    skillNames: [],
    slicePrompt: slice.prompt,
  }
}

async function plannerTextFor(card: TaskCard, installed: string[]): Promise<string | null> {
  if (skipGeminiPlanner) return null
  if (!installed.includes('gemini')) return null
  if (excludeFailedAgents(['gemini']).length === 0) return null
  if (!card.cwd.trim()) return null
  const bin = await findCliLauncher('gemini').catch(() => null)
  if (!bin) return null
  const prompt = buildPlannerPrompt({
    prompt: card.prompt,
    allowedFiles: card.allowedFiles,
    installedAgents: ALL_AGENT_TYPES.filter((agent) => installed.includes(agent)),
  })
  try {
    const text = await runPlannerCli(bin, ['-p', prompt], card.cwd, PLANNER_TIMEOUT_MS)
    if (text && isAgentAuthError(text)) {
      skipGeminiPlanner = true
      markAgentAuthFailed('gemini')
      return null
    }
    return text
  } catch (cause) {
    console.warn('[task-board] planner failed:', cause)
    if (isAgentAuthError(String(cause))) {
      skipGeminiPlanner = true
      markAgentAuthFailed('gemini')
    }
    return null
  }
}

async function collectPlanContext(card: TaskCard) {
  const preferences = useProjectsStore.getState().preferences
  const project = useProjectsStore.getState().projects.find((item) => item.id === card.projectId)
  const installed = excludeFailedAgents(
    await probeInstalledAgents(
      ALL_AGENT_TYPES.filter((agent) => preferences.enabledAgents[agent] && agent !== 'shell'),
    ),
  )
  const [claudeUsage, codexUsage, skillSnapshots] = await Promise.all([
    getCachedClaudeUsage().catch(() => null),
    getCachedCodexUsage().catch(() => null),
    skillsScan().catch(() => []),
  ])
  return {
    project,
    installed,
    input: {
      prompt: card.prompt,
      enabledAgents: ALL_AGENT_TYPES.filter((agent) => preferences.enabledAgents[agent]),
      installedAgents: installed,
      claudeFiveHourUtilization: claudeUsage?.five_hour.utilization ?? null,
      codexRateLimited: Boolean(codexUsage?.rate_limited),
      reviewAgentProvider: project?.reviewAgentProvider,
      conflictAgentProvider: project?.conflictAgentProvider,
      lastUsedAgent: project?.terminals[project.terminals.length - 1]?.tabs[0]?.type,
      skills: groupSkillsByName(skillSnapshots).map((group) => ({
        name: group.name,
        description: group.description,
        agents: group.agents,
      })),
      allowedFiles: card.allowedFiles,
    },
  }
}

export async function startBoardCard(cardId: string): Promise<void> {
  if (startingCards.has(cardId)) return
  const card = useTaskBoardStore.getState().cards.find((item) => item.id === cardId)
  if (!card || (card.column !== 'todo' && card.column !== 'doing')) return
  if (card.column === 'doing' && card.runId) return
  startingCards.add(cardId)
  useTaskBoardStore.getState().patchCard(cardId, { column: 'doing', error: undefined })
  try {
    const { project, installed, input } = await collectPlanContext(card)
    if (!project) {
      useTaskBoardStore.getState().patchCard(cardId, { column: 'blocked', error: 'no-project' })
      return
    }
    const cwd =
      card.cwd.trim() || getProjectDefaultCwd(project, useProjectsStore.getState().projects)
    if (!cwd) {
      useTaskBoardStore.getState().patchCard(cardId, { column: 'blocked', error: 'no-cwd' })
      return
    }
    if (cwd !== card.cwd) {
      useTaskBoardStore.getState().patchCard(cardId, { cwd })
    }
    const workingCard = { ...card, cwd }
    const plannerText = await plannerTextFor(workingCard, installed)
    const plannerFailedAuth = Boolean(plannerText && isAgentAuthError(plannerText))
    if (plannerFailedAuth) markAgentAuthFailed('gemini')
    const usableInstalled = excludeFailedAgents(
      plannerFailedAuth ? installed.filter((agent) => agent !== 'gemini') : installed,
    )
    const slicePlan = planBoardSlices(
      { ...input, installedAgents: usableInstalled },
      plannerFailedAuth ? null : plannerText,
    )
    if (slicePlan.length === 0) {
      useTaskBoardStore.getState().patchCard(cardId, { column: 'blocked', error: 'needs-install' })
      return
    }
    const toLaunch = launchableSlices(slicePlan)
    if (toLaunch.length === 0) {
      useTaskBoardStore.getState().patchCard(cardId, {
        column: 'blocked',
        slicePlan,
        error: 'start-failed',
      })
      return
    }
    const runId = nanoid()
    let boardPath: string | undefined
    try {
      boardPath = await writePromptRunBoard(runId, renderBoardMarkdown(workingCard, slicePlan))
    } catch (cause) {
      console.warn('[task-board] board write failed:', cause)
    }
    const autoProject = toAutoPromptRunProject(project)
    const existing = usePromptRunStore.getState().byProjectId[card.projectId]
    const { attachmentsDir, toolsJsonPath } = await prepareCardAttachments(workingCard)
    const result = await startPromptRun({
      project: autoProject,
      cwd,
      prompt: card.prompt,
      unrestricted: useProjectsStore.getState().preferences.alwaysStartUnrestricted,
      enabledAgents: input.enabledAgents,
      installedAgents: usableInstalled,
      claudeFiveHourUtilization: input.claudeFiveHourUtilization,
      codexRateLimited: input.codexRateLimited,
      activeRunStatus: existing?.status,
      activeTerminalId: existing?.activeTerminalId,
      activeRunTerminalIds: existing?.steps
        .map((step) => step.terminalId)
        .filter((id): id is string => Boolean(id)),
      liveTerminalIds: project.terminals.map((terminal) => terminal.id),
      skills: input.skills,
      lanes: toLaunch.map(sliceToLane),
      includeOrchestrator: false,
      allowedFiles: card.allowedFiles,
      boardPath,
      attachmentsDir,
      toolsJsonPath,
      createId: () => runId,
      ensureContextDir: ensurePromptRunContext,
      createAgentTerminal: (projectId, launch) =>
        useProjectsStore.getState().createAgentTerminal(projectId, launch),
    })
    if (!result.ok) {
      const failure = decideBoardStartFailure(result.code)
      useTaskBoardStore.getState().patchCard(cardId, {
        column: failure.column,
        error: failure.error,
      })
      return
    }
    const launchedIds = toLaunch.map((slice) => slice.id)
    const withTerminals = slicePlan.map((slice) => {
      const index = launchedIds.indexOf(slice.id)
      if (index < 0) return slice
      return { ...slice, status: 'running' as const, terminalId: result.run.steps[index]?.terminalId }
    })
    usePromptRunStore.getState().setRun(result.run)
    try {
      await appendPromptRunJournal(result.run.id, 'Board task started', card.prompt)
      const boardPath = await writePromptRunBoard(
        result.run.id,
        renderBoardMarkdown(workingCard, withTerminals),
      )
      usePromptRunStore.getState().patchRun(result.run.projectId, {
        journalPath: result.run.journalPath,
      })
      useTaskBoardStore.getState().patchCard(cardId, {
        column: 'doing',
        runId: result.run.id,
        boardPath,
        slicePlan: withTerminals,
        error: undefined,
      })
    } catch (cause) {
      console.warn('[task-board] board write failed:', cause)
      useTaskBoardStore.getState().patchCard(cardId, {
        column: 'doing',
        runId: result.run.id,
        slicePlan: withTerminals,
      })
    }
  } catch (cause) {
    console.warn('[task-board] start failed:', cause)
    useTaskBoardStore.getState().patchCard(cardId, {
      column: 'blocked',
      error: boardInvokeError(cause),
    })
  } finally {
    startingCards.delete(cardId)
  }
}

export async function continueBoardCard(cardId: string): Promise<void> {
  const card = useTaskBoardStore.getState().cards.find((item) => item.id === cardId)
  if (!card?.runId || !card.slicePlan) return
  const pending = readySlices(card.slicePlan)
  if (pending.length === 0) return
  const project = useProjectsStore.getState().projects.find((item) => item.id === card.projectId)
  if (!project) return
  const run = usePromptRunStore.getState().byProjectId[card.projectId]
  const { attachmentsDir, toolsJsonPath } = await prepareCardAttachments(card)
  const steps = await launchPromptRunLanes({
    projectId: card.projectId,
    cwd: card.cwd,
    runId: card.runId,
    unrestricted: useProjectsStore.getState().preferences.alwaysStartUnrestricted,
    lanes: pending.map(sliceToLane),
    allowedFiles: card.allowedFiles,
    boardPath: card.boardPath,
    contextDir: run?.id === card.runId ? run.contextDir : undefined,
    attachmentsDir,
    toolsJsonPath,
    createAgentTerminal: (projectId, launch) =>
      useProjectsStore.getState().createAgentTerminal(projectId, launch),
  })
  for (const step of steps) {
    usePromptRunStore.getState().appendStep(card.projectId, step)
  }
  let index = 0
  const nextPlan = card.slicePlan.map((slice) => {
    if (!pending.some((item) => item.id === slice.id)) return slice
    const step = steps[index]
    index += 1
    return { ...slice, status: 'running' as const, terminalId: step?.terminalId }
  })
  useTaskBoardStore.getState().patchCard(cardId, { slicePlan: nextPlan })
}

export function failBoardLane(terminalId: string): void {
  const card = useTaskBoardStore.getState().cards.find((item) =>
    item.slicePlan?.some((slice) => slice.terminalId === terminalId),
  )
  if (!card?.slicePlan) return
  useTaskBoardStore.getState().patchCard(card.id, {
    slicePlan: failSlicePlan(card.slicePlan, terminalId),
  })
}

export function boardLaneContext(runId: string, terminalId: string) {
  const card = useTaskBoardStore.getState().cards.find((item) => item.runId === runId)
  return laneContextFromPlan(card?.slicePlan, terminalId)
}

export function retargetBoardRun(
  runId: string,
  fromTerminalId: string,
  next: { agent: AgentType; terminalId: string },
): void {
  const card = useTaskBoardStore.getState().cards.find((item) => item.runId === runId)
  if (!card?.slicePlan) return
  useTaskBoardStore.getState().patchCard(card.id, {
    slicePlan: retargetSlicePlan(card.slicePlan, fromTerminalId, next),
  })
}

export function stopBoardCard(cardId: string): void {
  const card = useTaskBoardStore.getState().cards.find((item) => item.id === cardId)
  if (!card) return
  const run = usePromptRunStore.getState().byProjectId[card.projectId]
  if (run && run.id === card.runId) {
    usePromptRunStore.getState().setStatus(card.projectId, 'cancelled')
  }
  startingCards.delete(cardId)
  useTaskBoardStore.getState().patchCard(cardId, {
    column: 'backlog',
    error: undefined,
  })
}

export async function noteBoardTerminalComplete(terminalId: string): Promise<void> {
  const card = useTaskBoardStore
    .getState()
    .cards.find((item) => item.column === 'doing' && item.slicePlan?.some((slice) => slice.terminalId === terminalId))
  if (!card?.slicePlan) return
  const run = usePromptRunStore.getState().byProjectId[card.projectId]
  if (run?.status === 'handing-off') return
  const slice = card.slicePlan.find((item) => item.terminalId === terminalId)
  if (!slice || slice.status === 'done' || slice.status === 'failed') return
  const nextPlan = card.slicePlan.map((item) =>
    item.id === slice.id ? { ...item, status: 'done' as const } : item,
  )
  useTaskBoardStore.getState().patchCard(card.id, { slicePlan: nextPlan })
  if (card.runId) {
    try {
      const heading = `${AGENT_TYPE_LABELS[slice.agent]} finished ${slice.kind}`
      const body = `Slice ${slice.id} is done. Remaining siblings should not redo this work.`
      await appendPromptRunBoard(card.runId, heading, body)
      await appendPromptRunJournal(card.runId, heading, body)
    } catch (cause) {
      console.warn('[task-board] board append failed:', cause)
    }
  }
  if (readySlices(nextPlan).length > 0) {
    await continueBoardCard(card.id)
    return
  }
  if (!boardCardSettled(nextPlan)) return
  await finishBoardCard(card.id)
}

export async function finishBoardCard(cardId: string): Promise<void> {
  const card = useTaskBoardStore.getState().cards.find((item) => item.id === cardId)
  if (!card) return
  const project = useProjectsStore.getState().projects.find((item) => item.id === card.projectId)
  const commands =
    card.verifyCommands && card.verifyCommands.length > 0
      ? card.verifyCommands
      : (project?.validationCommands ?? [])
  usePromptRunStore.getState().setStatus(card.projectId, 'done')
  if (commands.length === 0) {
    useTaskBoardStore.getState().patchCard(cardId, { column: 'done' })
    await notifyAgentDone(card.title, 'Task finished (no test command).')
    return
  }
  useTaskBoardStore.getState().patchCard(cardId, { column: 'verify' })
  try {
    const result = await runValidation(card.cwd, commands)
    if (result.success) {
      useTaskBoardStore.getState().patchCard(cardId, { column: 'done', error: undefined })
      await notifyAgentDone(card.title, 'Task finished and tests passed.')
      return
    }
    const note = appendBoardNote('', `Validation failed (${result.stage})`, result.output)
    if (card.runId) {
      await appendPromptRunBoard(card.runId, `Validation failed (${result.stage})`, result.output).catch(
        () => note,
      )
    }
    useTaskBoardStore.getState().patchCard(cardId, { column: 'blocked', error: result.output.slice(0, 400) })
    await notifyAgentDone(card.title, 'Task blocked: tests failed.')
  } catch (cause) {
    useTaskBoardStore.getState().patchCard(cardId, {
      column: 'blocked',
      error: String(cause),
    })
    await notifyAgentDone(card.title, 'Task blocked: tests failed to start.')
  }
}

export function pumpTaskBoardQueue(): void {
  const projects = useProjectsStore.getState().projects
  const blocked = new Set<string>()
  for (const project of projects) {
    const run = usePromptRunStore.getState().byProjectId[project.id]
    if (
      isPromptRunBlocking(
        run?.status,
        [run?.activeTerminalId, ...(run?.steps.map((step) => step.terminalId) ?? [])].filter(
          (id): id is string => Boolean(id),
        ),
        project.terminals.map((terminal) => terminal.id),
      )
    ) {
      blocked.add(project.id)
    }
  }
  const next = pickNextTaskCard(useTaskBoardStore.getState().cards, blocked)
  if (!next) return
  void startBoardCard(next.id)
}
