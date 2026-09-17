# GitHub source control (VS Code baseline) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise Flashwork Git to the behavior documented for VS Code Source Control: working tree groups, commit, push/pull, branch switch, GitHub login, publish, and open PR — without forking vscode.

**Architecture:** Evolve `GitControl.tsx` + `src-tauri` git commands. Add GitHub auth (device flow or `gh` if installed). Keep worktrees as they are. App-data `github_sync.rs` (gist backup of Flashwork state) stays **separate** from repo SCM.

**Tech Stack:** Existing git invoke API, `gh` CLI optional, GitHub device OAuth for token in keyring.

**ADR:** `.claude/adr/004-keep-tauri-reference-vscode.md`  
**References:** [VS Code source control docs](https://code.visualstudio.com/docs/sourcecontrol/overview) ([vscode-docs](https://github.com/microsoft/vscode-docs) `docs/sourcecontrol/`)

Paths relative to `apps/orchestrator/`.

---

## File map

| File | Responsibility |
| --- | --- |
| `src/components/ProjectSidebar/GitControl.tsx` | SCM view layout |
| `src/lib/tauri/git.ts` | New: checkout, fetch, remote, create-pr URL |
| `src-tauri/src/git_control.rs` | Commands next to existing `git_commit` / `git_push` |
| `src-tauri/src/github_auth.rs` | New: device flow, store token in keyring |
| `src/components/modals/GitHubLoginModal.tsx` | New |
| i18n + CHANGELOG | |

VS Code groups we already have: staged, changes, untracked, conflicts. Gaps: branch picker, fetch, publish branch, GitHub PR.

---

### Task 1: Branch checkout + fetch

- [ ] **Step 1: Backend `git_checkout(repoRoot, branch)` and `git_fetch(repoRoot)`**
- [ ] **Step 2: Tests with a temp git repo** (`git init`, commit, branch, checkout)
- [ ] **Step 3: UI: dropdown of `gitListBranches` (already exists) + Fetch button**
- [ ] **Step 4: Disabled while `busy`; toast on error using `readableError`**

Reject checkout if `conflicts.length > 0` unless force is not offered in v1 (safer).

---

### Task 2: GitHub identity for remotes

`github_sync_*` is gist backup. Add **repo** auth:

- [ ] **Step 1: Prefer `gh auth token` if `gh` is on PATH** (no token in logs)
- [ ] **Step 2: Else GitHub device flow; store in OS keyring key `flashwork.github.repo`**
- [ ] **Step 3: `git_push` / `git_pull` set `GIT_ASKPASS` / extraheader `Authorization: Bearer` only for github.com remotes**
- [ ] **Step 4: Login modal with "copy code + open github.com/login/device"** (same pattern as Copilot device links already detected in the terminal)

Never paste tokens in the chat UI. Never log the token.

---

### Task 3: Publish and pull request

Behavior copied from vscode-docs (Publish Branch / Create PR):

- [ ] **Step 1: If no `origin`, `git remote add origin <url>` from a text field (HTTPS)**
- [ ] **Step 2: `git push -u origin HEAD` via existing `git_push` plus upstream set**
- [ ] **Step 3: `createPullRequestUrl(repoRoot)` parses `origin` and returns `https://github.com/<owner>/<repo>/compare/<branch>?expand=1`**
- [ ] **Step 4: Button Open pull request opens the system browser (`open_url`)**

Pure function test:

```ts
expect(githubCompareUrl('https://github.com/acme/app.git', 'feat/x')).toBe(
  'https://github.com/acme/app/compare/feat/x?expand=1',
)
```

---

### Task 4: SCM layout pass

Match vscode-docs Source Control view structure in `GitControl.tsx`:

1. Header: repo name, branch, refresh, more menu (Fetch, Pull, Push, Publish)
2. Commit box **above** the file lists (VS Code default)
3. Groups: Staged, Changes, Untracked, Conflicts
4. Diff still via existing `gitDiff` (optional pane later in P06)

- [ ] **Step 1: Reorder DOM to commit-first if not already**
- [ ] **Step 2: i18n labels aligned to vscode terms where they already exist (`git.commit`, `git.push`, …)**
- [ ] **Step 3: CHANGELOG**

---

## Coverage check

| Spec requirement | Task |
| --- | --- |
| Commit/push/pull like VS Code | 1, 4 (push/pull exist; branch/fetch new) |
| GitHub connection for those ops | 2–3 |
| Keep worktrees | no change |
| Do not confuse gist sync with SCM | 2 comment + separate module |
