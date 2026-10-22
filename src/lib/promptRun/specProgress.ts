import type { SpecTaskStatus } from '../types'

export type SpecProgress = {
  total: number
  done: number
  remaining: number
  percent: number
  currentTitle: string | null
  /** Null until at least one task has finished. */
  etaMs: number | null
}

export function specProgress(
  tasks: readonly { status: SpecTaskStatus; title: string }[],
  startedAt: number,
  now: number,
): SpecProgress {
  const total = tasks.length
  const done = tasks.filter((task) => task.status === 'done').length
  const current =
    tasks.find((task) => task.status === 'running') ??
    tasks.find((task) => task.status === 'pending') ??
    tasks.find((task) => task.status === 'queued')
  const remaining = tasks.filter(
    (task) => task.status === 'pending' || task.status === 'running' || task.status === 'queued',
  ).length
  const percent = total === 0 ? 0 : Math.round((done / total) * 100)
  const elapsed = Math.max(0, now - startedAt)
  const etaMs = done === 0 || remaining === 0 ? null : Math.round((elapsed / done) * remaining)
  return {
    total,
    done,
    remaining,
    percent,
    currentTitle: current?.title ?? null,
    etaMs,
  }
}

export function formatEta(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}
