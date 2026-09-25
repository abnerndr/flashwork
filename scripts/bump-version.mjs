#!/usr/bin/env node
/**
 * Bump (or set) the Flashwork semver across every source of truth:
 *   package.json (root)
 *   apps/orchestrator/package.json
 *   apps/orchestrator/package-lock.json (root package only)
 *   apps/orchestrator/src-tauri/tauri.conf.json
 *   apps/orchestrator/src-tauri/Cargo.toml
 *   apps/orchestrator/src-tauri/Cargo.lock (crate `flashwork` only)
 *
 * Usage:
 *   node scripts/bump-version.mjs           # patch +1
 *   node scripts/bump-version.mjs patch
 *   node scripts/bump-version.mjs minor
 *   node scripts/bump-version.mjs major
 *   node scripts/bump-version.mjs 1.0.0     # set exact
 *   node scripts/bump-version.mjs --print   # print current, no write
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const printOnly = args.includes('--print')
const bumpArg = args.find((a) => !a.startsWith('--')) ?? 'patch'

const ROOT_PKG = join(root, 'package.json')
const ORCH_PKG = join(root, 'apps/orchestrator/package.json')
const ORCH_LOCK = join(root, 'apps/orchestrator/package-lock.json')
const TAURI = join(root, 'apps/orchestrator/src-tauri/tauri.conf.json')
const CARGO = join(root, 'apps/orchestrator/src-tauri/Cargo.toml')
const CARGO_LOCK = join(root, 'apps/orchestrator/src-tauri/Cargo.lock')

function fail(message) {
  console.error(`bump-version: ${message}`)
  process.exit(1)
}

function readVersion(path) {
  const raw = readFileSync(path, 'utf8')
  const match = raw.match(/"version":\s*"(\d+)\.(\d+)\.(\d+)"/)
  if (!match) fail(`version not found in ${path}`)
  return {
    raw,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    current: `${match[1]}.${match[2]}.${match[3]}`,
  }
}

const { major, minor, patch, current } = readVersion(ROOT_PKG)

if (printOnly) {
  process.stdout.write(`${current}\n`)
  process.exit(0)
}

let next
if (/^\d+\.\d+\.\d+$/.test(bumpArg)) next = bumpArg
else if (bumpArg === 'major') next = `${major + 1}.0.0`
else if (bumpArg === 'minor') next = `${major}.${minor + 1}.0`
else if (bumpArg === 'patch') next = `${major}.${minor}.${patch + 1}`
else fail(`invalid bump "${bumpArg}" (use patch | minor | major | X.Y.Z)`)

function replaceFirst(path, regex, label = path) {
  const raw = readFileSync(path, 'utf8')
  const match = raw.match(regex)
  if (!match) fail(`version not found in ${label}`)
  const updated = raw.replace(regex, (full) => full.replace(match[1], next))
  writeFileSync(path, updated)
  console.log(`  ${label.replace(`${root}/`, '')}: ${match[1]} → ${next}`)
}

console.log(`bump-version: ${current} → ${next}`)
replaceFirst(ROOT_PKG, /"version":\s*"(\d+\.\d+\.\d+)"/)
replaceFirst(ORCH_PKG, /"version":\s*"(\d+\.\d+\.\d+)"/)
replaceFirst(TAURI, /"version":\s*"(\d+\.\d+\.\d+)"/)
replaceFirst(CARGO, /^version\s*=\s*"(\d+\.\d+\.\d+)"/m)

if (existsSync(ORCH_LOCK)) {
  let lock = readFileSync(ORCH_LOCK, 'utf8')
  // Top-level lock version
  lock = lock.replace(/"version":\s*"(\d+\.\d+\.\d+)"/, `"version": "${next}"`)
  // packages[""] workspace root entry
  lock = lock.replace(
    /("name":\s*"flashwork-orchestrator",\s*\n\s*"version":\s*")(\d+\.\d+\.\d+)(")/g,
    `$1${next}$3`,
  )
  writeFileSync(ORCH_LOCK, lock)
  console.log(`  apps/orchestrator/package-lock.json → ${next}`)
}

if (existsSync(CARGO_LOCK)) {
  replaceFirst(
    CARGO_LOCK,
    /name = "flashwork"\r?\nversion = "(\d+\.\d+\.\d+)"/,
    'apps/orchestrator/src-tauri/Cargo.lock',
  )
}

process.stdout.write(`${next}\n`)
