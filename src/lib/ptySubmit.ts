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
 * One typed line plus Enter (single string). Prefer `writePtySubmitText` for live
 * PTYs: Ink composers on Linux/WSL often ignore a trailing CR glued to a large
 * payload. Bracketed paste also swallows the following return.
 */
export function submitPtyLine(text: string): string {
  const flat = flattenInitialPtyInput(text)
  return flat ? `${flat}\r` : ''
}
