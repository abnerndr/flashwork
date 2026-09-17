# CLI install and update (Windows, Linux, macOS) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Installing a missing coding CLI and updating an existing one works on Windows, Linux, and macOS. Today the catalog is Windows-first (PowerShell `irm … \\| iex`, winget/scoop/choco) and **Update only re-runs the npm method**, so native installs never update and Unix machines get the wrong native command.

**Architecture:** Split `AGENT_INSTALL_CATALOG` by OS. `installMethodsFor(agent, toolchain, os)` picks native curl/bash on Unix, native ps1/winget on Windows, npm everywhere npm exists, Homebrew on macOS when `brew` is probed. Update uses the **same method that installed** when known, else npm `install -g pkg@latest`, else re-run native installer. Keep `useCommandInstall` (one PTY, verify via `findCliLauncher` + `agentCliVersion`).

**Tech Stack:** `src/lib/agentInstall.ts`, `useCommandInstall.ts`, `probeInstallToolchain` (Rust), Vitest.

**ADR:** `.claude/adr/009-remove-omniroute.md` (CLIs are the primary path)

Paths relative to `apps/orchestrator/`.

---

## Why it breaks today (evidence)

`src/lib/agentInstall.ts`:

- Claude/Codex/Antigravity/Mimo **native** commands are PowerShell (`irm https://…install.ps1 | iex`).
- `installMethodsFor` offers `native` even when `npm` is missing — on Linux/macOS that command is invalid.
- `AgentUpdateButton` does `installMethodsFor(...).find((e) => e.id === 'npm')` and returns `null` if there is no npm method (Antigravity) or if npm is missing — no update UI.
- `installShellLine` Unix path assumes bash (`unset …; cmd && exit 0`). Fine for Linux/macOS default shells; Windows path wraps npm in `cmd /c` but native ps1 is written into the same PTY that may be pwsh vs Windows PowerShell.
- `probeInstallToolchain` today: node/npm/winget/scoop/choco/bun/pnpm — **no `brew`**, no `curl`, no OS field.

Locked official native installers (v1; keep URLs in one catalog, not scattered):

| Agent | Windows | Linux / macOS |
| --- | --- | --- |
| claude | `irm https://claude.ai/install.ps1 \| iex` and/or winget `Anthropic.ClaudeCode` | `curl -fsSL https://claude.ai/install.sh \| bash` |
| codex | `irm https://chatgpt.com/codex/install.ps1 \| iex` | `npm i -g @openai/codex` (official); optional brew if documented at implement time |
| copilot | winget `GitHub.Copilot` | `npm i -g @github/copilot` |
| gemini | npm `@google/gemini-cli` (Node ≥ 20) | same |
| opencode | npm / scoop / choco | npm; macOS `brew install opencode` when brew exists |
| antigravity | `irm https://antigravity.google/cli/install.ps1 \| iex` | official Unix script from the same docs URL if present; else docs link only |
| mimo | ps1 + npm | npm `@mimo-ai/cli` + Unix script if vendor documents one |
| freebuff | npm | npm |

If a vendor URL 404s at implement time, keep the docs link and hide that method (do not guess a third-party installer).

---

## File map

| File | Responsibility |
| --- | --- |
| `src/lib/agentInstall.ts` | Per-OS catalog, `updateMethodsFor`, `installShellLine` |
| `src/lib/agentInstall.test.ts` | Matrix Win/Linux/mac |
| `src/lib/platform.ts` | existing `isWindows`; add `osFamily(): 'windows' \\| 'macos' \\| 'linux'` |
| `src-tauri` toolchain probe | Add `brew: boolean`, `os: string` |
| `src/hooks/useCommandInstall.ts` | Refresh PATH after install (see Task 3) |
| `src/components/AgentInstall/AgentUpdateButton.tsx` | Use `updateMethodsFor`, not “first npm” |
| `src/components/AgentInstall/AgentInstallModal.tsx` | Show only methods for current OS |
| i18n + CHANGELOG | |

---

### Task 1: Catalog is OS-aware (pure)

- [x] **Step 1: Failing tests** (extend `agentInstall.test.ts`)

```ts
it('does not offer PowerShell native install on linux', () => {
  const methods = installMethodsFor('claude', { ...BARE, npm: true }, 'linux')
  expect(methods.some((m) => m.command.includes('install.ps1'))).toBe(false)
  expect(methods.some((m) => m.command.includes('install.sh'))).toBe(true)
})

it('offers PowerShell native install on windows even without npm', () => {
  const methods = installMethodsFor('claude', BARE, 'windows')
  expect(methods[0].command).toContain('install.ps1')
})

it('update prefers npm latest when npm installed the cli', () => {
  const methods = updateMethodsFor('gemini', { ...BARE, npm: true, node: 'v22.0.0' }, 'linux')
  expect(methods[0].command).toBe('npm install -g @google/gemini-cli@latest')
})

it('update re-runs unix native installer when there is no npm', () => {
  const methods = updateMethodsFor('claude', BARE, 'macos')
  expect(methods[0].command).toContain('install.sh')
})
```

- [x] **Step 2: Run** `npx vitest run src/lib/agentInstall.test.ts` — FAIL until catalog splits
- [x] **Step 3: Change `InstallMethod` to `{ os?: OSFamily | OSFamily[] }` defaulting to all**
- [x] **Step 4: `installMethodsFor(agent, toolchain, os = osFamily())` filters `method.os`**
- [x] **Step 5: `updateMethodsFor` maps npm install → `npm install -g <pkg>@latest`; native → same native command; winget → `winget upgrade <id>`; brew → `brew upgrade <formula>`**

Never use `npm update -g` as the only strategy; `install -g pkg@latest` is what the current Update button already intended by re-running install.

---

### Task 2: Toolchain probe knows brew and OS

- [x] **Step 1: Extend `InstallToolchain` with `brew: boolean`**
- [x] **Step 2: Rust `probe_install_toolchain` sets `brew` when `which brew` / `where brew` succeeds**
- [x] **Step 3: Existing tests for winget/npm still pass; add a unit test that methods requiring `brew` hide when `brew: false`**

---

### Task 3: PTY install actually finds the binary after success

Bugs to close (all three OSes):

1. **PATH not refreshed:** installer puts the binary in `~/.local/bin` or `%USERPROFILE%\\.local\\bin` and the next `findCliLauncher` still uses the old PATH. After a zero exit, call a new command `refresh_cli_path` / re-run the resolver with a login shell (`bash -lc 'which claude'` / `pwsh -NoLogo -Command Get-Command`).
2. **Wrong shell for native pipeline:** spawn the installer PTY with `pwsh` on Windows for ps1, `bash -lc` on Linux/macOS for sh. Do not write a bash line into cmd.exe.
3. **Shadow conflict:** keep existing `shadowConflict` toast; add a “Open install location” using `openInFileExplorer(dirname(path))`.
4. **Fatal nvm prefix:** keep `installOutputIsFatal`; Unix should still `unset npm_config_prefix`.

- [x] **Step 1: `installShellLine(command, osFamily())` — windows ps1 unchanged; unix `command && exit 0 || exit 1` without wrapping npm in `cmd /c`**
- [x] **Step 2: `useCommandInstall` after code 0: `findCliLauncher` with refreshed PATH (Tauri command that reads the user’s login PATH)**
- [x] **Step 3: cargo/vitest for PATH helper if implemented in Rust**

---

### Task 4: UI

- [x] **Step 1: `AgentInstallModal` lists methods for `osFamily()`; empty list → docs URL + copy (already has docs)**
- [x] **Step 2: `AgentUpdateButton` uses `updateMethodsFor(...)[0]`; if empty, hide the button (do not no-op npm)**
- [x] **Step 3: Onboarding `AgentsStep` install/update uses the same helpers**
- [x] **Step 4: i18n `agentInstall.method.brew`, `agentInstall.method.unixNative`**
- [x] **Step 5: CHANGELOG — install/update CLIs on Windows, Linux, and macOS**

---

## Coverage check

| Requirement | Task |
| --- | --- |
| Install when CLI missing, Windows | 1, 3 |
| Install when CLI missing, Linux | 1, 3 |
| Install when CLI missing, macOS | 1, 2 (brew), 3 |
| Update | 1 (`updateMethodsFor`), 4 |
