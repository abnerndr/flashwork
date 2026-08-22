/** Home unmounts when opening the workspace, so the typed draft must survive in the UI store. */
export function resolveHomeQuickPrompt(storedDraft: string): string {
  return storedDraft.trim() ? storedDraft : ''
}
