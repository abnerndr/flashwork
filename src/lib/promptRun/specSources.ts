export const MAX_SPEC_FILES = 8

export type SpecFile = { name: string; content: string }

/** Joins typed text and attached Markdown into one planner SPEC, keeping each file identifiable. */
export function joinSpecSources(text: string, files: readonly SpecFile[]): string {
  const attached = files
    .map((file) => {
      const body = file.content.trim()
      if (!body) return ''
      return `## SPEC file: ${file.name}\n\n${body}`
    })
    .filter(Boolean)
  const typed = text.trim()
  const parts = [...attached]
  if (typed) parts.push(attached.length > 0 ? `## Typed SPEC\n\n${typed}` : typed)
  return parts.join('\n\n')
}
