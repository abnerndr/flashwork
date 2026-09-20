const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  md: 'markdown',
  markdown: 'markdown',
  mdx: 'markdown',
  rs: 'rust',
  py: 'python',
  toml: 'ini',
  yml: 'yaml',
  yaml: 'yaml',
  xml: 'xml',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  ps1: 'powershell',
  sql: 'sql',
  go: 'go',
  java: 'java',
  kt: 'kotlin',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  rb: 'ruby',
  swift: 'swift',
  vue: 'html',
  svelte: 'html',
}

export function languageForPath(rel: string): string {
  const base = rel.split(/[\\/]/).pop() ?? rel
  if (base.toLowerCase() === 'dockerfile') return 'dockerfile'
  const dot = base.lastIndexOf('.')
  if (dot < 0) return 'plaintext'
  return LANGUAGE_BY_EXT[base.slice(dot + 1).toLowerCase()] ?? 'plaintext'
}
