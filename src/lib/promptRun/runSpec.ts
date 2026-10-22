import { nanoid } from 'nanoid'

import { getCachedClaudeUsage } from '../claudeUsageCache'
import { getCachedCodexUsage } from '../codexUsageCache'
import { getLocale, translate } from '../i18n'
import { getModelCatalog } from '../providers/catalogOverlay'
import type { ProviderId } from '../providers/modelCatalog'
import { notifyAgentDone } from '../notifications'
import {
  appendProjectRunBoard,
  appendPromptRunJournal,
  detectAgentsForCwd,
  ensurePromptRunContext,
  providerChat,
  providerKeyStatus,
  runPlannerCli,
  writeProjectRunBoard,
  type ChatMessage,
} from '../tauri'
import {
  ALL_AGENT_TYPES,
  AGENT_TYPE_LABELS,
  type AgentType,
  type PromptRun,
  type SpecTask,
} from '../types'
import { useProjectsStore } from '../../stores/projectsStore'
import { usePromptRunStore } from '../../stores/promptRunStore'
import type { TaskKind } from './classifyTask'
import { isAgentAuthError } from './detectHandoffTrigger'
import {
  isDeepseekPlannerUnavailable,
  markDeepseekPlannerUnavailable,
  pickDeepseekPlannerModel,
} from './deepseekPlanner'
import { excludeFailedAgents, markAgentAuthFailed } from './failedAgents'
import { buildSpecTaskBootstrap } from './bootstrapPrompt'
import { isPromptRunBlocking } from './isPromptRunBlocking'
import type { AutoLane } from './planAutoLanes'
import { probeInstalledAgents } from './probeInstalled'
import {
  buildSpecPlannerPrompt,
  heuristicSpecTasks,
  parseSpecPlan,
  readySpecTasks,
  renderSpecBoard,
  specRunSettled,
  type SpecPlanContext,
} from './specPlan'
import { oldestQueuedCodingSlice, pickTaskForTerminal, readyTaskMustQueue } from './creditQueue'
import { deliverFinishedSpecSlice, openQueuedCodingSliceIfIdle } from './specCreditActions'
import { liveSpecCreditPorts } from './specCreditPorts'
import { launchPromptRunLanes, type StartPromptRunResult } from './startPromptRun'

export const SPEC_PLANNER_TIMEOUT_MS = 90_000

const PLANNER_ARGS_FULL = [
  '-p',
  'Plan the SPEC given on stdin. Reply with the JSON object only.',
  '--approval-mode',
  'plan',
  '--skip-trust',
  '-o',
  'text',
]
const PLANNER_ARGS_MINIMAL = ['-p', 'Plan the SPEC given on stdin. Reply with the JSON object only.']

export type SpecPlanNotice = 'gemini-missing' | 'gemini-failed'

export type SpecPlanResult =
  | {
      ok: true
      tasks: SpecTask[]
      source: 'deepseek' | 'gemini' | 'heuristic'
      notice?: SpecPlanNotice
      /** Installed and configured coding CLIs the user may reassign tasks to. */
      agents: AgentType[]
    }
  | { ok: false; code: 'no-cwd' | 'needs-install' }

type SpecProject = {
  id: string
  reviewAgentProvider?: AgentType
  conflictAgentProvider?: AgentType
  terminals: Array<{ id: string; tabs: Array<{ type: AgentType }> }>
}

/** Installed coding CLIs that may own Run SPEC tasks (Gemini is planner-only, never a worker). */
export async function usableSpecAgents(cwd: string): Promise<AgentType[]> {
  const enabled = useProjectsStore.getState().preferences.enabledAgents
  const candidates = ALL_AGENT_TYPES.filter(
    (agent) => agent !== 'shell' && agent !== 'gemini' && enabled[agent],
  )
  return excludeFailedAgents(await probeInstalledAgents(candidates, cwd))
}

async function specContext(project: SpecProject, spec: string, agents: AgentType[]) {
  const [claudeUsage, codexUsage] = await Promise.all([
    getCachedClaudeUsage().catch(() => null),
    getCachedCodexUsage().catch(() => null),
  ])
  const ctx: SpecPlanContext = {
    spec,
    enabledAgents: agents,
    installedAgents: agents,
    claudeFiveHourUtilization: claudeUsage?.five_hour.utilization ?? null,
    codexRateLimited: Boolean(codexUsage?.rate_limited),
    reviewAgentProvider: project.reviewAgentProvider,
    conflictAgentProvider: project.conflictAgentProvider,
    lastUsedAgent: project.terminals[project.terminals.length - 1]?.tabs[0]?.type,
  }
  return ctx
}

function isUnknownFlagError(text: string): boolean {
  return /unknown (argument|option)|not a valid choice|invalid values?|unrecognized/i.test(text)
}

/** Free Gemini CLI pre-pass. Resolves to raw planner text, or a notice when it is unusable. */
async function runGeminiPlanner(
  cwd: string,
  prompt: string,
): Promise<{ text: string } | { notice: SpecPlanNotice }> {
  if (excludeFailedAgents(['gemini']).length === 0) return { notice: 'gemini-failed' }
  // Probed per cwd so a Gemini installed only inside a WSL distro is found there.
  const detection = await detectAgentsForCwd(cwd, ['gemini']).catch(() => [])
  const bin = detection.find((entry) => entry.installed && entry.path)?.path ?? null
  if (!bin) return { notice: 'gemini-missing' }
  const attempt = (args: string[]) =>
    runPlannerCli(bin, args, cwd, SPEC_PLANNER_TIMEOUT_MS, prompt)
  try {
    let text = await attempt(PLANNER_ARGS_FULL).catch(async (cause: unknown) => {
      // Older Gemini builds lack the read-only/trust flags; retry with the bare headless call.
      if (isUnknownFlagError(String(cause))) return attempt(PLANNER_ARGS_MINIMAL)
      throw cause
    })
    if (isUnknownFlagError(text) && !text.includes('{')) text = await attempt(PLANNER_ARGS_MINIMAL)
    if (isAgentAuthError(text) && !text.includes('"tasks"')) {
      markAgentAuthFailed('gemini')
      return { notice: 'gemini-failed' }
    }
    return { text }
  } catch (cause) {
    console.warn('[run-spec] gemini planner failed:', cause)
    if (isAgentAuthError(String(cause))) markAgentAuthFailed('gemini')
    return { notice: 'gemini-failed' }
  }
}

export type PlanSpecDeps = {
  usableAgents?: (cwd: string) => Promise<AgentType[]>
  keyStatus?: (id: ProviderId) => Promise<{ saved: boolean }>
  chat?: (
    provider: ProviderId,
    model: string,
    messages: ChatMessage[],
    timeoutMs?: number,
  ) => Promise<{ text: string }>
  gemini?: (cwd: string, prompt: string) => Promise<{ text: string } | { notice: SpecPlanNotice }>
}

/**
 * DeepSeek direct API when a key is saved and the call returns a usable plan.
 * A failed call is skipped for the rest of this process. Otherwise Gemini CLI,
 * then the local heuristic.
 */
async function runDeepseekPlanner(
  spec: string,
  prompt: string,
  deps: PlanSpecDeps,
): Promise<{ text: string } | { skipped: true }> {
  if (isDeepseekPlannerUnavailable()) return { skipped: true }
  const keyStatus = deps.keyStatus ?? providerKeyStatus
  let saved = false
  try {
    saved = (await keyStatus('deepseek')).saved
  } catch (cause) {
    console.warn('[run-spec] deepseek key status failed:', cause)
    return { skipped: true }
  }
  if (!saved) return { skipped: true }
  const chat = deps.chat ?? providerChat
  const model = pickDeepseekPlannerModel(spec, getModelCatalog('deepseek'))
  try {
    const result = await chat(
      'deepseek',
      model,
      [{ role: 'user', content: prompt }],
      SPEC_PLANNER_TIMEOUT_MS,
    )
    return { text: result.text ?? '' }
  } catch (cause) {
    console.warn('[run-spec] deepseek planner failed:', cause)
    markDeepseekPlannerUnavailable()
    return { skipped: true }
  }
}

/** Splits a SPEC into tasks: DeepSeek, then Gemini, then the local heuristic. */
export async function planSpec(
  args: {
    project: SpecProject
    cwd: string
    spec: string
    /** Installed worker CLIs the user turned on for this run. Gemini is never included. */
    allowedAgents?: readonly AgentType[]
  },
  deps: PlanSpecDeps = {},
): Promise<SpecPlanResult> {
  const cwd = args.cwd.trim()
  if (!cwd) return { ok: false, code: 'no-cwd' }
  let agents = await (deps.usableAgents ?? usableSpecAgents)(cwd)
  if (args.allowedAgents) {
    const allow = new Set(args.allowedAgents)
    agents = agents.filter((agent) => allow.has(agent))
  }
  if (agents.length === 0) return { ok: false, code: 'needs-install' }
  const ctx = await specContext(args.project, args.spec, agents)
  const prompt = buildSpecPlannerPrompt({ spec: args.spec, agents })
  const deepseek = await runDeepseekPlanner(args.spec, prompt, deps)
  if ('text' in deepseek) {
    const tasks = parseSpecPlan(deepseek.text, ctx)
    if (tasks.length > 0) return { ok: true, tasks, source: 'deepseek', agents }
    markDeepseekPlannerUnavailable()
  }
  const gemini = deps.gemini ?? runGeminiPlanner
  const planner = await gemini(cwd, prompt)
  let notice: SpecPlanNotice | undefined
  if ('text' in planner) {
    const tasks = parseSpecPlan(planner.text, ctx)
    if (tasks.length > 0) return { ok: true, tasks, source: 'gemini', agents }
    notice = 'gemini-failed'
  } else {
    notice = planner.notice
  }
  const tasks = heuristicSpecTasks(ctx)
  if (tasks.length === 0) return { ok: false, code: 'needs-install' }
  return { ok: true, tasks, source: 'heuristic', notice, agents }
}

function taskLane(runId: string, task: SpecTask, tasks: readonly SpecTask[], boardPath?: string): AutoLane {
  const kind: TaskKind = task.kind === 'shell' ? 'unknown' : task.kind
  return {
    agent: task.agent,
    role: 'worker',
    taskKind: kind,
    reason: 'heuristic',
    skillNames: [],
    slicePrompt: task.prompt,
    paneName: `${task.id} · ${AGENT_TYPE_LABELS[task.agent]}`,
    independentSession: true,
    bootstrap: buildSpecTaskBootstrap({ runId, task, siblings: tasks, boardPath }),
  }
}

/**
 * Opens one pane per ready task. Shell tasks get a plain terminal (typing their command) and
 * count as done once opened, so tasks that depend on them are not held back.
 */
function specWorkerAllowed(agent: AgentType, allowed?: readonly AgentType[]): boolean {
  if (agent === 'shell') return true
  if (agent === 'gemini') return false
  return !allowed || allowed.includes(agent)
}

async function launchReadyTasks(run: {
  id: string
  projectId: string
  cwd: string
  boardPath?: string
  contextDir?: string
  tasks: SpecTask[]
  allowedAgents?: readonly AgentType[]
  exhaustedAgents?: readonly AgentType[]
}): Promise<{ tasks: SpecTask[]; steps: PromptRun['steps'] }> {
  const ready = readySpecTasks(run.tasks)
  if (ready.length === 0) return { tasks: run.tasks, steps: [] }
  const blocked = new Set(
    ready.filter((task) => !specWorkerAllowed(task.agent, run.allowedAgents)).map((task) => task.id),
  )
  // A CLI that ran out of credit is not opened again in this run; its slice waits in the queue.
  const exhaustedIds = new Set(
    ready
      .filter((task) => !blocked.has(task.id) && readyTaskMustQueue(task, run.exhaustedAgents))
      .map((task) => task.id),
  )
  const queuedAt = Date.now()
  const createAgentTerminal = useProjectsStore.getState().createAgentTerminal
  const cliTasks = ready.filter(
    (task) => task.agent !== 'shell' && !blocked.has(task.id) && !exhaustedIds.has(task.id),
  )
  const shellTasks = ready.filter((task) => task.agent === 'shell' && !blocked.has(task.id))
  const steps = await launchPromptRunLanes({
    projectId: run.projectId,
    cwd: run.cwd,
    runId: run.id,
    unrestricted: true,
    lanes: cliTasks.map((task) => taskLane(run.id, task, run.tasks, run.boardPath)),
    boardPath: run.boardPath,
    contextDir: run.contextDir,
    createAgentTerminal,
  })
  const terminalByTask = new Map<string, string | undefined>()
  cliTasks.forEach((task, index) => terminalByTask.set(task.id, steps[index]?.terminalId))
  for (const task of shellTasks) {
    const terminal = await createAgentTerminal(run.projectId, {
      name: `${task.id} · ${task.title}`.slice(0, 60),
      cwd: run.cwd,
      firstTab: { type: 'shell', cwd: run.cwd, initialInput: task.command },
    })
    terminalByTask.set(task.id, terminal.id)
  }
  const tasks = run.tasks.map((task) => {
    if (blocked.has(task.id)) return { ...task, status: 'failed' as const }
    if (exhaustedIds.has(task.id)) return { ...task, status: 'queued' as const, queuedAt }
    if (!terminalByTask.has(task.id)) return task
    return {
      ...task,
      terminalId: terminalByTask.get(task.id),
      status: task.agent === 'shell' ? ('done' as const) : ('running' as const),
    }
  })
  return { tasks, steps }
}

export type LaunchSpecRunInput = {
  project: SpecProject
  cwd: string
  spec: string
  tasks: SpecTask[]
  /** Worker CLIs that may open a pane, including handoff targets. */
  allowedAgents?: AgentType[]
}

export async function launchSpecRun(input: LaunchSpecRunInput): Promise<StartPromptRunResult> {
  const cwd = input.cwd.trim()
  if (!cwd) return { ok: false, code: 'no-cwd' }
  if (input.tasks.length === 0) return { ok: false, code: 'needs-install' }
  const existing = usePromptRunStore.getState().byProjectId[input.project.id]
  if (
    isPromptRunBlocking(
      existing?.status,
      [existing?.activeTerminalId, ...(existing?.steps.map((step) => step.terminalId) ?? [])].filter(
        (id): id is string => Boolean(id),
      ),
      input.project.terminals.map((terminal) => terminal.id),
    )
  ) {
    return { ok: false, code: 'run-active' }
  }
  const runId = nanoid()
  const pending = input.tasks.map((task) => ({
    ...task,
    status: 'pending' as const,
    terminalId: undefined,
  }))
  let boardPath: string | undefined
  try {
    boardPath = await writeProjectRunBoard(
      cwd,
      runId,
      renderSpecBoard({ runId, spec: input.spec, tasks: pending }),
    )
  } catch (cause) {
    console.warn('[run-spec] board write failed:', cause)
  }
  const contextDir = await ensurePromptRunContext(runId).catch(() => undefined)
  const launched = await launchReadyTasks({
    id: runId,
    projectId: input.project.id,
    cwd,
    boardPath,
    contextDir,
    tasks: pending,
    allowedAgents: input.allowedAgents,
  })
  const first = launched.steps[0]
  const firstTask = launched.tasks.find((task) => task.terminalId)
  const run: PromptRun = {
    id: runId,
    projectId: input.project.id,
    cwd,
    prompt: input.spec,
    status: 'running',
    activeAgent: first?.agent ?? firstTask?.agent ?? pending[0].agent,
    activeTerminalId: first?.terminalId ?? firstTask?.terminalId ?? '',
    unrestricted: true,
    steps: launched.steps,
    journalPath: `runs/${runId}/journal.md`,
    contextDir,
    boardPath,
    specTasks: launched.tasks,
    allowedAgents: input.allowedAgents,
    createdAt: Date.now(),
  }
  usePromptRunStore.getState().setRun(run)
  try {
    const journalPath = await appendPromptRunJournal(runId, 'SPEC run started', input.spec)
    usePromptRunStore.getState().patchRun(run.projectId, { journalPath })
  } catch (cause) {
    console.warn('[run-spec] journal append failed:', cause)
  }
  // Shell tasks settle on launch, which may already unblock their dependents.
  if (readySpecTasks(launched.tasks).length > 0) await continueSpecRun(run.projectId)
  else if (specRunSettled(launched.tasks)) await finishSpecRun(run.projectId)
  return { ok: true, run: usePromptRunStore.getState().byProjectId[run.projectId] ?? run }
}

/** Launches tasks whose dependencies are now done. */
export async function continueSpecRun(projectId: string): Promise<void> {
  const run = usePromptRunStore.getState().byProjectId[projectId]
  if (!run?.specTasks || run.status !== 'running') return
  if (readySpecTasks(run.specTasks).length === 0) return
  try {
    const launched = await launchReadyTasks({
      id: run.id,
      projectId,
      cwd: run.cwd,
      boardPath: run.boardPath,
      contextDir: run.contextDir,
      tasks: run.specTasks,
      allowedAgents: run.allowedAgents,
      exhaustedAgents: run.exhaustedAgents,
    })
    const latest = usePromptRunStore.getState().byProjectId[projectId]
    if (!latest || latest.id !== run.id) return
    usePromptRunStore.getState().patchRun(projectId, {
      specTasks: mergeLaunched(latest.specTasks ?? [], launched.tasks),
      steps: [...latest.steps, ...launched.steps],
    })
    // With no coding slice running, a slice queued here opens on the next CLI with credit.
    const queuedHere = launched.tasks.find(
      (task) => task.status === 'queued' && run.specTasks?.find((item) => item.id === task.id)?.status === 'pending',
    )
    if (queuedHere) {
      const queuedSlice = oldestQueuedCodingSlice(
        usePromptRunStore.getState().byProjectId[projectId]?.specTasks ?? [],
      )
      await openQueuedCodingSliceIfIdle(projectId, liveSpecCreditPorts((queuedSlice ?? queuedHere).agent))
    }
  } catch (cause) {
    console.warn('[run-spec] continue failed:', cause)
    return
  }
  const after = usePromptRunStore.getState().byProjectId[projectId]
  if (after?.specTasks && readySpecTasks(after.specTasks).length > 0) {
    await continueSpecRun(projectId)
  } else if (after?.specTasks && specRunSettled(after.specTasks)) {
    await finishSpecRun(projectId)
  }
}

/** Keeps statuses that changed while a launch was in flight. */
function mergeLaunched(latest: readonly SpecTask[], launched: readonly SpecTask[]): SpecTask[] {
  return latest.map((task) => {
    const next = launched.find((item) => item.id === task.id)
    if (!next || task.status !== 'pending') return task
    return next
  })
}

async function finishSpecRun(projectId: string): Promise<void> {
  const run = usePromptRunStore.getState().byProjectId[projectId]
  if (!run?.specTasks || run.status !== 'running') return
  const failed = run.specTasks.filter((task) => task.status === 'failed').length
  usePromptRunStore.getState().setStatus(projectId, failed > 0 ? 'failed' : 'done')
  const summary = run.specTasks.map((task) => `- ${task.id} · ${task.status}`).join('\n')
  try {
    await appendProjectRunBoard(run.cwd, run.id, 'Run finished', summary)
    await appendPromptRunJournal(run.id, 'SPEC run finished', summary)
  } catch (cause) {
    console.warn('[run-spec] finish note failed:', cause)
  }
  const locale = getLocale()
  await notifyAgentDone(
    translate(locale, 'runSpec.finishedTitle'),
    translate(locale, failed > 0 ? 'runSpec.finishedWithFailures' : 'runSpec.finishedBody', {
      count: run.specTasks.length,
      failed,
    }),
  )
}

/** Ends the run when every slice is settled; no-op otherwise. */
export async function finishSpecRunIfSettled(projectId: string): Promise<void> {
  const run = usePromptRunStore.getState().byProjectId[projectId]
  if (run?.specTasks && specRunSettled(run.specTasks)) await finishSpecRun(projectId)
}

function findRunByTerminal(terminalId: string): { run: PromptRun; task: SpecTask } | null {
  for (const run of Object.values(usePromptRunStore.getState().byProjectId)) {
    const task = pickTaskForTerminal(run.specTasks, terminalId)
    if (task) return { run, task }
  }
  return null
}

/** A SPEC lane finished its turn: record it on the board and start unblocked dependents. */
export async function noteSpecTerminalComplete(terminalId: string): Promise<void> {
  const found = findRunByTerminal(terminalId)
  if (!found || found.run.status !== 'running') return
  const { run, task } = found
  if (task.status !== 'running') return
  const specTasks = (run.specTasks ?? []).map((item) =>
    item.id === task.id ? { ...item, status: 'done' as const } : item,
  )
  usePromptRunStore.getState().patchRun(run.projectId, { specTasks })
  const heading = `${task.id} finished (${AGENT_TYPE_LABELS[task.agent]})`
  const body = `Task "${task.title}" is done. Siblings must not redo this work.`
  try {
    await appendProjectRunBoard(run.cwd, run.id, heading, body)
    await appendPromptRunJournal(run.id, heading, body)
  } catch (cause) {
    console.warn('[run-spec] board append failed:', cause)
  }
  const latest = usePromptRunStore.getState().byProjectId[run.projectId]
  if (latest) {
    await deliverFinishedSpecSlice(latest, terminalId, liveSpecCreditPorts(task.agent))
    return
  }
}

/** Marks the task behind a dropped lane as failed. */
export function failSpecLane(terminalId: string): void {
  const found = findRunByTerminal(terminalId)
  if (!found?.run.specTasks) return
  const specTasks = found.run.specTasks.map((task) =>
    task.terminalId === terminalId ? { ...task, status: 'failed' as const } : task,
  )
  usePromptRunStore.getState().patchRun(found.run.projectId, { specTasks })
  if (specRunSettled(specTasks)) void finishSpecRun(found.run.projectId)
}

/** Points a task at the pane that took it over after a handoff. */
export function retargetSpecRun(
  runId: string,
  fromTerminalId: string,
  next: { agent: AgentType; terminalId: string },
): void {
  const run = Object.values(usePromptRunStore.getState().byProjectId).find((item) => item.id === runId)
  if (!run?.specTasks) return
  usePromptRunStore.getState().patchRun(run.projectId, {
    specTasks: run.specTasks.map((task) =>
      task.terminalId === fromTerminalId
        ? { ...task, agent: next.agent, terminalId: next.terminalId, status: 'running' as const }
        : task,
    ),
  })
}

/** Lane facts the handoff watcher uses to decide between dropping and retargeting a lane. */
export function specLaneContext(
  runId: string,
  terminalId: string,
): { failedKind: TaskKind | null; siblingKinds: TaskKind[]; slicePrompt: string | null } {
  const run = Object.values(usePromptRunStore.getState().byProjectId).find((item) => item.id === runId)
  const tasks = run?.specTasks ?? []
  const toKind = (kind: SpecTask['kind']): TaskKind => (kind === 'shell' ? 'unknown' : kind)
  const failed = tasks.find((task) => task.terminalId === terminalId)
  return {
    failedKind: failed ? toKind(failed.kind) : null,
    siblingKinds: tasks
      .filter(
        (task) =>
          task.agent !== 'shell' &&
          task.terminalId &&
          task.terminalId !== terminalId &&
          (task.status === 'running' || task.status === 'pending'),
      )
      .map((task) => toKind(task.kind)),
    slicePrompt: failed?.prompt ?? null,
  }
}

/** Relaunches the unfinished tasks of an interrupted SPEC run as a new run. */
export async function resumeSpecRun(run: PromptRun): Promise<StartPromptRunResult> {
  const project = useProjectsStore.getState().projects.find((item) => item.id === run.projectId)
  if (!project) return { ok: false, code: 'no-project' }
  const remaining = (run.specTasks ?? []).filter((task) => task.status !== 'done')
  const doneIds = new Set(
    (run.specTasks ?? []).filter((task) => task.status === 'done').map((task) => task.id),
  )
  const tasks = remaining.map((task) => ({
    ...task,
    dependsOn: task.dependsOn.filter((dep) => !doneIds.has(dep)),
  }))
  const pointer = run.boardPath
    ? `Previous run was interrupted. Its board is at ${run.boardPath}; continue from it.`
    : 'Previous run was interrupted. Continue from where it stopped.'
  return launchSpecRun({
    project,
    cwd: run.cwd,
    spec: `${run.prompt.trim()}\n\n---\n${pointer}`,
    tasks: tasks.map((task) => ({ ...task, prompt: `${task.prompt}\n\n${pointer}` })),
  })
}
