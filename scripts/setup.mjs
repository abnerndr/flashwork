#!/usr/bin/env node
/**
 * Flashwork — cross-platform bootstrap.
 *
 * Ensures Node >= 22, pnpm, Rust (cargo), OS packages for Tauri, then `pnpm install`.
 *
 * Usage (from repo root):
 *   pnpm run setup
 *   node scripts/setup.mjs
 *   node scripts/setup.mjs --deps-only      # only ensure pnpm + install packages
 *   node scripts/setup.mjs --skip-system    # skip apt / Xcode / VS checks
 *
 * Also invoked by scripts/setup-linux.sh, setup-macos.sh, setup-windows.ps1.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, platform } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const isWin = platform() === 'win32'
const isMac = platform() === 'darwin'
const isLinux = platform() === 'linux'
const args = new Set(process.argv.slice(2))
const depsOnly = args.has('--deps-only')
const skipSystem = args.has('--skip-system') || depsOnly

const PNPM_VERSION = '10.12.1'

function log(msg) {
  console.log(msg)
}

function fail(msg) {
  console.error(`[flashwork setup] ${msg}`)
  process.exit(1)
}

function which(cmd, env = process.env) {
  // `command` is a shell builtin — never spawn it as a binary.
  const result = isWin
    ? spawnSync('where.exe', [cmd], { encoding: 'utf8', env, shell: false })
    : spawnSync('sh', ['-lc', `command -v ${JSON.stringify(cmd)}`], {
        encoding: 'utf8',
        env,
      })
  return result.status === 0 && Boolean(result.stdout?.trim())
}

function run(cmd, cmdArgs, opts = {}) {
  const result = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    stdio: 'inherit',
    env: opts.env ?? process.env,
    shell: opts.shell ?? isWin,
  })
  if ((result.status ?? 1) !== 0 && !opts.allowFail) {
    fail(`command failed: ${cmd} ${cmdArgs.join(' ')}`)
  }
  return result
}

function runCapture(cmd, cmdArgs, opts = {}) {
  return spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env: opts.env ?? process.env,
    shell: opts.shell ?? isWin,
  })
}

function withCargoPath(env = process.env) {
  const next = { ...env }
  const pathKey = Object.keys(next).find((key) => key.toLowerCase() === 'path') ?? 'PATH'
  const cargoBin = join(next.CARGO_HOME || join(homedir(), '.cargo'), 'bin')
  next[pathKey] = `${next[pathKey] || ''}${delimiter}${cargoBin}`
  return next
}

function nodeMajor() {
  return Number(process.versions.node.split('.')[0])
}

function ensureNode() {
  log(`==> Node.js (found ${process.version})`)
  if (nodeMajor() < 22) {
    fail('Node.js >= 22 is required. Install from https://nodejs.org or use nvm/fnm.')
  }
}

function pnpmVersion(env = process.env) {
  const ver = runCapture('pnpm', ['--version'], { env })
  return ver.status === 0 ? ver.stdout?.trim() : null
}

function ensurePnpm(env = process.env) {
  log('==> pnpm')
  const existing = pnpmVersion(env)
  if (existing) {
    log(`    using pnpm ${existing}`)
    return
  }

  log('    pnpm not found — enabling via Corepack…')
  const corepack = runCapture('corepack', ['--version'], { env })
  if (corepack.status === 0) {
    run('corepack', ['enable'], { allowFail: true, env })
    run('corepack', ['prepare', `pnpm@${PNPM_VERSION}`, '--activate'], { env, allowFail: true })
  }

  if (!pnpmVersion(env)) {
    log('    Corepack did not expose pnpm — installing with npm -g…')
    run('npm', ['install', '-g', `pnpm@${PNPM_VERSION}`], { env })
  }

  const installed = pnpmVersion(env)
  if (!installed) {
    fail('Could not install pnpm. Install manually: https://pnpm.io/installation')
  }
  log(`    pnpm ${installed} ready`)
}

function ensureRust() {
  log('==> Rust (cargo)')
  const env = withCargoPath()
  let cargo = runCapture('cargo', ['--version'], { env })
  if (cargo.status === 0) {
    log(`    ${cargo.stdout?.trim()}`)
    return env
  }

  if (isWin) {
    log('    Rust not found. Trying winget (Rustlang.Rustup)…')
    const winget = run('winget', ['install', '-e', '--id', 'Rustlang.Rustup', '--accept-package-agreements', '--accept-source-agreements'], {
      allowFail: true,
    })
    if ((winget.status ?? 1) !== 0) {
      fail(
        'Rust is required. Install rustup from https://rustup.rs, reopen the terminal, then re-run pnpm run setup.',
      )
    }
  } else {
    log('    Installing Rust via rustup…')
    const script = "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y"
    run('bash', ['-lc', script], { shell: false })
  }

  const refreshed = withCargoPath()
  cargo = runCapture('cargo', ['--version'], { env: refreshed })
  if (cargo.status !== 0) {
    fail('Rust installed but cargo is not on PATH. Reopen the terminal and re-run pnpm run setup.')
  }
  log(`    ${cargo.stdout?.trim()}`)
  return refreshed
}

function ensureLinuxSystemDeps() {
  log('==> Linux / WSL system packages (Tauri)')
  if (!which('apt-get')) {
    log('    apt-get not found. Install Tauri deps manually:')
    log('    https://v2.tauri.app/start/prerequisites/#linux')
    return
  }
  run('sudo', ['apt-get', 'update'])
  run('sudo', [
    'env',
    'DEBIAN_FRONTEND=noninteractive',
    'apt-get',
    'install',
    '-y',
    'build-essential',
    'curl',
    'wget',
    'file',
    'pkg-config',
    'libssl-dev',
    'libgtk-3-dev',
    'libwebkit2gtk-4.1-dev',
    'libayatana-appindicator3-dev',
    'librsvg2-dev',
    'patchelf',
    'libdbus-1-dev',
  ])
}

function ensureMacSystemDeps() {
  log('==> macOS toolchain')
  const xcode = runCapture('xcode-select', ['-p'])
  if (xcode.status !== 0) {
    log('    Installing Xcode Command Line Tools (GUI dialog may appear)…')
    run('xcode-select', ['--install'], { allowFail: true })
    fail('Finish the Xcode Command Line Tools installer, then re-run: pnpm run setup')
  }
  log('    Xcode CLT OK')
}

function ensureWindowsSystemDeps() {
  log('==> Windows native toolchain')
  log('    Required once (install if missing):')
  log('      - Visual Studio Build Tools → workload "Desktop development with C++"')
  log('        https://visualstudio.microsoft.com/downloads/')
  log('      - WebView2 Runtime (usually present on Windows 11)')
  log('        https://developer.microsoft.com/microsoft-edge/webview2/')

  // Best-effort detect link.exe / MSVC without failing the whole setup.
  const link = runCapture('where', ['link'], { shell: true })
  if (link.status === 0) {
    log('    MSVC linker (link.exe) found on PATH')
  } else {
    log('    WARNING: link.exe not on PATH. Open a "x64 Native Tools" / vcvars64 shell')
    log('    before `pnpm run installer` if the release build fails.')
  }
}

function ensureSystemDeps() {
  if (skipSystem) {
    log('==> Skipping OS system packages (--skip-system / --deps-only)')
    return
  }
  if (isLinux) ensureLinuxSystemDeps()
  else if (isMac) ensureMacSystemDeps()
  else if (isWin) ensureWindowsSystemDeps()
  else log(`==> Unknown platform ${platform()} — skipping system packages`)
}

function pnpmInstall(env) {
  log('==> pnpm install')
  // CI=true makes pnpm non-interactive (e.g. confirm modules purge when switching from npm).
  run('pnpm', ['install'], { env: { ...env, CI: env.CI ?? 'true' } })
}

function verify(env) {
  log('==> Verify')
  const checks = [
    ['node', ['-v']],
    ['pnpm', ['--version']],
    ['cargo', ['--version']],
    ['rustc', ['--version']],
  ]
  for (const [cmd, cmdArgs] of checks) {
    const result = runCapture(cmd, cmdArgs, { env })
    if (result.status !== 0) fail(`${cmd} check failed`)
    log(`    ${cmd}: ${result.stdout.trim()}`)
  }

  try {
    const require = createRequire(import.meta.url)
    require.resolve('@tauri-apps/cli/tauri.js')
    log('    @tauri-apps/cli: OK')
  } catch {
    fail('@tauri-apps/cli missing after install — pnpm install may have failed')
  }

  if (isLinux && existsSync('/proc/version')) {
    const proc = readFileSync('/proc/version', 'utf8')
    if (/microsoft/i.test(proc)) {
      log('    WSL detected — GUI uses WSLg Wayland with the D3D12 GL driver.')
    }
  }
}

function main() {
  log('==> Flashwork setup')
  log(`    repo: ${ROOT}`)
  log(`    os:   ${platform()}${depsOnly ? ' (deps-only)' : ''}`)
  log('')

  ensureNode()
  let env = withCargoPath()
  ensurePnpm(env)
  if (!depsOnly) {
    env = ensureRust()
    const cargo = runCapture('cargo', ['--version'], { env })
    if (cargo.status !== 0) fail('cargo unavailable after PATH refresh')
  }
  ensureSystemDeps()
  pnpmInstall(env)
  verify(withCargoPath(env))

  log('')
  log('OK. Next:')
  log('  pnpm run app          # Tauri + Vite (full desktop)')
  log('  pnpm run dev:ui       # Vite only (no PTYs)')
  log('  pnpm run test:local   # lint + unit tests + frontend build')
  if (isWin) {
    log('  pnpm run installer:windows')
  } else if (isMac) {
    log('  pnpm run installer:macos')
  } else {
    log('  pnpm run installer:linux')
  }
}

main()
