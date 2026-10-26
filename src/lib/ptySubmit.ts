/**
 * ConPTY treats `\n` as Enter unless the CLI is in bracketed paste.
 * A multi-line bootstrap would submit only the first line.
 */
export function flattenInitialPtyInput(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .trim()
    .replace(/\n+/g, ' ')
}

/**
 * One typed line plus Enter.
 * Bracketed paste drops the text in the composer and swallows the following
 * return, so Claude and Codex wait until a person presses Enter.
 */
export function submitPtyLine(text: string): string {
  const flat = flattenInitialPtyInput(text)
  return flat ? `${flat}\r` : ''
}
