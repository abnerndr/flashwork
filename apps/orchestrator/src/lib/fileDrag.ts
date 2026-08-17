export const FLASHWORK_FILE_DRAG_TYPE = 'application/x-flashwork-file'

export type FlashworkFileDragPayload = {
  projectId: string
  path: string
}

export function writeFileDragPayload(
  dataTransfer: DataTransfer,
  payload: FlashworkFileDragPayload,
): void {
  dataTransfer.effectAllowed = 'copy'
  dataTransfer.setData(FLASHWORK_FILE_DRAG_TYPE, JSON.stringify(payload))
  dataTransfer.setData('text/plain', payload.path)
}

export function readFileDragPayload(dataTransfer: DataTransfer): FlashworkFileDragPayload | null {
  const raw = dataTransfer.getData(FLASHWORK_FILE_DRAG_TYPE)
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<FlashworkFileDragPayload>
    if (typeof value.projectId !== 'string' || typeof value.path !== 'string') return null
    const projectId = value.projectId.trim()
    const path = value.path.trim()
    return projectId && path ? { projectId, path } : null
  } catch {
    return null
  }
}

export function hasFileDragPayload(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(FLASHWORK_FILE_DRAG_TYPE)
}
