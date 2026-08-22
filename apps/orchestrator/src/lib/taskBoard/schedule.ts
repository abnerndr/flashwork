import type { TaskCard, TaskSlicePlan } from '../types'

export function normalizePathKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function toCwdRelative(cwd: string, filePath: string): string {
  const normCwd = normalizePathKey(cwd)
  const normPath = filePath.replace(/\\/g, '/')
  const prefix = `${normCwd}/`
  if (normalizePathKey(normPath).startsWith(prefix)) {
    return normPath.slice(cwd.replace(/\\/g, '/').replace(/\/+$/, '').length + 1)
  }
  return filePath
}

/** Empty allowlist means the whole repo, so it conflicts with any sibling in the same cwd. */
export function filesOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return true
  const other = new Set(right.map(normalizePathKey))
  return left.some((file) => other.has(normalizePathKey(file)))
}

export function cardFilesConflict(candidate: TaskCard, busy: readonly TaskCard[]): boolean {
  const cwd = normalizePathKey(candidate.cwd)
  return busy
    .filter((card) => normalizePathKey(card.cwd) === cwd)
    .some((card) => filesOverlap(candidate.allowedFiles, card.allowedFiles))
}

export function readySlices(plan: readonly TaskSlicePlan[]): TaskSlicePlan[] {
  const done = new Set(plan.filter((slice) => slice.status === 'done').map((slice) => slice.id))
  return plan.filter(
    (slice) => slice.status === 'pending' && slice.dependsOn.every((id) => done.has(id)),
  )
}

/** Only slices whose dependencies are already done. Never fall back to the full plan. */
export function launchableSlices(plan: readonly TaskSlicePlan[]): TaskSlicePlan[] {
  return readySlices(plan)
}

export function pickNextTaskCard(
  cards: readonly TaskCard[],
  blockedProjectIds: ReadonlySet<string>,
): TaskCard | null {
  const todo = cards
    .filter((card) => card.column === 'todo')
    .sort((left, right) => left.priority - right.priority || left.createdAt - right.createdAt)
  const busy = cards.filter((card) => card.column === 'doing' || card.column === 'verify')
  for (const card of todo) {
    if (blockedProjectIds.has(card.projectId)) continue
    if (cardFilesConflict(card, busy)) continue
    return card
  }
  return null
}
