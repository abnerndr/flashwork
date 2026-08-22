import type { TaskBoardColumn } from '../types'

export const TASK_BOARD_COLUMNS: TaskBoardColumn[] = [
  'backlog',
  'todo',
  'doing',
  'verify',
  'done',
  'blocked',
]

export function cardDragId(cardId: string): string {
  return `card:${cardId}`
}

export function columnDropId(column: TaskBoardColumn): string {
  return `col:${column}`
}

export function parseBoardDrop(
  activeId: string | number,
  overId: string | number | null | undefined,
): { cardId: string; column: TaskBoardColumn } | null {
  const active = String(activeId)
  const over = overId == null ? '' : String(overId)
  if (!active.startsWith('card:') || !over.startsWith('col:')) return null
  const cardId = active.slice('card:'.length)
  const column = over.slice('col:'.length) as TaskBoardColumn
  if (!cardId || !TASK_BOARD_COLUMNS.includes(column)) return null
  return { cardId, column }
}
