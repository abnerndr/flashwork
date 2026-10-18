import { AGENT_TYPE_LABELS, type AgentType, type SpecTask, type SpecTaskKind } from '../types'
import { planAutoLanes, type PlanAutoLanesInput } from './planAutoLanes'
import { selectAgent } from './selectAgent'

/** Upper bound on lanes one SPEC opens. */
export const MAX_SPEC_TASKS = 8

const SPEC_KINDS: ReadonlySet<SpecTaskKind> = new Set<SpecTaskKind>([
  'implement',
  'review',
  'mechanical',
  'explore',
  'ui',
  'shell',
])

/** Kinds that edit files and therefore must not share ownership. */
const WRITER_KINDS: ReadonlySet<SpecTaskKind> = new Set<SpecTaskKind>(['implement', 'ui', 'mechanical'])

/** Short strengths the planner sees for each installed CLI. */
export const AGENT_STRENGTHS: Partial<Record<AgentType, string>> = {
  claude: 'strongest at multi-file implementation, refactors and careful reasoning',
  codex: 'fast at focused implementation, tests and mechanical edits',
  gemini: 'large context; good at exploration, docs and broad reads',
  opencode: 'general coding agent; good for mechanical and scripted work',
  copilot: 'quick edits and small features',
  antigravity: 'UI and visual/front-end work',
  mimo: 'lightweight general tasks',
  freebuff: 'lightweight general tasks',
}

export function extractJsonObject(text: string): unknown | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as unknown
  } catch {
    return null
  }
}

export function normalizePathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').toLowerCase()
}

/** Empty list means the whole repo, so it conflicts with any sibling. */
export function filesOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return true
  const rightKeys = right.map(normalizePathKey)
  return left.some((file) => {
    const key = normalizePathKey(file)
    return rightKeys.some(
      (other) => other === key || other.startsWith(`${key}/`) || key.startsWith(`${other}/`),
    )
  })
}

export function buildSpecPlannerPrompt(input: { spec: string; agents: readonly AgentType[] }): string {
  const roster = input.agents
    .filter((agent) => agent !== 'shell')
    .map((agent) => `- ${agent} (${AGENT_TYPE_LABELS[agent]}): ${AGENT_STRENGTHS[agent] ?? 'general coding'}`)
    .join('\n')
  return [
    'You are the planner for Flashwork, which runs several coding CLIs in parallel on the repository in the current directory.',
    'Read the SPEC below, look at the repository (read-only) as needed, and split the work into tasks.',
    'Rules:',
    '- One task per independent area of the repository (for example, changes in 3 areas -> 3 tasks).',
    '- No two tasks may own the same file. "files" lists the repo-relative files or folders the task owns.',
    '- Use "dependsOn" only when a task needs another task\'s output (for example a review after an implementation).',
    '- "agent" must be one of the available CLIs below; match each task to the CLI strengths.',
    '- "kind" is one of implement, review, mechanical, explore, ui, shell.',
    '- Use kind "shell" with "shell": true and a "command" only for a plain terminal command (dev server, watcher), never for coding work.',
    `- At most ${MAX_SPEC_TASKS} tasks. Each "prompt" must be self-contained and actionable.`,
    'Available CLIs:',
    roster || '- (none)',
    'Return ONLY a JSON object, no markdown fences, no commentary:',
    '{"tasks":[{"id":"t1","title":"short title","prompt":"what to do","files":["src/area/"],"kind":"implement","agent":"claude","dependsOn":[],"shell":false,"command":""}]}',
    'SPEC:',
    '<<<',
    input.spec.trim(),
    '>>>',
  ].join('\n')
}

export type SpecPlanContext = Omit<PlanAutoLanesInput, 'prompt' | 'includeOrchestrator'> & {
  spec: string
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function asKind(row: Record<string, unknown>): SpecTaskKind | null {
  if (row.shell === true) return 'shell'
  if (typeof row.kind === 'string' && SPEC_KINDS.has(row.kind as SpecTaskKind)) {
    return row.kind as SpecTaskKind
  }
  return null
}

function codingAgents(ctx: SpecPlanContext): AgentType[] {
  return ctx.installedAgents.filter((agent) => agent !== 'shell')
}

/** Picks the CLI for a task: the planner's choice when installed, else the local router. */
export function resolveSpecAgent(
  wanted: unknown,
  kind: SpecTaskKind,
  prompt: string,
  ctx: SpecPlanContext,
): AgentType | null {
  if (kind === 'shell') return 'shell'
  const installed = codingAgents(ctx)
  const direct = installed.find((agent) => agent === wanted)
  if (direct) return direct
  const choice = selectAgent({
    prompt,
    enabledAgents: installed,
    installedAgents: installed,
    claudeFiveHourUtilization: ctx.claudeFiveHourUtilization,
    codexRateLimited: ctx.codexRateLimited,
    reviewAgentProvider: ctx.reviewAgentProvider,
    conflictAgentProvider: ctx.conflictAgentProvider,
    lastUsedAgent: ctx.lastUsedAgent,
    forcedKind: kind,
  })
  return choice?.agent ?? installed[0] ?? null
}

function uniqueId(raw: unknown, index: number, used: Set<string>): string {
  const base =
    typeof raw === 'string' && /^[\w.-]{1,32}$/.test(raw.trim()) ? raw.trim() : `t${index + 1}`
  let id = base
  let suffix = 2
  while (used.has(id)) {
    id = `${base}_${suffix}`
    suffix += 1
  }
  used.add(id)
  return id
}

/** Parses the Gemini planner reply. Returns [] when it is not a usable plan. */
export function parseSpecPlan(text: string, ctx: SpecPlanContext): SpecTask[] {
  const parsed = extractJsonObject(text)
  if (!parsed || typeof parsed !== 'object') return []
  const rawTasks = (parsed as { tasks?: unknown }).tasks
  if (!Array.isArray(rawTasks)) return []
  const ids = new Set<string>()
  const idMap = new Map<string, string>()
  const tasks: SpecTask[] = []
  for (const [index, raw] of rawTasks.entries()) {
    if (tasks.length >= MAX_SPEC_TASKS) break
    if (!raw || typeof raw !== 'object') continue
    const row = raw as Record<string, unknown>
    const kind = asKind(row) ?? 'implement'
    const prompt = typeof row.prompt === 'string' ? row.prompt.trim() : ''
    const command = typeof row.command === 'string' ? row.command.trim() : ''
    if (!prompt && !(kind === 'shell' && command)) continue
    const agent = resolveSpecAgent(row.agent, kind, prompt || ctx.spec, ctx)
    if (!agent) continue
    const id = uniqueId(row.id, index, ids)
    if (typeof row.id === 'string') idMap.set(row.id.trim(), id)
    const title =
      typeof row.title === 'string' && row.title.trim()
        ? row.title.trim().slice(0, 120)
        : (prompt || command).split('\n')[0].slice(0, 80)
    tasks.push({
      id,
      title,
      prompt: prompt || command,
      files: kind === 'shell' ? [] : asStringArray(row.files),
      kind,
      agent,
      dependsOn: asStringArray(row.dependsOn),
      ...(kind === 'shell' && command ? { command } : {}),
      status: 'pending',
    })
  }
  for (const task of tasks) {
    task.dependsOn = task.dependsOn.map((dep) => idMap.get(dep) ?? dep)
  }
  return normalizeSpecTasks(tasks)
}

function hasCycle(tasks: readonly SpecTask[]): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const state = new Map<string, 'visiting' | 'done'>()
  const visit = (id: string): boolean => {
    const mark = state.get(id)
    if (mark === 'done') return false
    if (mark === 'visiting') return true
    state.set(id, 'visiting')
    for (const dep of byId.get(id)?.dependsOn ?? []) {
      if (visit(dep)) return true
    }
    state.set(id, 'done')
    return false
  }
  return tasks.some((task) => visit(task.id))
}

/**
 * Makes a plan safe to launch: valid dependency ids, no cycles, and one owner per file.
 * A writer task that overlaps an earlier writer is serialized after it and drops the shared
 * files; reviews wait for every writer.
 */
export function normalizeSpecTasks(input: readonly SpecTask[]): SpecTask[] {
  const tasks = input
    .slice(0, MAX_SPEC_TASKS)
    .map((task) => ({ ...task, files: [...task.files], dependsOn: [...task.dependsOn] }))
  const ids = new Set(tasks.map((task) => task.id))
  for (const task of tasks) {
    task.dependsOn = [...new Set(task.dependsOn.filter((dep) => dep !== task.id && ids.has(dep)))]
  }
  if (hasCycle(tasks)) {
    // Keep only edges that point backwards in the list, which cannot form a cycle.
    tasks.forEach((task, index) => {
      const earlier = new Set(tasks.slice(0, index).map((item) => item.id))
      task.dependsOn = task.dependsOn.filter((dep) => earlier.has(dep))
    })
  }
  const writers: SpecTask[] = []
  for (const task of tasks) {
    if (!WRITER_KINDS.has(task.kind)) continue
    for (const previous of writers) {
      if (!filesOverlap(previous.files, task.files)) continue
      const ordered =
        task.dependsOn.includes(previous.id) ||
        dependsOnTransitively(tasks, previous.id, task.id) ||
        dependsOnTransitively(tasks, task.id, previous.id)
      if (!ordered) task.dependsOn.push(previous.id)
      const remaining = task.files.filter((file) => !filesOverlap(previous.files, [file]))
      if (remaining.length > 0) task.files = remaining
    }
    writers.push(task)
  }
  const writerIds = writers.map((task) => task.id)
  for (const task of tasks) {
    if (task.kind !== 'review') continue
    const deps = writerIds.filter((id) => !dependsOnTransitively(tasks, task.id, id) && id !== task.id)
    task.dependsOn = [...new Set([...task.dependsOn, ...deps])]
  }
  return tasks
}

/** True when `from` (directly or indirectly) depends on `target`. */
function dependsOnTransitively(tasks: readonly SpecTask[], target: string, from: string): boolean {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const seen = new Set<string>()
  const stack = [...(byId.get(from)?.dependsOn ?? [])]
  while (stack.length > 0) {
    const id = stack.pop() as string
    if (id === target) return true
    if (seen.has(id)) continue
    seen.add(id)
    stack.push(...(byId.get(id)?.dependsOn ?? []))
  }
  return false
}

/** Offline fallback when the Gemini pre-pass is missing or fails. */
export function heuristicSpecTasks(ctx: SpecPlanContext): SpecTask[] {
  const lanes = planAutoLanes({ ...ctx, prompt: ctx.spec, includeOrchestrator: false }).filter(
    (lane) => lane.role === 'worker',
  )
  const tasks: SpecTask[] = []
  for (const [index, lane] of lanes.entries()) {
    if (lane.agent.startsWith('api:')) continue
    const kind: SpecTaskKind = lane.taskKind === 'unknown' ? 'implement' : lane.taskKind
    tasks.push({
      id: `t${index + 1}`,
      title: `${kind} · ${AGENT_TYPE_LABELS[lane.agent as AgentType]}`,
      prompt: lane.slicePrompt,
      files: [],
      kind,
      agent: lane.agent as AgentType,
      dependsOn: [],
      status: 'pending',
    })
  }
  return normalizeSpecTasks(tasks)
}

/** Removes a task and every dependency edge pointing at it. */
export function removeSpecTask(tasks: readonly SpecTask[], id: string): SpecTask[] {
  return tasks
    .filter((task) => task.id !== id)
    .map((task) => ({ ...task, dependsOn: task.dependsOn.filter((dep) => dep !== id) }))
}

export function readySpecTasks(tasks: readonly SpecTask[]): SpecTask[] {
  const settled = new Set(
    tasks.filter((task) => task.status === 'done').map((task) => task.id),
  )
  return tasks.filter(
    (task) => task.status === 'pending' && task.dependsOn.every((dep) => settled.has(dep)),
  )
}

/** Done when every task finished, failed, or is stuck behind a failed dependency. */
export function specRunSettled(tasks: readonly SpecTask[]): boolean {
  const failed = new Set(tasks.filter((task) => task.status === 'failed').map((task) => task.id))
  const blocked = (task: SpecTask, seen = new Set<string>()): boolean =>
    task.dependsOn.some((dep) => {
      if (failed.has(dep)) return true
      if (seen.has(dep)) return false
      seen.add(dep)
      const parent = tasks.find((item) => item.id === dep)
      return parent ? blocked(parent, seen) : false
    })
  return tasks.every(
    (task) => task.status === 'done' || task.status === 'failed' || (task.status === 'pending' && blocked(task)),
  )
}

export function projectBoardRelativePath(runId: string): string {
  return `.flashwork/runs/${runId}/board.md`
}

export function renderSpecBoard(args: {
  runId: string
  spec: string
  tasks: readonly SpecTask[]
}): string {
  const roster = args.tasks
    .map((task) => {
      const deps = task.dependsOn.length ? ` · depends on ${task.dependsOn.join(', ')}` : ''
      const files = task.files.length ? task.files.join(', ') : 'whole repo'
      return `- ${task.id} · ${task.title} · ${AGENT_TYPE_LABELS[task.agent]} · ${task.kind} · ${task.status} · files: ${files}${deps}`
    })
    .join('\n')
  return [
    `# Run ${args.runId}`,
    '',
    '## SPEC',
    '',
    args.spec.trim(),
    '',
    '## Tasks',
    '',
    roster || '- (none)',
    '',
    '## Notes',
    '',
    'Each task appends its status and findings below under its task id. Do not redo a sibling task.',
    '',
  ].join('\n')
}
