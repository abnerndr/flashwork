use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use tauri::AppHandle;

pub const CHUNK_CHAR_CAP: usize = 4000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ContextChunk {
    pub id: String,
    pub source: String,
    pub session_id: String,
    pub kind: String,
    pub files: Vec<String>,
    pub turn: usize,
    pub text: String,
}

#[derive(Clone, Debug)]
pub struct ChunkEvent {
    pub role: String,
    pub text: String,
    pub files: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CursorState {
    byte_offset: u64,
    next_chunk_id: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct HubState {
    chunks: Vec<ContextChunk>,
}

pub fn split_extractive_chunks(
    events: &[ChunkEvent],
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

pub fn search_chunks(
    chunks: &[ContextChunk],
    file: Option<&str>,
    terms: &[String],
    byte_budget: usize,
) -> Vec<ContextChunk> {
    let wanted_file = file.map(|value| value.replace('\\', "/"));
    let mut scored: Vec<(f64, &ContextChunk)> = chunks
        .iter()
        .map(|chunk| {
            let file_hit = wanted_file.as_ref().is_some_and(|path| {
                chunk
                    .files
                    .iter()
                    .any(|entry| entry.replace('\\', "/") == *path)
            });
            let term_hits = terms
                .iter()
                .filter(|term| chunk.text.to_lowercase().contains(&term.to_lowercase()))
                .count();
            let mut score = (if file_hit { 10.0 } else { 0.0 }) + term_hits as f64;
            if score > 0.0 {
                score += chunk.turn as f64 / 1000.0;
            }
            (score, chunk)
        })
        .filter(|(score, _)| *score > 0.0)
        .collect();
    scored.sort_by(|left, right| right.0.partial_cmp(&left.0).unwrap_or(std::cmp::Ordering::Equal));
    let mut picked = Vec::new();
    let mut used = 0usize;
    for (_, chunk) in scored {
        if used + chunk.text.len() > byte_budget {
            break;
        }
        picked.push(chunk.clone());
        used += chunk.text.len();
    }
    picked
}

pub fn ensure_hub_skeleton(context_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(context_dir.join("chunks")).map_err(|error| error.to_string())?;
    let manifest = context_dir.join("manifest.json");
    if !manifest.exists() {
        write_json(context_dir.join("manifest.json"), &empty_manifest())?;
        write_json(context_dir.join("index.json"), &empty_index())?;
        fs::write(
            context_dir.join("README.md"),
            "Search chunks by file or term. Do not load every chunk.\n",
        )
        .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn empty_manifest() -> Value {
    serde_json::json!({ "chunks": [] })
}

fn empty_index() -> Value {
    serde_json::json!({ "terms": {}, "files": {} })
}

fn write_json(path: PathBuf, value: &Value) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_string_pretty(value).map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
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
            "---\nid: {}\nsource: {}\nsessionId: {}\nkind: {}\nfiles: [{}]\nturn: {}\nbytes: {}\n---\n\n{}\n",
            chunk.id,
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
    let manifest_chunks: Vec<Value> = chunks
        .iter()
        .map(|chunk| {
            serde_json::json!({
                "id": chunk.id,
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
        for token in tokenize(&chunk.text) {
            terms.entry(token).or_default().insert(chunk.id.clone());
        }
        for file in &chunk.files {
            files_index
                .entry(file.replace('\\', "/"))
                .or_default()
                .insert(chunk.id.clone());
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
    )?;
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
    fs::rename(&temporary, state_path).map_err(|error| error.to_string())?;
    Ok(())
}

fn tokenize(text: &str) -> BTreeSet<String> {
    text.split(|character: char| !character.is_ascii_alphanumeric())
        .filter(|token| token.len() >= 3)
        .map(|token| token.to_ascii_lowercase())
        .collect()
}

fn load_hub_state(context_dir: &Path) -> HubState {
    let path = context_dir.join("state.json");
    let Ok(content) = fs::read_to_string(path) else {
        return HubState::default();
    };
    serde_json::from_str(&content).unwrap_or_default()
}

fn extract_files(value: &Value) -> Vec<String> {
    let mut files = BTreeSet::new();
    collect_files(value, &mut files);
    files.into_iter().collect()
}

fn collect_files(value: &Value, files: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            for (key, nested) in map {
                if key == "file_path" || key == "path" || key == "filePath" {
                    if let Some(path) = nested.as_str() {
                        if looks_like_file(path) {
                            files.insert(path.replace('\\', "/"));
                        }
                    }
                }
                collect_files(nested, files);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_files(item, files);
            }
        }
        Value::String(text) if looks_like_file(text) => {
            files.insert(text.replace('\\', "/"));
        }
        _ => {}
    }
}

fn looks_like_file(value: &str) -> bool {
    value.contains('/') || value.contains('\\') || value.contains('.')
}

fn content_text(content: &Value) -> String {
    match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter_map(|block| {
                let kind = block.get("type").and_then(Value::as_str).unwrap_or("");
                match kind {
                    "text" | "input_text" | "output_text" => block
                        .get("text")
                        .and_then(Value::as_str)
                        .map(ToOwned::to_owned),
                    _ => None,
                }
            })
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

fn parse_claude_events(bytes: &[u8]) -> Vec<ChunkEvent> {
    let mut events = Vec::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        let Ok(text) = std::str::from_utf8(line) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(text) else {
            continue;
        };
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let kind = value.get("type").and_then(Value::as_str).unwrap_or("");
        if kind != "user" && kind != "assistant" {
            continue;
        }
        let content = value
            .get("message")
            .and_then(|message| message.get("content"))
            .unwrap_or(&Value::Null);
        let text = content_text(content);
        let files = extract_files(content);
        if !text.trim().is_empty() {
            events.push(ChunkEvent {
                role: if kind == "user" {
                    "user".into()
                } else {
                    "assistant".into()
                },
                text,
                files: files.clone(),
            });
        }
        let Value::Array(blocks) = content else {
            continue;
        };
        for block in blocks {
            match block.get("type").and_then(Value::as_str).unwrap_or("") {
                "tool_use" => {
                    let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
                    let input = block.get("input").cloned().unwrap_or(Value::Null);
                    events.push(ChunkEvent {
                        role: "tool".into(),
                        text: format!("{name}: {input}"),
                        files: extract_files(&input),
                    });
                }
                "tool_result" => {
                    let output = block.get("content").map(content_text).unwrap_or_default();
                    if !output.trim().is_empty() {
                        events.push(ChunkEvent {
                            role: "tool".into(),
                            text: output,
                            files: Vec::new(),
                        });
                    }
                }
                _ => {}
            }
        }
    }
    events
}

fn resolve_claude_jsonl(cwd: &str, session_id: &str) -> Result<PathBuf, String> {
    for dir in crate::claude_sessions::project_dirs_for_cwd(cwd)? {
        let path = dir.join(format!("{session_id}.jsonl"));
        if path.exists() {
            return Ok(path);
        }
    }
    Err("session not found for this working directory".to_string())
}

fn ingest_jsonl(
    context_dir: &Path,
    jsonl: &Path,
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
    let new_chunks = split_extractive_chunks(&events, session_id, source, cursor.next_chunk_id);
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

pub fn write_events_hub(
    context_dir: &Path,
    events: &[ChunkEvent],
    session_id: &str,
    source: &str,
) -> Result<(), String> {
    let chunks = split_extractive_chunks(events, session_id, source, 0);
    write_hub(context_dir, &chunks)
}

pub fn events_from_capsule(content: &str) -> Vec<ChunkEvent> {
    content
        .split("\n## ")
        .filter(|section| !section.trim().is_empty())
        .map(|section| ChunkEvent {
            role: "journal".into(),
            text: section.trim().to_string(),
            files: Vec::new(),
        })
        .collect()
}

#[tauri::command]
pub async fn ingest_run_context(
    app: AppHandle,
    run_id: String,
    source: String,
    session_id: String,
    cwd: String,
) -> Result<String, String> {
    let runs = crate::paths::runs_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let run_dir = crate::prompt_run::confined_run_dir(&runs, &run_id)?;
        let context_dir = run_dir.join("context");
        ensure_hub_skeleton(&context_dir)?;
        if source == "claude" && !session_id.trim().is_empty() {
            match resolve_claude_jsonl(&cwd, &session_id) {
                Ok(jsonl) => ingest_jsonl(&context_dir, &jsonl, &session_id, "claude")?,
                Err(_) => {}
            }
        }
        Ok(crate::prompt_run::journal_path_for_persist(&context_dir))
    })
    .await
    .map_err(|error| format!("ingest_run_context task failed: {error}"))?
}

#[tauri::command]
pub async fn search_run_context(
    app: AppHandle,
    run_id: String,
    file: Option<String>,
    terms: Vec<String>,
) -> Result<Vec<String>, String> {
    let runs = crate::paths::runs_dir(&app)?;
    tokio::task::spawn_blocking(move || {
        let Some(run_dir) = crate::prompt_run::confined_existing_run_dir(&runs, &run_id)? else {
            return Ok(Vec::new());
        };
        let state = load_hub_state(&run_dir.join("context"));
        let found = search_chunks(&state.chunks, file.as_deref(), &terms, 8192);
        Ok(found.into_iter().map(|chunk| chunk.id).collect())
    })
    .await
    .map_err(|error| format!("search_run_context task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

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
            "sess-1",
            "claude",
            0,
        );
        assert_eq!(chunks.len(), 1);
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
            "sess-1",
            "claude",
            0,
        );
        assert!(chunks.len() >= 2);
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
        let _ = fs::remove_dir_all(&dir);
    }
}
