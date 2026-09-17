# Skills and MCP install area — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class install surface for skills (and keep MCP registry add) so users can install, not only scan/uninstall.

**Architecture:** Extend `SkillsBrowser` / MCP manager with an **Install** flow: Git URL, local folder, or known registry. Write into `~/.agents/skills/<name>` (shared store) and optionally link into `~/.claude/skills` / `~/.codex/skills`. MCP install already exists (`mcp_registry_search` + `mcp_upsert`); this plan adds a dedicated **Marketplace** view that hosts both tabs with a primary Install CTA.

**Tech Stack:** Rust (`skills.rs`), existing MCP catalog, React modal, Vitest + cargo test.

**ADR:** `.claude/adr/003-unified-mcp-skills-surface.md`

Paths relative to `apps/orchestrator/`.

---

## File map

| File | Responsibility |
| --- | --- |
| `src-tauri/src/skills.rs` | `skills_install` command |
| `src-tauri/src/lib.rs` | Register command |
| `src/lib/tauri/skills.ts` | TS wrapper |
| `src/components/modals/mcp/SkillInstallFlow.tsx` | New UI |
| `src/components/modals/mcp/SkillsBrowser.tsx` | Install button |
| `src/components/McpPanel/index.tsx` | Marketplace header |
| `src/components/modals/McpManagerModal.tsx` | Open install flow |
| i18n + CHANGELOG | |

---

### Task 1: `skills_install` backend

**Files:**
- Modify: `src-tauri/src/skills.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: `#[cfg(test)]` in `skills.rs`

Install sources:

```rust
pub enum SkillInstallSource {
    Folder { path: String },
    Git { url: String, spec: Option<String> },
}
```

Rules (must be tested):

1. Source folder must contain `SKILL.md`.
2. Skill name = directory name, sanitized `[a-zA-Z0-9._-]+`, max 64 chars.
3. Destination = shared store `~/.agents/skills/<name>` (same helper as `skills_home(&[".agents", "skills"])`).
4. If destination exists, fail with `skill_exists` unless `overwrite: true`.
5. Copy tree with confined paths (reject `..`).
6. Optionally create a link in each requested agent skills dir (reuse uninstall's link detection, inverted).
7. Record lock info (`source`, `sourceUrl`, `installedAt`) in the existing `.skill-lock.json` shape used by `skills_detail`.

- [ ] **Step 1: Write failing cargo test `install_from_folder_requires_skill_md`**
- [ ] **Step 2: Run** `cargo test --lib skills::tests::install_from_folder_requires_skill_md`
- [ ] **Step 3: Implement `skills_install`**
- [ ] **Step 4: Register in `lib.rs` invoke_handler next to `skills_uninstall`**
- [ ] **Step 5: TS wrapper**

```ts
export type SkillInstallRequest = {
  source: { type: 'folder'; path: string } | { type: 'git'; url: string }
  agents: string[]
  overwrite?: boolean
}

export async function skillsInstall(req: SkillInstallRequest): Promise<SkillSummary> {
  return invoke('skills_install', { req })
}
```

Git install: `git clone --depth 1` into a temp dir under app cache, then same folder path. No shell interpolation; argv array only.

---

### Task 2: SkillInstallFlow UI

**Files:**
- Create: `src/components/modals/mcp/SkillInstallFlow.tsx` (mirror `AddServerFlow.tsx` structure: source = folder | git)
- Modify: `SkillsBrowser.tsx` — primary button `skills.install`
- Reuse `pickDirectory` for folder source
- Agent checkboxes: same `MCP_AGENTS` / skill agents as uninstall

- [ ] **Step 1: i18n keys** (`skills.install`, `skills.installGit`, `skills.installFolder`, `skills.errNoSkillMd`, `skills.errExists`)
- [ ] **Step 2: On success, `skillsScan()` reload + toast**
- [ ] **Step 3: CHANGELOG Added**

---

### Task 3: Marketplace shell

**Files:**
- Modify: `McpPanel/index.tsx` and manager modal

The MCP tab already has **Add more** → registry. Add a page title **Marketplace** with two equal CTAs: **Add MCP server** (existing `AddServerFlow`) and **Install skill** (new flow). Do not invent a second registry API for skills in v1 (no official skills registry in-tree). Document in UI: skills install from folder or git.

- [ ] **Step 1: Empty skills state includes the install CTA** (`SkillsBrowser` empty branch already has `EmptyState` — add the button there)
- [ ] **Step 2: Keep MCP registry as-is; only UX grouping**

---

## Coverage check

| Spec requirement | Task |
| --- | --- |
| Area to install skills | 1–2 |
| Area to install MCPs | 3 (existing registry + CTA) |
| Map local skills after install | `skills_scan` reload |
