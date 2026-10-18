import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const env = { ...process.env };
const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path') ?? 'PATH';
const cargoBin = join(env.CARGO_HOME || join(homedir(), '.cargo'), 'bin');
// Rustup may have been installed after the current terminal was opened.
env[pathKey] = `${env[pathKey] || ''}${delimiter}${cargoBin}`;

const cargo = spawnSync('cargo', ['--version'], { env, encoding: 'utf8' });
if (cargo.error || cargo.status !== 0) {
  console.error('[flashwork] Cargo is unavailable in this environment. Install Rust with rustup (https://rustup.rs), then reopen your terminal and run pnpm run app.');
  if (cargo.stderr) console.error(cargo.stderr.trim());
  process.exit(1);
}

// Keep WSLg on its default display backend unless explicitly overridden.
if (
  process.platform === 'linux' &&
  existsSync('/proc/version') &&
  /microsoft/i.test(readFileSync('/proc/version', 'utf8')) &&
  env.FLASHWORK_FORCE_X11 === '1'
) {
  env.GDK_BACKEND = 'x11';
  env.WEBKIT_DISABLE_COMPOSITING_MODE ??= '1';
  console.log('[flashwork] WSL: FLASHWORK_FORCE_X11=1 -> GDK_BACKEND=x11');
}

const require = createRequire(import.meta.url);
const result = spawnSync(
  process.execPath,
  [require.resolve('@tauri-apps/cli/tauri.js'), 'dev', '--config', 'src-tauri/tauri.dev.json', ...process.argv.slice(2)],
  { env, stdio: 'inherit' },
);
if (result.error) console.error(`[flashwork] Could not launch Tauri: ${result.error.message}`);
process.exit(result.status ?? 1);
