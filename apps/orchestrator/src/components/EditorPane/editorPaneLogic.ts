export type DirtyBuffer = {
  value: string
  savedValue: string
}

export type ReadError = {
  rel: string
  message: string
}

/** Close proceeds unless the buffer is dirty and the user cancels the confirm. */
export function shouldCloseBuffer(
  buffer: DirtyBuffer | undefined,
  confirmDiscard: () => boolean,
): boolean {
  if (!buffer || buffer.value === buffer.savedValue) return true
  return confirmDiscard()
}

export type FailedOpenResult = {
  /** Never open an empty editor for a failed read. */
  openBuffer: false
  readError: ReadError | null
  toast: boolean
}

/**
 * Associate a failed open with the file that failed.
 * A too-large file must not become a tab; if another buffer is already showing,
 * toast instead of painting the error onto that tab.
 */
export function resolveFailedOpen(args: {
  failedRel: string
  message: string
  tooLarge: boolean
  activeRel: string | null
}): FailedOpenResult {
  const { failedRel, message, tooLarge, activeRel } = args
  if (tooLarge && activeRel !== null && activeRel !== failedRel) {
    return { openBuffer: false, readError: null, toast: true }
  }
  return {
    openBuffer: false,
    readError: { rel: failedRel, message },
    toast: !tooLarge,
  }
}

export type ReadErrorPlacement = 'banner' | 'inline' | 'none'

/** Banner only when the error belongs to the active tab; otherwise keep it off that file. */
export function readErrorPlacement(
  error: ReadError | null,
  activeRel: string | null,
): ReadErrorPlacement {
  if (!error) return 'none'
  if (activeRel === null) return 'inline'
  if (error.rel === activeRel) return 'banner'
  return 'none'
}
