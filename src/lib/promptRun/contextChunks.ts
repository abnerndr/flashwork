export type ContextChunk = {
  id: string
  source: 'claude' | 'codex' | 'journal'
  sessionId: string
  kind: 'user' | 'assistant' | 'tool' | 'files'
  files: string[]
  turn: number
  text: string
}

export const CHUNK_CHAR_CAP = 4000

export function splitExtractiveChunks(
  events: Array<{ role: ContextChunk['kind']; text: string; files: string[] }>,
  sessionId: string,
  source: ContextChunk['source'],
): ContextChunk[] {
  const chunks: ContextChunk[] = []
  let bucket: typeof events = []
  let files = new Set<string>()
  let turn = 0
  const flush = () => {
    if (bucket.length === 0) return
    const text = bucket.map((event) => event.text).join('\n\n')
    chunks.push({
      id: String(chunks.length + 1).padStart(4, '0'),
      source,
      sessionId,
      kind: bucket[0]?.role ?? 'user',
      files: [...files],
      turn,
      text: text.slice(0, CHUNK_CHAR_CAP),
    })
    bucket = []
    files = new Set()
    turn += 1
  }
  for (const event of events) {
    const sameFiles =
      event.files.length > 0 &&
      event.files.every((file) => files.size === 0 || files.has(file))
    const nextSize = bucket.map((item) => item.text).join('\n\n').length + event.text.length
    if (bucket.length > 0 && (!sameFiles || nextSize > CHUNK_CHAR_CAP)) flush()
    bucket.push(event)
    for (const file of event.files) files.add(file)
  }
  flush()
  return chunks
}

export function searchChunks(
  chunks: ContextChunk[],
  query: { file?: string; terms: string[] },
  byteBudget = 8192,
): ContextChunk[] {
  const scored = chunks
    .map((chunk) => {
      const fileHit =
        query.file && chunk.files.some((file) => file.replace(/\\/g, '/') === query.file)
      const termHits = query.terms.filter((term) =>
        chunk.text.toLowerCase().includes(term.toLowerCase()),
      ).length
      const hits = (fileHit ? 10 : 0) + termHits
      return { chunk, score: hits > 0 ? hits + chunk.turn / 1000 : 0 }
    })
    .filter((row) => row.score > 0)
    .sort((left, right) => right.score - left.score)
  const picked: ContextChunk[] = []
  let used = 0
  for (const row of scored) {
    if (used + row.chunk.text.length > byteBudget) break
    picked.push(row.chunk)
    used += row.chunk.text.length
  }
  return picked
}
