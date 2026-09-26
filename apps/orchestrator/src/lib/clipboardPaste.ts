import type { ClipboardEvent as ReactClipboardEvent } from 'react'

import { readClipboardText } from './tauri/filesystem'

/**
 * Resolve paste text for composers. On WSL the browser paste event often has an
 * empty `clipboardData` even when Windows Notepad/Chrome has content — fall back
 * to the Rust bridge (`read_clipboard_text`).
 */
export async function resolveComposerPasteText(event: ClipboardEvent): Promise<string> {
  const fromEvent = event.clipboardData?.getData('text/plain') ?? ''
  if (fromEvent) return fromEvent
  try {
    const fromRust = await readClipboardText()
    if (fromRust) return fromRust
  } catch {
    // ignore — try browser clipboard next
  }
  try {
    return (await navigator.clipboard?.readText()) ?? ''
  } catch {
    return ''
  }
}

/** Insert text at the caret of an uncontrolled input/textarea and notify React. */
export function insertTextAtCaret(
  field: HTMLInputElement | HTMLTextAreaElement,
  text: string,
): void {
  const start = field.selectionStart ?? field.value.length
  const end = field.selectionEnd ?? field.value.length
  const next = field.value.slice(0, start) + text + field.value.slice(end)
  field.value = next
  const caret = start + text.length
  field.setSelectionRange(caret, caret)
  field.dispatchEvent(new Event('input', { bubbles: true }))
  field.dispatchEvent(new Event('change', { bubbles: true }))
}

/**
 * Paste handler for uncontrolled fields. Prevents the default only when the
 * event clipboard is empty and we successfully resolve text via the bridge.
 */
export function handleUncontrolledPaste(
  event: ReactClipboardEvent<HTMLInputElement | HTMLTextAreaElement>,
): void {
  const fromEvent = event.clipboardData?.getData('text/plain') ?? ''
  if (fromEvent) return
  event.preventDefault()
  const field = event.currentTarget
  void resolveComposerPasteText(event.nativeEvent).then((text) => {
    if (!text) return
    insertTextAtCaret(field, text)
  })
}

/**
 * Build the next controlled value after a paste, preserving caret range.
 * Returns null when the browser already provided clipboardData (caller should
 * let the default handler run).
 */
export async function resolveControlledPasteValue(
  event: ClipboardEvent,
  current: string,
  selectionStart: number,
  selectionEnd: number,
): Promise<string | null> {
  const fromEvent = event.clipboardData?.getData('text/plain') ?? ''
  if (fromEvent) return null
  const text = await resolveComposerPasteText(event)
  if (!text) return null
  return current.slice(0, selectionStart) + text + current.slice(selectionEnd)
}
