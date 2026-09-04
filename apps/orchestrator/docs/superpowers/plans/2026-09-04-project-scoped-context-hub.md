# Project-Scoped Context Hub Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote Flashwork's per-run context hub to a per-Project hub so concurrent Auto runs and TaskBoard tasks in the same Project share chunks and a live status ledger, without ever leaking data across Projects — and use that live ledger to stop TaskBoard from double-claiming a file.

**Architecture:** The existing run-scoped hub (`runs/<runId>/context/`) becomes a run-scoped **subfolder** inside a new Project-scoped hub (`projects/<projectId>/context/runs/<runId>/`). A cheap merge step unions every sibling run's chunks into a Project-level `manifest.json`/`index.json`/`state.json` after each ingest. A new file-based status ledger (`projects/<projectId>/context/status/<laneId>.json`) records live `filesTouched` per lane; TaskBoard's scheduler consults it in addition to the declared `allowedFiles` before letting a new card claim a file.

**Tech Stack:** Rust (Tauri commands, `serde_json`), TypeScript (Zustand stores, Vitest), existing atomic tmp→rename file I/O pattern.

**Out of scope (do not implement here):** OpenCode as a capsule/handoff provider (needs a separate investigation spike into `opencode session show`'s actual output shape — nothing in this repo documents it yet); any new UI badge/visual component (this plan only makes the data available); proactive push of status into a running agent's prompt.

---

## Before you start

Read these two docs for context — they describe the hub this plan promotes to Project scope:

- `docs/superpowers/specs/2026-08-24-shared-session-context-design.md`
- `docs/superpowers/specs/2026-09-04-project-scoped-context-hub-design.md` (the spec this plan implements)

All file paths below are relative to `apps/orchestrator/` unless stated otherwise.

Rust tests: `npm run test:rust` (runs `cd src-tauri && cargo test --lib`). To run one module: `cd src-tauri && cargo test --lib <module>::tests`.

TS tests: `npx vitest run <path>` from `apps/orchestrator/`.

---

### Task 1: Path and ID-confinement helpers for the Project hub

**Files:**
- Modify: `src-tauri/src/paths.rs`
- Modify: `src-tauri/src/prompt_run.rs:43-53` (rename `validate_run_id`), `:66-100` (add `confined_project_dir`)
- Test: `src-tauri/src/prompt_run.rs` (existing `#[cfg(test)] mod tests`)

Today `runs_dir(app)` returns `{profile}/runs`. We need a sibling `{profile}/projects` root, and a generic "validate + confine a child id under a root, creating it if missing" helper that already exists as `confined_run_dir` — we reuse that same logic for a Project id by renaming the too-narrowly-named `validate_run_id` to `validate_safe_id` (it only checks charset/length, nothing run-specific) and adding a `confined_project_dir` that mirrors `confined_run_dir` exactly, but rooted at the projects dir.

- [ ] **Step 1: Write the failing test**

Add to the `#[cfg(test)] mod tests` block at the bottom of `src-tauri/src/prompt_run.rs` (after the existing `rejects_unsafe_run_ids` test):

```rust
    #[test]
    fn confines_project_dir_under_the_projects_root() {
        let base = std::env::temp_dir().join(format!("flashwork-projects-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let dir = confined_project_dir(&base, "proj-1").expect("valid project id confines");
        assert!(dir.ends_with("proj-1"));
        assert!(confined_project_dir(&base, "../escape").is_err());
        let _ = fs::remove_dir_all(&base);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib prompt_run::tests::confines_project_dir_under_the_projects_root`
Expected: FAIL with `cannot find function 'confined_project_dir' in this scope`

- [ ] **Step 3: Rename `validate_run_id` to `validate_safe_id` and add `confined_project_dir`**

In `src-tauri/src/prompt_run.rs`, replace the `validate_run_id` function (lines 43-53) with:

```rust
pub(crate) fn validate_safe_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("invalid id".to_string());
    }
    Ok(())
}
```

Update the two call sites in the same file — `confined_existing_run_dir` (was calling `validate_run_id(run_id)?`) and `confined_run_dir` (same) — to call `validate_safe_id(run_id)?` instead. Then add, right after `confined_run_dir` (after line 100 in the original file):

```rust
pub(crate) fn confined_project_dir(projects: &Path, project_id: &str) -> Result<PathBuf, String> {
    validate_safe_id(project_id)?;
    fs::create_dir_all(projects).map_err(|error| error.to_string())?;
    let canonical_projects = fs::canonicalize(projects).map_err(|error| error.to_string())?;
    let target = canonical_projects.join(project_id);
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;
    let canonical_target = fs::canonicalize(&target).map_err(|error| error.to_string())?;
    if canonical_target.parent() != Some(canonical_projects.as_path()) || !canonical_target.is_dir() {
        return Err("project path is outside the projects directory".to_string());
    }
    Ok(canonical_target)
}
```

Update the existing `rejects_unsafe_run_ids` test to call `validate_safe_id` instead of `validate_run_id` (same assertions, just the renamed call).

In `src-tauri/src/paths.rs`, add after `runs_dir`:

```rust
pub fn project_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(profile_data_dir(app)?.join("projects"))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib prompt_run::tests`
Expected: PASS (both `rejects_unsafe_run_ids` and `confines_project_dir_under_the_projects_root`)

Run: `npm run test:rust`
Expected: PASS (no other module referenced `validate_run_id` — confirm with `grep -rn "validate_run_id" src-tauri/src` returning nothing)

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src-tauri/src/paths.rs apps/orchestrator/src-tauri/src/prompt_run.rs
git commit -m "feat(context-hub): add project-scoped path confinement helpers"
```

---

### Task 2: Thread `run_id` through `ContextChunk` and the hub writer

**Files:**
- Modify: `src-tauri/src/context_hub.rs:11-21` (`ContextChunk`), `:42-104` (`split_extractive_chunks`), `:177-266` (`write_hub`), `:414-450` (`ingest_jsonl`), `:452-460` (`write_events_hub`)
- Test: `src-tauri/src/context_hub.rs` (existing `#[cfg(test)] mod tests`)

Every chunk needs to know which run produced it so a Project-level merge (Task 3) can compute the real on-disk path (`runs/<runId>/chunks/<id>.md`) and so the manifest/index can stay globally unique across sibling runs.

- [ ] **Step 1: Write the failing test**

Replace the three existing chunk-related tests in `src-tauri/src/context_hub.rs`'s test module with versions that pass a `run_id` and assert it round-trips:

```rust
    #[test]
    fn keeps_turns_that_touch_the_same_file_in_one_chunk() {
        let chunks = split_extractive_chunks(
            &[
                ChunkEvent {
                    role: "user".into(),
                    text: "fix auth".into(),
                    files: vec!["src/auth.ts".into()],
                },
                ChunkEvent {
                    role: "assistant".into(),
                    text: "editing login".into(),
                    files: vec!["src/auth.ts".into()],
                },
            ],
            "run-1",
            "sess-1",
            "claude",
            0,
        );
        assert_eq!(chunks.len(), 1);
        assert_eq!(chunks[0].run_id, "run-1");
        assert_eq!(chunks[0].files, vec!["src/auth.ts".to_string()]);
        assert!(chunks[0].text.contains("fix auth"));
    }

    #[test]
    fn splits_when_the_char_cap_would_be_exceeded() {
        let chunks = split_extractive_chunks(
            &[
                ChunkEvent {
                    role: "user".into(),
                    text: "a".repeat(CHUNK_CHAR_CAP),
                    files: vec!["a.ts".into()],
                },
                ChunkEvent {
                    role: "user".into(),
                    text: "next".into(),
                    files: vec!["a.ts".into()],
                },
            ],
            "run-1",
            "sess-1",
            "claude",
            0,
        );
        assert!(chunks.len() >= 2);
        assert!(chunks.iter().all(|chunk| chunk.run_id == "run-1"));
    }

    #[test]
    fn search_prefers_file_hits_and_writes_a_local_hub() {
        let chunks = split_extractive_chunks(
            &[
                ChunkEvent {
                    role: "user".into(),
                    text: "auth work".into(),
                    files: vec!["src/auth.ts".into()],
                },
                ChunkEvent {
                    role: "user".into(),
                    text: "unrelated ui".into(),
                    files: vec!["src/ui.ts".into()],
                },
            ],
            "run-1",
            "sess-1",
            "claude",
            0,
        );
        let found = search_chunks(&chunks, Some("src/auth.ts"), &["auth".into()], 8192);
        assert!(found[0].files.contains(&"src/auth.ts".to_string()));
        assert!(!found.iter().any(|chunk| chunk.files.contains(&"src/ui.ts".to_string())));

        let dir = std::env::temp_dir().join(format!("flashwork-context-hub-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        write_hub(&dir, &chunks).expect("hub writes without an API");
        assert!(dir.join("manifest.json").exists());
        assert!(dir.join("index.json").exists());
        assert!(dir.join("chunks/0001.md").exists());
        let manifest: Value =
            serde_json::from_str(&fs::read_to_string(dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["chunks"][0]["runId"], "run-1");
        let _ = fs::remove_dir_all(&dir);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib context_hub::tests`
Expected: FAIL — `split_extractive_chunks` takes 4 arguments, 5 were supplied (compile error)

- [ ] **Step 3: Update `ContextChunk`, `split_extractive_chunks`, `write_hub`, `ingest_jsonl`, `write_events_hub`**

In `ContextChunk` (line ~13), add the field right after `id`:

```rust
pub struct ContextChunk {
    pub id: String,
    pub run_id: String,
    pub source: String,
    pub session_id: String,
    pub kind: String,
    pub files: Vec<String>,
    pub turn: usize,
    pub text: String,
}
```

Change `split_extractive_chunks`'s signature and the one place it constructs a `ContextChunk`:

```rust
pub fn split_extractive_chunks(
    events: &[ChunkEvent],
    run_id: &str,
    session_id: &str,
    source: &str,
    start_id: usize,
) -> Vec<ContextChunk> {
    let mut chunks = Vec::new();
    let mut bucket: Vec<&ChunkEvent> = Vec::new();
    let mut files: BTreeSet<String> = BTreeSet::new();
    let mut turn = 0usize;
    let flush = |bucket: &mut Vec<&ChunkEvent>,
                 files: &mut BTreeSet<String>,
                 turn: &mut usize,
                 chunks: &mut Vec<ContextChunk>| {
        if bucket.is_empty() {
            return;
        }
        let text = bucket
            .iter()
            .map(|event| event.text.as_str())
            .collect::<Vec<_>>()
            .join("\n\n");
        let kind = bucket
            .first()
            .map(|event| event.role.as_str())
            .unwrap_or("user");
        let id = start_id + chunks.len() + 1;
        chunks.push(ContextChunk {
            id: format!("{id:04}"),
            run_id: run_id.to_string(),
            source: source.to_string(),
            session_id: session_id.to_string(),
            kind: kind.to_string(),
            files: files.iter().cloned().collect(),
            turn: *turn,
            text: text.chars().take(CHUNK_CHAR_CAP).collect(),
        });
        bucket.clear();
        files.clear();
        *turn += 1;
    };
    for event in events {
        let same_files = !event.files.is_empty()
            && event
                .files
                .iter()
                .all(|file| files.is_empty() || files.contains(file));
        let next_size = bucket
            .iter()
            .map(|item| item.text.len())
            .sum::<usize>()
            + if bucket.is_empty() { 0 } else { 2 }
            + event.text.len();
        if !bucket.is_empty() && (!same_files || next_size > CHUNK_CHAR_CAP) {
            flush(&mut bucket, &mut files, &mut turn, &mut chunks);
        }
        bucket.push(event);
        for file in &event.files {
            files.insert(file.clone());
        }
    }
    flush(&mut bucket, &mut files, &mut turn, &mut chunks);
    chunks
}
```

Split `write_hub` into a reusable `write_manifest_and_index` plus a thinner `write_hub` — replace the whole function (lines 177-266) with:

```rust
fn write_manifest_and_index(context_dir: &Path, chunks: &[ContextChunk]) -> Result<(), String> {
    let manifest_chunks: Vec<Value> = chunks
        .iter()
        .map(|chunk| {
            serde_json::json!({
                "id": chunk.id,
                "runId": chunk.run_id,
                "source": chunk.source,
                "sessionId": chunk.session_id,
                "kind": chunk.kind,
                "files": chunk.files,
                "turn": chunk.turn,
                "bytes": chunk.text.len(),
            })
        })
        .collect();
    write_json(
        context_dir.join("manifest.json"),
        &serde_json::json!({ "chunks": manifest_chunks }),
    )?;
    let mut terms: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut files_index: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for chunk in chunks {
        let key = format!("{}/{}", chunk.run_id, chunk.id);
        for token in tokenize(&chunk.text) {
            terms.entry(token).or_default().insert(key.clone());
        }
        for file in &chunk.files {
            files_index
                .entry(file.replace('\\', "/"))
                .or_default()
                .insert(key.clone());
        }
    }
    let terms_value: Map<String, Value> = terms
        .into_iter()
        .map(|(term, ids)| {
            (
                term,
                Value::Array(ids.into_iter().map(Value::String).collect()),
            )
        })
        .collect();
    let files_value: Map<String, Value> = files_index
        .into_iter()
        .map(|(file, ids)| {
            (
                file,
                Value::Array(ids.into_iter().map(Value::String).collect()),
            )
        })
        .collect();
    write_json(
        context_dir.join("index.json"),
        &serde_json::json!({ "terms": terms_value, "files": files_value }),
    )
}

fn write_state(context_dir: &Path, chunks: &[ContextChunk]) -> Result<(), String> {
    let state = HubState {
        chunks: chunks.to_vec(),
    };
    let state_path = context_dir.join("state.json");
    let temporary = state_path.with_extension("json.tmp");
    fs::write(
        &temporary,
        serde_json::to_string_pretty(&state).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    fs::rename(&temporary, state_path).map_err(|error| error.to_string())
}

fn write_hub(context_dir: &Path, chunks: &[ContextChunk]) -> Result<(), String> {
    ensure_hub_skeleton(context_dir)?;
    let chunks_dir = context_dir.join("chunks");
    for chunk in chunks {
        let path = chunks_dir.join(format!("{}.md", chunk.id));
        let files = chunk
            .files
            .iter()
            .map(|file| format!("\"{file}\""))
            .collect::<Vec<_>>()
            .join(", ");
        let body = format!(
            "---\nid: {}\nrunId: {}\nsource: {}\nsessionId: {}\nkind: {}\nfiles: [{}]\nturn: {}\nbytes: {}\n---\n\n{}\n",
            chunk.id,
            chunk.run_id,
            chunk.source,
            chunk.session_id,
            chunk.kind,
            files,
            chunk.turn,
            chunk.text.len(),
            chunk.text
        );
        fs::write(path, body).map_err(|error| error.to_string())?;
    }
    write_manifest_and_index(context_dir, chunks)?;
    write_state(context_dir, chunks)
}
```

Update `ingest_jsonl` (was lines 414-450) to accept and thread `run_id`:

```rust
fn ingest_jsonl(
    context_dir: &Path,
    jsonl: &Path,
    run_id: &str,
    session_id: &str,
    source: &str,
) -> Result<(), String> {
    ensure_hub_skeleton(context_dir)?;
    let cursor_path = context_dir.join("cursor.json");
    let mut cursor: CursorState = fs::read_to_string(&cursor_path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default();
    let mut file = fs::File::open(jsonl).map_err(|error| error.to_string())?;
    let len = file.metadata().map_err(|error| error.to_string())?.len();
    if cursor.byte_offset > len {
        cursor.byte_offset = 0;
    }
    file.seek(SeekFrom::Start(cursor.byte_offset))
        .map_err(|error| error.to_string())?;
    let mut reader = BufReader::new(file);
    let mut new_bytes = Vec::new();
    reader
        .read_to_end(&mut new_bytes)
        .map_err(|error| error.to_string())?;
    let events = parse_claude_events(&new_bytes);
    let mut state = load_hub_state(context_dir);
    let new_chunks = split_extractive_chunks(&events, run_id, session_id, source, cursor.next_chunk_id);
    state.chunks.extend(new_chunks);
    write_hub(context_dir, &state.chunks)?;
    cursor.byte_offset = len;
    cursor.next_chunk_id = state.chunks.len();
    write_json(
        cursor_path,
        &serde_json::to_value(&cursor).map_err(|error| error.to_string())?,
    )?;
    Ok(())
}
```

Update `write_events_hub` (was lines 452-460):

```rust
pub fn write_events_hub(
    context_dir: &Path,
    events: &[ChunkEvent],
    run_id: &str,
    session_id: &str,
    source: &str,
) -> Result<(), String> {
    let chunks = split_extractive_chunks(events, run_id, session_id, source, 0);
    write_hub(context_dir, &chunks)
}
```

`write_events_hub` has one caller today, `materialize_agent_handoff` in `handoff.rs`:

```rust
crate::context_hub::write_events_hub(&context_dir, &events, &handoff_id, "journal")?;
```

Update it to pass a `run_id` (the handoff has no run concept, so reuse `handoff_id` for both):

```rust
crate::context_hub::write_events_hub(&context_dir, &events, &handoff_id, &handoff_id, "journal")?;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib context_hub::tests`
Expected: PASS

Run: `npm run test:rust`
Expected: PASS (this also compiles `handoff.rs`, confirming the `write_events_hub` call site updated correctly)

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src-tauri/src/context_hub.rs apps/orchestrator/src-tauri/src/handoff.rs
git commit -m "feat(context-hub): tag every chunk with its originating run id"
```

---

### Task 3: Project-level merge of sibling run hubs

**Files:**
- Modify: `src-tauri/src/context_hub.rs` (add `project_merge` near `write_hub`)
- Test: `src-tauri/src/context_hub.rs` (existing `#[cfg(test)] mod tests`)

This is the function that makes cross-run sharing work: it scans every `runs/<runId>/state.json` under a Project's context dir and writes a merged `manifest.json`/`index.json`/`state.json` at the Project root. Because each run's own `state.json` is untouched by this step (read-only scan), two runs merging at nearly the same instant never lose each other's chunks — the "losing" merge is just briefly stale, and the next ingest anywhere in the project fixes it.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/context_hub.rs`'s test module:

```rust
    #[test]
    fn project_merge_unions_every_sibling_run() {
        let project_dir = std::env::temp_dir().join(format!("flashwork-project-merge-{}", std::process::id()));
        let _ = fs::remove_dir_all(&project_dir);

        let run_a = split_extractive_chunks(
            &[ChunkEvent { role: "user".into(), text: "run a work".into(), files: vec!["src/a.ts".into()] }],
            "run-a",
            "sess-a",
            "claude",
            0,
        );
        write_hub(&project_dir.join("runs").join("run-a"), &run_a).expect("run a writes");

        let run_b = split_extractive_chunks(
            &[ChunkEvent { role: "user".into(), text: "run b work".into(), files: vec!["src/b.ts".into()] }],
            "run-b",
            "sess-b",
            "claude",
            0,
        );
        write_hub(&project_dir.join("runs").join("run-b"), &run_b).expect("run b writes");

        project_merge(&project_dir).expect("merge succeeds");

        let state = load_hub_state(&project_dir);
        assert_eq!(state.chunks.len(), 2);
        assert!(state.chunks.iter().any(|chunk| chunk.run_id == "run-a"));
        assert!(state.chunks.iter().any(|chunk| chunk.run_id == "run-b"));

        let manifest: Value =
            serde_json::from_str(&fs::read_to_string(project_dir.join("manifest.json")).unwrap()).unwrap();
        assert_eq!(manifest["chunks"].as_array().unwrap().len(), 2);

        let _ = fs::remove_dir_all(&project_dir);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib context_hub::tests::project_merge_unions_every_sibling_run`
Expected: FAIL with `cannot find function 'project_merge' in this scope`

- [ ] **Step 3: Implement `project_merge`**

Add after `write_hub` in `src-tauri/src/context_hub.rs`:

```rust
fn project_run_chunks(project_context_dir: &Path) -> Vec<ContextChunk> {
    let runs_dir = project_context_dir.join("runs");
    let mut chunks = Vec::new();
    let Ok(entries) = fs::read_dir(&runs_dir) else {
        return chunks;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        chunks.extend(load_hub_state(&path).chunks);
    }
    chunks
}

pub fn project_merge(project_context_dir: &Path) -> Result<(), String> {
    ensure_hub_skeleton(project_context_dir)?;
    let chunks = project_run_chunks(project_context_dir);
    write_manifest_and_index(project_context_dir, &chunks)?;
    write_state(project_context_dir, &chunks)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib context_hub::tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src-tauri/src/context_hub.rs
git commit -m "feat(context-hub): merge sibling run hubs into a project-level hub"
```

---

### Task 4: Fix `save_prompt_run` to stop stomping `contextDir` back to the old per-run path

**Files:**
- Modify: `src-tauri/src/prompt_run.rs:114-126` (`save_prompt_run_inner`), `:253-259` (`save_prompt_run`)
- Test: `src-tauri/src/prompt_run.rs`

Every time a `PromptRun` is persisted, `save_prompt_run_inner` unconditionally recomputes `run.context_dir` from `runs/<runId>/context` — the **old**, run-only scheme. Left alone, this would silently overwrite the project-scoped path the rest of this plan produces, every single time a run is saved. `PromptRunRecord` already carries `project_id`, so this is a same-shape fix.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/prompt_run.rs`'s test module:

```rust
    #[test]
    fn save_prompt_run_points_context_dir_at_the_project_hub() {
        let base = std::env::temp_dir().join(format!("flashwork-save-run-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        let runs = base.join("runs");
        let projects = base.join("projects");
        let run = PromptRunRecord {
            id: "run-1".into(),
            project_id: "proj-1".into(),
            cwd: "/tmp/app".into(),
            prompt: "do it".into(),
            status: "running".into(),
            active_agent: "claude".into(),
            active_terminal_id: "t1".into(),
            unrestricted: false,
            steps: vec![],
            journal_path: String::new(),
            context_dir: None,
            canonical_claude_session_id: None,
            canonical_claude_terminal_id: None,
            created_at: 0,
        };
        save_prompt_run_inner(runs, projects, run).expect("saves");
        let saved = fs::read_to_string(base.join("runs").join("run-1").join("run.json")).unwrap();
        let parsed: PromptRunRecord = serde_json::from_str(&saved).unwrap();
        let context_dir = parsed.context_dir.expect("context dir set");
        assert!(context_dir.contains("projects"));
        assert!(context_dir.contains("proj-1"));
        assert!(!context_dir.contains("run-1"));
        let _ = fs::remove_dir_all(&base);
    }
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib prompt_run::tests::save_prompt_run_points_context_dir_at_the_project_hub`
Expected: FAIL — `save_prompt_run_inner` takes 2 arguments, 3 were supplied (compile error)

- [ ] **Step 3: Update `save_prompt_run_inner` and `save_prompt_run`**

Replace `save_prompt_run_inner` (lines 114-126):

```rust
fn save_prompt_run_inner(runs: PathBuf, projects: PathBuf, mut run: PromptRunRecord) -> Result<(), String> {
    let run_dir = confined_run_dir(&runs, &run.id)?;
    let journal_path = run_dir.join("journal.md");
    if !journal_path.exists() {
        fs::write(&journal_path, "").map_err(|error| error.to_string())?;
    }
    run.journal_path = journal_path_for_persist(&journal_path);
    let project_dir = confined_project_dir(&projects, &run.project_id)?;
    let project_context_dir = project_dir.join("context");
    let run_context_dir = confined_run_dir(&project_context_dir.join("runs"), &run.id)?;
    fs::create_dir_all(run_context_dir.join("chunks")).map_err(|error| error.to_string())?;
    run.context_dir = Some(journal_path_for_persist(&project_context_dir));
    let json = serde_json::to_string_pretty(&run).map_err(|error| error.to_string())?;
    write_json_atomically(&run_dir.join("run.json"), &json)
}
```

Replace `save_prompt_run` (lines 253-259):

```rust
#[tauri::command]
pub async fn save_prompt_run(app: AppHandle, run: PromptRunRecord) -> Result<(), String> {
    let runs = crate::paths::runs_dir(&app)?;
    let projects = crate::paths::project_data_dir(&app)?;
    tokio::task::spawn_blocking(move || save_prompt_run_inner(runs, projects, run))
        .await
        .map_err(|error| format!("save_prompt_run task failed: {error}"))?
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib prompt_run::tests`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src-tauri/src/prompt_run.rs
git commit -m "fix(context-hub): stop save_prompt_run from reverting contextDir to the old per-run path"
```

---

### Task 5: Promote `ensure_prompt_run_context`, `ingest_run_context`, `search_run_context` to Project scope; add `run_files_touched`

**Files:**
- Modify: `src-tauri/src/prompt_run.rs:325-337` (`ensure_prompt_run_context`)
- Modify: `src-tauri/src/context_hub.rs:474-517` (`ingest_run_context`, `search_run_context`), add `run_files_touched`
- Modify: `src-tauri/src/lib.rs` (register `run_files_touched`)
- Test: `src-tauri/src/context_hub.rs`

This is the task that actually changes what gets returned to the frontend: `contextDir` becomes the Project root (so a bootstrap pointer reaches every sibling run's chunks, not just its own), and every ingest triggers a merge.

- [ ] **Step 1: Write the failing test**

Add to `src-tauri/src/context_hub.rs`'s test module:

```rust
    #[test]
    fn run_files_touched_reads_only_that_run_state() {
        let run_dir = std::env::temp_dir().join(format!("flashwork-files-touched-{}", std::process::id()));
        let _ = fs::remove_dir_all(&run_dir);
        let chunks = split_extractive_chunks(
            &[ChunkEvent { role: "user".into(), text: "work".into(), files: vec!["src/a.ts".into(), "src/b.ts".into()] }],
            "run-x",
            "sess-x",
            "claude",
            0,
        );
        write_hub(&run_dir, &chunks).expect("writes");
        let state = load_hub_state(&run_dir);
        let mut files: BTreeSet<String> = BTreeSet::new();
        for chunk in &state.chunks {
            for file in &chunk.files {
                files.insert(file.clone());
            }
        }
        assert_eq!(files.len(), 2);
        let _ = fs::remove_dir_all(&run_dir);
    }
```

(This test locks in the read pattern `run_files_touched` will use internally — `load_hub_state` + union `.files` — before we wire it behind a `#[tauri::command]`, which is easiest to test indirectly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib context_hub::tests::run_files_touched_reads_only_that_run_state`
Expected: FAIL if `BTreeSet` isn't in scope for the test module — it already is (imported at the top of `context_hub.rs`), so this should actually compile; if the assertion fails, re-check the fixture above. Expected once correct: PASS immediately (this step doubles as the "it fails then passes" gate because the behavior already exists in `load_hub_state`; the real new-code gate is Step 4's command wiring).

- [ ] **Step 3: Rewrite `ingest_run_context`, `search_run_context`, add `run_files_touched`**

Replace `ingest_run_context` (lines 474-497 of `context_hub.rs`):

```rust
#[tauri::command]
pub async fn ingest_run_context(
    app: AppHandle,
    project_id: String,
    run_id: String,
    source: String,
    session_id: String,
    cwd: String,
) -> Result<String, String> {
    let projects_root = crate::paths::project_data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let project_dir = crate::prompt_run::confined_project_dir(&projects_root, &project_id)?;
        let project_context_dir = project_dir.join("context");
        let run_context_dir =
            crate::prompt_run::confined_run_dir(&project_context_dir.join("runs"), &run_id)?;
        ensure_hub_skeleton(&run_context_dir)?;
        if source == "claude" && !session_id.trim().is_empty() {
            if let Ok(jsonl) = resolve_claude_jsonl(&cwd, &session_id) {
                ingest_jsonl(&run_context_dir, &jsonl, &run_id, &session_id, "claude")?;
            }
        }
        project_merge(&project_context_dir)?;
        Ok(crate::prompt_run::journal_path_for_persist(&project_context_dir))
    })
    .await
    .map_err(|error| format!("ingest_run_context task failed: {error}"))?
}

#[tauri::command]
pub async fn search_run_context(
    app: AppHandle,
    project_id: String,
    file: Option<String>,
    terms: Vec<String>,
) -> Result<Vec<String>, String> {
    let projects_root = crate::paths::project_data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let project_dir = crate::prompt_run::confined_project_dir(&projects_root, &project_id)?;
        let state = load_hub_state(&project_dir.join("context"));
        let found = search_chunks(&state.chunks, file.as_deref(), &terms, 8192);
        Ok(found
            .into_iter()
            .map(|chunk| format!("{}/{}", chunk.run_id, chunk.id))
            .collect())
    })
    .await
    .map_err(|error| format!("search_run_context task failed: {error}"))?
}

#[tauri::command]
pub async fn run_files_touched(
    app: AppHandle,
    project_id: String,
    run_id: String,
) -> Result<Vec<String>, String> {
    let projects_root = crate::paths::project_data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let project_dir = crate::prompt_run::confined_project_dir(&projects_root, &project_id)?;
        let run_context_dir = crate::prompt_run::confined_run_dir(
            &project_dir.join("context").join("runs"),
            &run_id,
        )?;
        let state = load_hub_state(&run_context_dir);
        let mut files: BTreeSet<String> = BTreeSet::new();
        for chunk in state.chunks {
            for file in chunk.files {
                files.insert(file);
            }
        }
        Ok(files.into_iter().collect())
    })
    .await
    .map_err(|error| format!("run_files_touched task failed: {error}"))?
}
```

Replace `ensure_prompt_run_context` in `src-tauri/src/prompt_run.rs` (lines 325-337):

```rust
#[tauri::command]
pub async fn ensure_prompt_run_context(
    app: AppHandle,
    project_id: String,
    run_id: String,
) -> Result<String, String> {
    let projects_root = crate::paths::project_data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let project_dir = confined_project_dir(&projects_root, &project_id)?;
        let project_context_dir = project_dir.join("context");
        let run_context_dir = confined_run_dir(&project_context_dir.join("runs"), &run_id)?;
        fs::create_dir_all(run_context_dir.join("chunks")).map_err(|error| error.to_string())?;
        crate::context_hub::ensure_hub_skeleton(&run_context_dir)?;
        crate::context_hub::project_merge(&project_context_dir)?;
        Ok(journal_path_for_persist(&project_context_dir))
    })
    .await
    .map_err(|error| format!("ensure_prompt_run_context task failed: {error}"))?
}
```

Register the new command in `src-tauri/src/lib.rs` — add `context_hub::run_files_touched,` right after the existing `context_hub::search_run_context,` line inside `tauri::generate_handler![...]`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run test:rust`
Expected: PASS (this compiles the whole crate, catching any remaining call-site mismatch)

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src-tauri/src/context_hub.rs apps/orchestrator/src-tauri/src/prompt_run.rs apps/orchestrator/src-tauri/src/lib.rs
git commit -m "feat(context-hub): promote ensure/ingest/search commands to project scope"
```

---

### Task 6: Lane status ledger (Rust)

**Files:**
- Create: `src-tauri/src/lane_status.rs`
- Modify: `src-tauri/src/lib.rs` (add `mod lane_status;` and register its two commands)
- Test: `src-tauri/src/lane_status.rs` (new `#[cfg(test)] mod tests`)

A tiny, independent per-lane file. No merge logic needed — unlike the chunk hub, each lane only ever writes its own file, so there is no concurrent-write race to design around.

- [ ] **Step 1: Write the failing test**

Create `src-tauri/src/lane_status.rs` with just the test module first:

```rust
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneStatus {
    pub run_id: String,
    pub agent: String,
    pub state: String,
    pub files_touched: Vec<String>,
    pub updated_at: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_lane_ids() {
        assert!(validate_lane_id("abc-123").is_ok());
        assert!(validate_lane_id("../x").is_err());
        assert!(validate_lane_id("").is_err());
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd src-tauri && cargo test --lib lane_status::tests`
Expected: FAIL with `cannot find function 'validate_lane_id' in this scope`

- [ ] **Step 3: Implement `validate_lane_id`, `write_lane_status`, `read_project_status`**

Replace the full content of `src-tauri/src/lane_status.rs` with:

```rust
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaneStatus {
    pub run_id: String,
    pub agent: String,
    pub state: String,
    pub files_touched: Vec<String>,
    pub updated_at: u64,
}

fn validate_lane_id(value: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 128
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err("invalid lane id".to_string());
    }
    Ok(())
}

fn status_dir(project_context_dir: &Path) -> PathBuf {
    project_context_dir.join("status")
}

#[tauri::command]
pub async fn write_lane_status(
    app: AppHandle,
    project_id: String,
    lane_id: String,
    status: LaneStatus,
) -> Result<(), String> {
    validate_lane_id(&lane_id)?;
    let projects_root = crate::paths::project_data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let project_dir = crate::prompt_run::confined_project_dir(&projects_root, &project_id)?;
        let dir = status_dir(&project_dir.join("context"));
        fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
        let path = dir.join(format!("{lane_id}.json"));
        let temporary = path.with_extension("json.tmp");
        let json = serde_json::to_string_pretty(&status).map_err(|error| error.to_string())?;
        fs::write(&temporary, json).map_err(|error| error.to_string())?;
        fs::rename(&temporary, path).map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("write_lane_status task failed: {error}"))?
}

#[tauri::command]
pub async fn read_project_status(
    app: AppHandle,
    project_id: String,
) -> Result<Vec<LaneStatus>, String> {
    let projects_root = crate::paths::project_data_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let project_dir = crate::prompt_run::confined_project_dir(&projects_root, &project_id)?;
        let dir = status_dir(&project_dir.join("context"));
        let Ok(entries) = fs::read_dir(&dir) else {
            return Ok(Vec::new());
        };
        let mut statuses = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
                continue;
            }
            let Ok(content) = fs::read_to_string(&path) else {
                continue;
            };
            let Ok(status) = serde_json::from_str::<LaneStatus>(&content) else {
                continue;
            };
            statuses.push(status);
        }
        Ok(statuses)
    })
    .await
    .map_err(|error| format!("read_project_status task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_lane_ids() {
        assert!(validate_lane_id("abc-123").is_ok());
        assert!(validate_lane_id("../x").is_err());
        assert!(validate_lane_id("").is_err());
    }
}
```

In `src-tauri/src/lib.rs`, add `mod lane_status;` alphabetically (between `mod health_probe;` and `mod logging;`), and register the two commands inside `tauri::generate_handler![...]` next to the other `context_hub::` lines:

```rust
            lane_status::write_lane_status,
            lane_status::read_project_status,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd src-tauri && cargo test --lib lane_status::tests`
Expected: PASS

Run: `npm run test:rust`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src-tauri/src/lane_status.rs apps/orchestrator/src-tauri/src/lib.rs
git commit -m "feat(context-hub): add per-lane status ledger (write/read, zero model tokens)"
```

---

### Task 7: TypeScript bindings — `LaneStatus` type and Tauri wrappers

**Files:**
- Modify: `src/lib/types.ts` (add `LaneStatus`)
- Modify: `src/lib/tauri/contextHub.ts` (project-scoped signatures)
- Create: `src/lib/tauri/laneStatus.ts`
- Modify: `src/lib/tauri/index.ts` (re-export)

- [ ] **Step 1: Add the `LaneStatus` type**

In `src/lib/types.ts`, add near the other `PromptRun*` types (right after `PromptRunStatus`):

```typescript
export type LaneStatus = {
  runId: string
  agent: AgentType
  state: 'working' | 'done' | 'blocked' | 'failed'
  filesTouched: string[]
  updatedAt: number
}
```

- [ ] **Step 2: Update `contextHub.ts` to the project-scoped signatures**

Replace the full content of `src/lib/tauri/contextHub.ts`:

```typescript
import { invoke } from '@tauri-apps/api/core'

export function ensurePromptRunContext(projectId: string, runId: string): Promise<string> {
  return invoke('ensure_prompt_run_context', { projectId, runId })
}

export function ingestRunContext(
  projectId: string,
  runId: string,
  source: string,
  sessionId: string,
  cwd: string,
): Promise<string> {
  return invoke('ingest_run_context', { projectId, runId, source, sessionId, cwd })
}

export function searchRunContext(
  projectId: string,
  terms: string[],
  file?: string,
): Promise<string[]> {
  return invoke('search_run_context', { projectId, file, terms })
}

export function runFilesTouched(projectId: string, runId: string): Promise<string[]> {
  return invoke('run_files_touched', { projectId, runId })
}
```

- [ ] **Step 3: Create `laneStatus.ts` and export it from `tauri/index.ts`**

Create `src/lib/tauri/laneStatus.ts`:

```typescript
import { invoke } from '@tauri-apps/api/core'

import type { LaneStatus } from '../types'

export function writeLaneStatus(
  projectId: string,
  laneId: string,
  status: LaneStatus,
): Promise<void> {
  return invoke('write_lane_status', { projectId, laneId, status })
}

export function readProjectStatus(projectId: string): Promise<LaneStatus[]> {
  return invoke('read_project_status', { projectId })
}
```

In `src/lib/tauri/index.ts`, add after `export * from './contextHub'`:

```typescript
export * from './laneStatus'
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit`
Expected: no new errors from these three files (there will still be errors from call sites not yet updated — Tasks 8-9 fix those; if `tsc` reports errors only in `startPromptRun.ts`, `submitAutoPromptRun.ts`, or `usePromptRunWatcher.ts`, that is expected at this point).

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/lib/types.ts apps/orchestrator/src/lib/tauri/contextHub.ts apps/orchestrator/src/lib/tauri/laneStatus.ts apps/orchestrator/src/lib/tauri/index.ts
git commit -m "feat(context-hub): add project-scoped TS bindings and lane status client"
```

---

### Task 8: Thread `projectId` through `startPromptRun` / `submitAutoPromptRun`

**Files:**
- Modify: `src/lib/promptRun/startPromptRun.ts:69` (type), `:180-182` (call)
- Test: `src/lib/promptRun/startPromptRun.test.ts`

- [ ] **Step 1: Write the failing test**

`src/lib/promptRun/startPromptRun.test.ts` has no shared fixture builder — every test inlines its own input object using the module-level `createAgentTerminal` mock. Add this test in the same style, in the `describe('startPromptRun', ...)` block:

```typescript
  it('passes the project id to ensureContextDir', async () => {
    const seen: Array<{ projectId: string; runId: string }> = []
    const result = await startPromptRun({
      project: { id: 'p1', name: 'App' },
      cwd: '/tmp/app',
      prompt: 'implement login',
      unrestricted: false,
      enabledAgents: ['claude'],
      installedAgents: ['claude'],
      claudeFiveHourUtilization: 0,
      codexRateLimited: false,
      ensureContextDir: async (projectId, runId) => {
        seen.push({ projectId, runId })
        return `projects/${projectId}/context`
      },
      createAgentTerminal,
    })
    expect(result.ok).toBe(true)
    expect(seen[0]?.projectId).toBe('p1')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/promptRun/startPromptRun.test.ts -t "passes the project id to ensureContextDir"`
Expected: FAIL — TypeScript error, `ensureContextDir` still typed as `(runId: string) => Promise<string>`

- [ ] **Step 3: Update the type and the call site**

In `src/lib/promptRun/startPromptRun.ts`, change line 69:

```typescript
  ensureContextDir?: (projectId: string, runId: string) => Promise<string>
```

Change lines 180-182:

```typescript
  const ensureContextDir =
    input.ensureContextDir ?? (async (_projectId: string, id: string) => `runs/${id}/context`)
  const contextDir = await ensureContextDir(input.project.id, runId)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/promptRun/startPromptRun.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/lib/promptRun/startPromptRun.ts apps/orchestrator/src/lib/promptRun/startPromptRun.test.ts
git commit -m "feat(context-hub): pass project id into ensureContextDir"
```

---

### Task 9: Write `working` lane status when a lane launches

**Files:**
- Modify: `src/lib/promptRun/startPromptRun.ts:1-18` (imports), `:112-135` (`launchPromptRunLanes`)
- Test: `src/lib/promptRun/startPromptRun.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/promptRun/startPromptRun.test.ts`:

```typescript
  it('writes a working lane status for every launched lane', async () => {
    const writes: Array<{ projectId: string; laneId: string; state: string }> = []
    await launchPromptRunLanes({
      projectId: 'proj-1',
      cwd: '/tmp/app',
      runId: 'run-1',
      unrestricted: false,
      lanes: [
        {
          agent: 'claude',
          role: 'worker',
          taskKind: 'implement',
          reason: 'heuristic',
          skillNames: [],
          slicePrompt: 'do it',
        },
      ],
      createAgentTerminal,
      writeLaneStatus: async (projectId, laneId, status) => {
        writes.push({ projectId, laneId, state: status.state })
      },
    })
    expect(writes).toEqual([{ projectId: 'proj-1', laneId: 'term-1', state: 'working' }])
  })
```

This goes in a new `describe('launchPromptRunLanes', ...)` block (add it alongside the existing `describe('startPromptRun', ...)` block, importing `launchPromptRunLanes` from `./startPromptRun` in the file's existing import line).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/promptRun/startPromptRun.test.ts -t "writes a working lane status"`
Expected: FAIL — `launchPromptRunLanes` has no `writeLaneStatus` field in its input type

- [ ] **Step 3: Add `writeLaneStatus` to `LaunchPromptRunLanesInput` and call it**

In `src/lib/promptRun/startPromptRun.ts`, add the import:

```typescript
import { writeLaneStatus as defaultWriteLaneStatus } from '../tauri'
import type { LaneStatus } from '../types'
```

Extend `LaunchPromptRunLanesInput` (near line 73-85) with:

```typescript
  writeLaneStatus?: (projectId: string, laneId: string, status: LaneStatus) => Promise<void>
```

In `launchPromptRunLanes`, right after the `terminal` is created and before `if (lane.agent === 'claude' && sessionId)` (around line 132-133), add:

```typescript
    const writeLaneStatus = input.writeLaneStatus ?? defaultWriteLaneStatus
    try {
      await writeLaneStatus(input.projectId, terminal.id, {
        runId: input.runId,
        agent: lane.agent,
        state: 'working',
        filesTouched: [],
        updatedAt: Date.now(),
      })
    } catch (cause) {
      console.warn('[prompt-run] lane status write failed:', cause)
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/promptRun/startPromptRun.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/lib/promptRun/startPromptRun.ts apps/orchestrator/src/lib/promptRun/startPromptRun.test.ts
git commit -m "feat(context-hub): mark a lane's status working as soon as it launches"
```

---

### Task 10: Wire `projectId` into the Auto ingest watcher and refresh `filesTouched`

**Files:**
- Modify: `src/hooks/usePromptRunWatcher.ts:337-345`

- [ ] **Step 1: Update the `ingestRunContext` call and add the status refresh**

This hook has no existing dedicated test file covering this exact callback (it is exercised through component/integration tests). Make the change directly and verify with the app running (Step 2), since extracting this closure into a unit-testable function is a larger refactor this plan does not undertake (`shouldIngestContext`, the one part of this flow that IS unit-tested, is untouched by this change).

Replace lines 337-345 of `src/hooks/usePromptRunWatcher.ts`:

```typescript
              void ingestRunContext(
                latest.projectId,
                latest.id,
                'claude',
                latest.canonicalClaudeSessionId,
                latest.cwd,
              )
                .then(async () => {
                  try {
                    const files = await runFilesTouched(latest.projectId, latest.id)
                    await writeLaneStatus(latest.projectId, subscribedTerminalId, {
                      runId: latest.id,
                      agent: sourceAgent,
                      state: 'working',
                      filesTouched: files,
                      updatedAt: Date.now(),
                    })
                  } catch (cause) {
                    console.warn('[prompt-run] lane status refresh failed:', cause)
                  }
                })
                .catch((cause) => {
                  console.warn('[prompt-run] context ingest failed:', cause)
                })
```

Add `ingestRunContext, runFilesTouched, writeLaneStatus` to this file's existing import from `'../lib/tauri'` (find the current import line and extend it — do not add a second import from the same module).

- [ ] **Step 2: Verify manually**

Run: `npm run app`
Start an Auto run with Claude in a real project, let it run for a turn, then check `%APPDATA%/Flashwork/profiles/<id>/projects/<projectId>/context/status/` (or the Linux/macOS equivalent under the app-local-data dir) contains a `<terminalId>.json` with `"state":"working"` and a non-empty `filesTouched` once the agent has edited a file.
Expected: file exists and updates after each debounced ingest.

- [ ] **Step 3: Commit**

```bash
git add apps/orchestrator/src/hooks/usePromptRunWatcher.ts
git commit -m "feat(context-hub): refresh live filesTouched status after each context ingest"
```

---

### Task 11: `cardFilesConflict` / `pickNextTaskCard` consult live status

**Files:**
- Modify: `src/lib/taskBoard/schedule.ts:1`, `:18-29` (`cardFilesConflict`), `:43-57` (`pickNextTaskCard`)
- Test: `src/lib/taskBoard/schedule.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/lib/taskBoard/schedule.test.ts`, inside the existing `describe('cardFilesConflict', ...)` block:

```typescript
  it('blocks a candidate whose file matches a busy lane\'s live filesTouched, even if not declared', () => {
    const busy = card({ id: 'busy', column: 'doing', allowedFiles: [], runId: 'run-1' })
    const candidate = card({ id: 'candidate', allowedFiles: ['src/live.ts'] })
    const liveStatus = [
      { runId: 'run-1', agent: 'claude' as const, state: 'working' as const, filesTouched: ['src/live.ts'], updatedAt: 0 },
    ]
    expect(cardFilesConflict(candidate, [busy], liveStatus)).toBe(true)
  })
```

And inside `describe('pickNextTaskCard', ...)`:

```typescript
  it('waits when a live-touched file overlaps, even without a declared allowlist match', () => {
    const next = pickNextTaskCard(
      [
        card({ id: 'busy', column: 'doing', allowedFiles: [], runId: 'run-1' }),
        card({ id: 'queued', allowedFiles: ['src/live.ts'], priority: 1 }),
      ],
      new Set(),
      [{ runId: 'run-1', agent: 'claude', state: 'working', filesTouched: ['src/live.ts'], updatedAt: 0 }],
    )
    expect(next).toBeNull()
  })
```

Also update the `card()` test helper at the top of `schedule.test.ts` so it accepts a `runId` override — it already spreads `...partial` last, and `TaskCard` already has an optional `runId` field, so no helper change is actually required; only confirm the object literals above type-check (they will, since `runId` is optional on `TaskCard`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/taskBoard/schedule.test.ts`
Expected: FAIL — `cardFilesConflict`/`pickNextTaskCard` don't accept a third argument yet (the new assertions will see `false`/a non-null result because the extra arg is silently ignored by JS, so the test fails on the `expect(...).toBe(true)` / `.toBeNull()` assertions, not a compile error — TypeScript will also flag the extra argument as a type error under `tsc --noEmit`)

- [ ] **Step 3: Implement**

In `src/lib/taskBoard/schedule.ts`, change the import at line 1:

```typescript
import type { LaneStatus, TaskCard, TaskSlicePlan } from '../types'
```

Replace `cardFilesConflict` (lines 24-29):

```typescript
export function cardFilesConflict(
  candidate: TaskCard,
  busy: readonly TaskCard[],
  liveStatus: readonly LaneStatus[] = [],
): boolean {
  const cwd = normalizePathKey(candidate.cwd)
  return busy
    .filter((card) => normalizePathKey(card.cwd) === cwd)
    .some((card) => {
      if (filesOverlap(candidate.allowedFiles, card.allowedFiles)) return true
      const live = liveStatus.find((status) => status.runId === card.runId)
      if (!live) return false
      return filesOverlap(candidate.allowedFiles, live.filesTouched)
    })
}
```

Replace `pickNextTaskCard` (lines 43-57):

```typescript
export function pickNextTaskCard(
  cards: readonly TaskCard[],
  blockedProjectIds: ReadonlySet<string>,
  liveStatus: readonly LaneStatus[] = [],
): TaskCard | null {
  const todo = cards
    .filter((card) => card.column === 'todo')
    .sort((left, right) => left.priority - right.priority || left.createdAt - right.createdAt)
  const busy = cards.filter((card) => card.column === 'doing' || card.column === 'verify')
  for (const card of todo) {
    if (blockedProjectIds.has(card.projectId)) continue
    if (cardFilesConflict(card, busy, liveStatus)) continue
    return card
  }
  return null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/taskBoard/schedule.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/lib/taskBoard/schedule.ts apps/orchestrator/src/lib/taskBoard/schedule.test.ts
git commit -m "feat(context-hub): block TaskBoard cards on live filesTouched, not just declared allowlists"
```

---

### Task 12: Feed live status into `pumpTaskBoardQueue`; mark a slice `done` in the ledger

**Files:**
- Modify: `src/lib/taskBoard/submitBoardTask.ts:7-16` (import), `:318-347` (`noteBoardTerminalComplete`), `:388-408` (`pumpTaskBoardQueue`)
- Test: `src/lib/taskBoard/boardStart.test.ts` or a new `src/lib/taskBoard/submitBoardTask.test.ts` section — check which file already covers `pumpTaskBoardQueue`/`noteBoardTerminalComplete` with `grep -n "pumpTaskBoardQueue\|noteBoardTerminalComplete" apps/orchestrator/src/lib/taskBoard/*.test.ts` before adding; if neither is covered by an existing test file, add the test directly to a new `src/lib/taskBoard/submitBoardTask.test.ts`.

- [ ] **Step 1: Write the failing test**

If no existing test file covers these two functions, create `src/lib/taskBoard/submitBoardTask.test.ts` with just the piece that's pure-testable — the shape of what `pumpTaskBoardQueue` passes to `pickNextTaskCard` is not directly observable without mocking Zustand stores and Tauri, which is disproportionate for this plan. Instead, cover the one pure decision this task adds: that `noteBoardTerminalComplete` still requires `card.runId` truthiness before writing anything (existing guard), by asserting on the exported `failSlicePlan`/`boardCardSettled` behavior is untouched:

Run: `npx vitest run src/lib/taskBoard/retargetBoardSlice.test.ts`
Expected: PASS already, before any change — this is a regression guard, not a new-feature test. Because `pumpTaskBoardQueue` and `noteBoardTerminalComplete` are store-and-Tauri-coupled orchestration functions with no existing unit test seam, this task is implemented directly and verified manually (Step 3), consistent with how Task 10 was handled.

- [ ] **Step 2: Implement**

In `src/lib/taskBoard/submitBoardTask.ts`, extend the `'../tauri'` import block (currently lines 7-16) to add `readProjectStatus, runFilesTouched, writeLaneStatus`:

```typescript
import {
  appendPromptRunBoard,
  appendPromptRunJournal,
  findCliLauncher,
  runPlannerCli,
  runValidation,
  skillsScan,
  writePromptRunBoard,
  ensurePromptRunContext,
  readProjectStatus,
  runFilesTouched,
  writeLaneStatus,
} from '../tauri'
```

Also add `type LaneStatus` to the existing `'../types'` import line (currently `import { ALL_AGENT_TYPES, AGENT_TYPE_LABELS, type AgentType, type TaskCard, type TaskSlicePlan } from '../types'`):

```typescript
import {
  ALL_AGENT_TYPES,
  AGENT_TYPE_LABELS,
  type AgentType,
  type LaneStatus,
  type TaskCard,
  type TaskSlicePlan,
} from '../types'
```

In `noteBoardTerminalComplete` (around line 330, right after `useTaskBoardStore.getState().patchCard(card.id, { slicePlan: nextPlan })`), add:

```typescript
  try {
    const files = await runFilesTouched(card.projectId, card.runId ?? '').catch(() => slice.allowedFiles)
    await writeLaneStatus(card.projectId, terminalId, {
      runId: card.runId ?? '',
      agent: slice.agent,
      state: 'done',
      filesTouched: files,
      updatedAt: Date.now(),
    })
  } catch (cause) {
    console.warn('[task-board] lane status write failed:', cause)
  }
```

Replace `pumpTaskBoardQueue` (lines 388-408):

```typescript
export async function pumpTaskBoardQueue(): Promise<void> {
  const projects = useProjectsStore.getState().projects
  const blocked = new Set<string>()
  const liveStatus: LaneStatus[] = []
  for (const project of projects) {
    const run = usePromptRunStore.getState().byProjectId[project.id]
    if (
      isPromptRunBlocking(
        run?.status,
        [run?.activeTerminalId, ...(run?.steps.map((step) => step.terminalId) ?? [])].filter(
          (id): id is string => Boolean(id),
        ),
        project.terminals.map((terminal) => terminal.id),
      )
    ) {
      blocked.add(project.id)
    }
    try {
      liveStatus.push(...(await readProjectStatus(project.id)))
    } catch (cause) {
      console.warn('[task-board] read project status failed:', cause)
    }
  }
  const next = pickNextTaskCard(useTaskBoardStore.getState().cards, blocked, liveStatus)
  if (!next) return
  void startBoardCard(next.id)
}
```

- [ ] **Step 3: Verify manually and re-run the full suite**

Run: `npx vitest run`
Expected: PASS (no regressions — `pumpTaskBoardQueue`'s two callers, `useTaskBoardScheduler.ts` and `TaskBoardView/index.tsx`, call it without awaiting, which remains valid now that it returns a `Promise<void>` instead of `void`)

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add apps/orchestrator/src/lib/taskBoard/submitBoardTask.ts
git commit -m "feat(context-hub): feed live lane status into TaskBoard scheduling and mark slices done"
```

---

### Task 13: Update the Auto worker bootstrap wording for project-scoped, run-namespaced chunks

**Files:**
- Modify: `src/lib/promptRun/bootstrapPrompt.ts:27-31`
- Test: create `src/lib/promptRun/bootstrapPrompt.test.ts` (none exists today)

The chunk a sibling needs to `Read` is no longer at `<contextDir>/chunks/<id>.md` — it is at `<contextDir>/runs/<runId>/chunks/<id>.md`, and the manifest entry now carries a `runId` field that tells the agent which run subfolder to use. Update the wording so the agent knows to look for it.

- [ ] **Step 1: Write the failing test**

Create `src/lib/promptRun/bootstrapPrompt.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'

import { buildRunBootstrapInput } from './bootstrapPrompt'

describe('buildRunBootstrapInput', () => {
  it('tells a worker that chunks live under runs/<runId>/chunks per manifest entry', () => {
    const prompt = buildRunBootstrapInput({
      runId: 'run-1',
      prompt: 'do the thing',
      agent: 'claude',
      role: 'worker',
      contextDir: '/abs/project/context',
    })
    expect(prompt).toContain('runs/<runId>/chunks/<id>.md')
    expect(prompt).toContain('/abs/project/context')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/promptRun/bootstrapPrompt.test.ts`
Expected: FAIL — current wording is `Read manifest.json and only the chunks that match your files.`, no mention of `runs/<runId>/chunks/<id>.md`

- [ ] **Step 3: Update the wording**

In `src/lib/promptRun/bootstrapPrompt.ts`, replace lines 27-31:

```typescript
  if (args.contextDir) {
    lines.push(
      `Shared context is on disk at "${args.contextDir}". Read manifest.json: each entry has a "runId" — the chunk file is at runs/<runId>/chunks/<id>.md, relative to this dir. Read only the chunks that match your files. The index was built locally with no API cost.`,
    )
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/promptRun/bootstrapPrompt.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/orchestrator/src/lib/promptRun/bootstrapPrompt.ts apps/orchestrator/src/lib/promptRun/bootstrapPrompt.test.ts
git commit -m "docs(context-hub): point worker bootstrap at run-namespaced chunk paths"
```

---

### Task 14: Changelog entry

**Files:**
- Modify: `docs/CHANGELOG.md`

Per this repo's non-negotiable rule 5 (CLAUDE.md §5), every feature change is recorded under `[Unreleased]` in the same task.

- [ ] **Step 1: Add the entry**

In `docs/CHANGELOG.md`, under `## [Unreleased]` → `### Changed`, add (as a new bullet alongside the existing Auto/handoff one):

```markdown
- Auto runs and TaskBoard tasks in the same project now share one context hub instead of
  one per run: a second run sees the first run's chunks immediately, at no API cost. A new
  on-disk status ledger lets TaskBoard block a card from claiming a file another lane is
  actively touching, not just what it originally declared. Two different projects never
  share a hub, even pointed at the same repo.
```

- [ ] **Step 2: Commit**

```bash
git add apps/orchestrator/docs/CHANGELOG.md
git commit -m "docs: changelog entry for the project-scoped context hub"
```

---

## Self-review notes

- **Spec coverage:** Symptom 1 (two Auto runs in one project unaware of each other) → Tasks 1-5 (project-scoped hub + merge). Symptom 2 (no progress signal between lanes) → Tasks 6, 9-12 (status ledger + TaskBoard consuming it). Symptom 3 (OpenCode handoff still expensive) is explicitly out of scope here per the design doc — it needs a separate investigation spike into OpenCode's actual session-export format before any code can be written against it without guessing at an unverified schema.
- **Cross-project isolation:** every new/changed command takes a `project_id`, resolves it through `confined_project_dir` (canonicalize + parent check, mirroring the existing `confined_run_dir` pattern), and never reads any path outside that confinement. No task introduces a lookup that spans two `project_id`s.
- **Backward compatibility deliberately not kept:** `ensure_prompt_run_context`, `ingest_run_context`, and `search_run_context` change their parameter lists (new required `project_id`, and `search_run_context` drops `run_id` for `project_id`). This is safe because every call site in the codebase was located and updated in this plan (Tasks 8-12) — there is no persisted client-side state that calls these with the old signature.
