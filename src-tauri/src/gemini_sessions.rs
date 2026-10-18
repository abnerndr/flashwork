//! Gemini CLI session discovery and JSONL token parsing.
//!
//! Locked on-disk layout (inspected from a real `~/.gemini`, 2026-09-17).
//! Do not re-guess at runtime. Ignore `~/.gemini/antigravity/` and
//! `~/.gemini/antigravity-cli/` — those belong to Antigravity.
//!
//! ```text
//! ~/.gemini/tmp/<slug>/
//!   .project_root     # one line: absolute project cwd
//!   chats/session-<ISO-ish><shortid>.jsonl
//!   logs.json
//!   logs/
//! ```
//!
//! Match a project by reading `.project_root` (trimmed) and comparing with
//! `provider_common::normalize_cwd(cwd)`.
//!
//! JSONL (one JSON object per line):
//! 1. First line is session meta with `sessionId` (UUID). Snapshot `id` is that UUID.
//! 2. Model turns look like:
//!    `{"id":"<uuid>","type":"gemini","tokens":{"input":N,"output":N,"cached":N,...},"model":"..."}`
//!    There is no `usageMetadata`. Parse `tokens.input`, `tokens.output`,
//!    `tokens.cached` (mapped to cache_read), and `model`.
//!
//! Dedup: the same message `id` is often written twice (thoughts, then toolCalls).
//! Keep the last record per `id`, then sum tokens across unique records that have
//! a `tokens` object.
//!
//! `get_session_cost("gemini", cwd, session_id)` finds the chats/*.jsonl whose
//! meta `sessionId` equals that id (fallback: filename contains the id / short id).
//! When the JSONL yields zero token records, scrape sibling `logs.json` / `logs/*`
//! with [`scrape_pty_usage`].
//!
//! Reads skip symlinks and cap line/file size (same class of OOM as Claude JSONL).

use chrono::{Datelike, Local, TimeZone};
use regex::Regex;
use serde::Serialize;
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::provider_common::{file_modified_ms, normalize_cwd, provider_home_dir};

/// JSONL lines can be huge (pasted files). Same cap as `claude_sessions::MAX_LINE_BYTES`.
const MAX_LINE_BYTES: usize = 2 * 1024 * 1024;
/// Skip whole files larger than this (jsonl parse, logs.json, logs/*).
const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
/// `.project_root` is one path line.
const MAX_PROJECT_ROOT_BYTES: u64 = 8 * 1024;
/// Bound concatenated PTY scrape text across logs.json + logs/*.
const MAX_SCRAPE_BYTES: usize = 16 * 1024 * 1024;

#[derive(Serialize, Debug, Clone)]
pub struct GeminiSessionSnapshot {
    pub id: String,
    pub modified_at_ms: u128,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct GeminiModelTokens {
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
}

#[derive(Debug, Clone, Default)]
pub(crate) struct GeminiJsonlCost {
    pub session_id: Option<String>,
    /// Unique records (after id-dedup) that contained a `tokens` object.
    pub token_record_count: usize,
    pub by_model: Vec<GeminiModelTokens>,
}

pub(crate) fn gemini_home_dir() -> Option<PathBuf> {
    provider_home_dir(&[".gemini"])
}

fn skip_tmp_slug(name: &str) -> bool {
    matches!(name, "antigravity" | "antigravity-cli")
}

fn json_u64(value: &serde_json::Value, key: &str) -> u64 {
    value
        .get(key)
        .and_then(|v| v.as_u64().or_else(|| v.as_f64().map(|n| n as u64)))
        .unwrap_or(0)
}

fn regular_file_meta(path: &Path) -> Option<fs::Metadata> {
    let meta = fs::symlink_metadata(path).ok()?;
    if meta.file_type().is_symlink() || !meta.is_file() {
        return None;
    }
    Some(meta)
}

/// Reads one line, keeping at most `MAX_LINE_BYTES` and discarding the rest
/// without buffering it. Returns false at EOF. Mirrors `claude_sessions`.
fn read_capped_line(reader: &mut impl BufRead, buf: &mut Vec<u8>) -> std::io::Result<bool> {
    buf.clear();
    let mut consumed_any = false;
    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return Ok(consumed_any);
        }
        consumed_any = true;
        let newline = available.iter().position(|byte| *byte == b'\n');
        let chunk_len = newline.unwrap_or(available.len());
        if buf.len() < MAX_LINE_BYTES {
            let take = chunk_len.min(MAX_LINE_BYTES - buf.len());
            buf.extend_from_slice(&available[..take]);
        }
        match newline {
            Some(index) => {
                reader.consume(index + 1);
                return Ok(true);
            }
            None => {
                let len = available.len();
                reader.consume(len);
            }
        }
    }
}

fn read_regular_file_capped(path: &Path, max_bytes: u64) -> Option<String> {
    let meta = regular_file_meta(path)?;
    if meta.len() > max_bytes {
        return None;
    }
    let file = fs::File::open(path).ok()?;
    let mut buf = Vec::new();
    let mut reader = file.take(max_bytes);
    reader.read_to_end(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn append_capped(dst: &mut String, src: &str, max_bytes: usize) {
    if dst.len() >= max_bytes {
        return;
    }
    let remaining = max_bytes - dst.len();
    if src.len() <= remaining {
        dst.push_str(src);
    } else {
        dst.push_str(&src[..remaining]);
    }
}

fn jsonl_session_id(path: &Path) -> Option<String> {
    let _meta = regular_file_meta(path)?;
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        if !read_capped_line(&mut reader, &mut buf).ok()? {
            return None;
        }
        if buf.is_empty() {
            continue;
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
        return value
            .get("sessionId")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
    }
}

fn filename_contains_session_id(path: &Path, session_id: &str) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default();
    if name.contains(session_id) {
        return true;
    }
    let short = session_id
        .rsplit('-')
        .next()
        .filter(|part| !part.is_empty() && *part != session_id);
    match short {
        Some(part) => name.contains(part),
        None => false,
    }
}

fn matching_project_dirs(gemini_home: &Path, cwd: &str) -> Vec<PathBuf> {
    let tmp = gemini_home.join("tmp");
    let Ok(entries) = fs::read_dir(&tmp) else {
        return Vec::new();
    };
    let target = normalize_cwd(cwd);
    let mut dirs = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if skip_tmp_slug(&name) {
            continue;
        }
        let dir = entry.path();
        let Ok(dir_meta) = fs::symlink_metadata(&dir) else {
            continue;
        };
        if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
            continue;
        }
        let Some(root) = read_regular_file_capped(&dir.join(".project_root"), MAX_PROJECT_ROOT_BYTES)
        else {
            continue;
        };
        if normalize_cwd(root.trim()) == target {
            dirs.push(dir);
        }
    }
    dirs
}

fn jsonl_files_for_cwd(gemini_home: &Path, cwd: &str) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for project in matching_project_dirs(gemini_home, cwd) {
        let chats = project.join("chats");
        let chats_ok = fs::symlink_metadata(&chats)
            .map(|m| m.is_dir() && !m.file_type().is_symlink())
            .unwrap_or(false);
        if !chats_ok {
            continue;
        }
        let Ok(entries) = fs::read_dir(&chats) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            if regular_file_meta(&path).is_none() {
                continue;
            }
            files.push(path);
        }
    }
    files
}

pub(crate) fn snapshot_gemini_sessions_from(
    gemini_home: &Path,
    cwd: &str,
) -> Result<Vec<GeminiSessionSnapshot>, String> {
    let mut snapshots = Vec::new();
    for path in jsonl_files_for_cwd(gemini_home, cwd) {
        let Some(metadata) = regular_file_meta(&path) else {
            continue;
        };
        let id = jsonl_session_id(&path).unwrap_or_else(|| {
            path.file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string()
        });
        snapshots.push(GeminiSessionSnapshot {
            id,
            modified_at_ms: file_modified_ms(&metadata),
            size_bytes: metadata.len(),
        });
    }
    snapshots.sort_by(|a, b| b.modified_at_ms.cmp(&a.modified_at_ms));
    Ok(snapshots)
}

pub(crate) fn find_session_jsonl(
    gemini_home: &Path,
    cwd: &str,
    session_id: &str,
) -> Option<PathBuf> {
    let files = jsonl_files_for_cwd(gemini_home, cwd);
    for path in &files {
        if jsonl_session_id(path).as_deref() == Some(session_id) {
            return Some(path.clone());
        }
    }
    files
        .into_iter()
        .find(|path| filename_contains_session_id(path, session_id))
}

fn pty_usage_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)(\d+)\s*(input|prompt).{0,20}(\d+)\s*(output|candidates)")
            .expect("pty usage regex")
    })
}

/// Last regex match wins. Used when a JSONL session has no `tokens` records.
pub(crate) fn scrape_pty_usage(text: &str) -> Option<(u64, u64)> {
    let mut last = None;
    for caps in pty_usage_re().captures_iter(text) {
        let input = caps.get(1)?.as_str().parse::<u64>().ok()?;
        let output = caps.get(3)?.as_str().parse::<u64>().ok()?;
        last = Some((input, output));
    }
    last
}

pub(crate) fn scrape_session_pty_logs(jsonl_path: &Path) -> Option<(u64, u64)> {
    let project_dir = jsonl_path.parent()?.parent()?;
    let mut text = String::new();
    if let Some(contents) =
        read_regular_file_capped(&project_dir.join("logs.json"), MAX_FILE_BYTES)
    {
        append_capped(&mut text, &contents, MAX_SCRAPE_BYTES);
        append_capped(&mut text, "\n", MAX_SCRAPE_BYTES);
    }
    let logs_dir = project_dir.join("logs");
    let logs_dir_ok = fs::symlink_metadata(&logs_dir)
        .map(|m| m.is_dir() && !m.file_type().is_symlink())
        .unwrap_or(false);
    if logs_dir_ok {
        if let Ok(entries) = fs::read_dir(&logs_dir) {
            for entry in entries.flatten() {
                if text.len() >= MAX_SCRAPE_BYTES {
                    break;
                }
                let path = entry.path();
                if let Some(contents) = read_regular_file_capped(&path, MAX_FILE_BYTES) {
                    append_capped(&mut text, &contents, MAX_SCRAPE_BYTES);
                    append_capped(&mut text, "\n", MAX_SCRAPE_BYTES);
                }
            }
        }
    }
    if text.is_empty() {
        return None;
    }
    scrape_pty_usage(&text)
}

pub(crate) fn parse_gemini_jsonl(path: &Path) -> GeminiJsonlCost {
    let Some(meta) = regular_file_meta(path) else {
        return GeminiJsonlCost::default();
    };
    if meta.len() > MAX_FILE_BYTES {
        return GeminiJsonlCost::default();
    }
    let Ok(file) = fs::File::open(path) else {
        return GeminiJsonlCost::default();
    };
    let mut reader = BufReader::new(file);
    let mut buf: Vec<u8> = Vec::new();
    let mut session_id = None;
    let mut by_id: HashMap<String, GeminiModelTokens> = HashMap::new();
    let mut anon_index = 0usize;
    while read_capped_line(&mut reader, &mut buf).unwrap_or(false) {
        if buf.is_empty() {
            continue;
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(trimmed) else {
            continue;
        };
        if session_id.is_none() {
            session_id = value
                .get("sessionId")
                .and_then(|v| v.as_str())
                .map(|s| s.to_string());
        }
        let Some(tokens) = value.get("tokens") else {
            continue;
        };
        let model = value
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("gemini")
            .to_string();
        let turn = GeminiModelTokens {
            model,
            input: json_u64(tokens, "input"),
            output: json_u64(tokens, "output"),
            cache_read: json_u64(tokens, "cached"),
        };
        let key = value
            .get("id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| {
                anon_index += 1;
                format!("__anon_{anon_index}")
            });
        by_id.insert(key, turn);
    }

    let token_record_count = by_id.len();
    let mut grouped: HashMap<String, GeminiModelTokens> = HashMap::new();
    for turn in by_id.into_values() {
        let entry = grouped
            .entry(turn.model.clone())
            .or_insert_with(|| GeminiModelTokens {
                model: turn.model.clone(),
                ..Default::default()
            });
        entry.input += turn.input;
        entry.output += turn.output;
        entry.cache_read += turn.cache_read;
    }

    GeminiJsonlCost {
        session_id,
        token_record_count,
        by_model: grouped.into_values().collect(),
    }
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct GeminiUsage {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read: u64,
    pub total_tokens: u64,
    pub cost_usd: Option<f64>,
    pub session_count: u32,
}

fn system_time_from_ms(ms: u128) -> Option<SystemTime> {
    let ms = u64::try_from(ms).ok()?;
    UNIX_EPOCH.checked_add(Duration::from_millis(ms))
}

fn jsonl_last_updated_ms(path: &Path) -> Option<u128> {
    let _meta = regular_file_meta(path)?;
    let file = fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        if !read_capped_line(&mut reader, &mut buf).ok()? {
            return None;
        }
        if buf.is_empty() {
            continue;
        }
        let Ok(line) = std::str::from_utf8(&buf) else {
            continue;
        };
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let value: serde_json::Value = serde_json::from_str(trimmed).ok()?;
        let iso = value.get("lastUpdated").and_then(|v| v.as_str())?;
        let parsed = chrono::DateTime::parse_from_rfc3339(iso).ok()?;
        let millis = parsed.timestamp_millis();
        if millis < 0 {
            return None;
        }
        return Some(millis as u128);
    }
}

fn local_midnight_of(date: chrono::NaiveDate) -> Option<SystemTime> {
    let naive = date.and_hms_opt(0, 0, 0)?;
    match Local.from_local_datetime(&naive) {
        chrono::LocalResult::Single(dt) => Some(dt.into()),
        chrono::LocalResult::Ambiguous(earliest, _) => Some(earliest.into()),
        chrono::LocalResult::None => None,
    }
}

fn local_day_start(now: SystemTime) -> SystemTime {
    let local: chrono::DateTime<Local> = now.into();
    local_midnight_of(local.date_naive()).unwrap_or(now)
}

fn local_yesterday_start(now: SystemTime) -> SystemTime {
    let local: chrono::DateTime<Local> = now.into();
    let yesterday = local
        .date_naive()
        .pred_opt()
        .unwrap_or_else(|| local.date_naive());
    local_midnight_of(yesterday).unwrap_or_else(|| {
        now.checked_sub(Duration::from_secs(24 * 3600))
            .unwrap_or(now)
    })
}

fn max_system_time(a: SystemTime, b: SystemTime) -> SystemTime {
    if a >= b {
        a
    } else {
        b
    }
}

fn all_chat_jsonl_files(gemini_home: &Path) -> Vec<PathBuf> {
    let tmp = gemini_home.join("tmp");
    let Ok(entries) = fs::read_dir(&tmp) else {
        return Vec::new();
    };
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if skip_tmp_slug(&name) {
            continue;
        }
        let dir = entry.path();
        let Ok(dir_meta) = fs::symlink_metadata(&dir) else {
            continue;
        };
        if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
            continue;
        }
        let chats = dir.join("chats");
        let chats_ok = fs::symlink_metadata(&chats)
            .map(|m| m.is_dir() && !m.file_type().is_symlink())
            .unwrap_or(false);
        if !chats_ok {
            continue;
        }
        let Ok(chat_entries) = fs::read_dir(&chats) else {
            continue;
        };
        for chat in chat_entries.flatten() {
            let path = chat.path();
            if path.extension().and_then(|s| s.to_str()) != Some("jsonl") {
                continue;
            }
            if regular_file_meta(&path).is_none() {
                continue;
            }
            files.push(path);
        }
    }
    files
}

const MAX_USAGE_JSONL: usize = 256;

/// List jsonl files touched today without opening historical content.
///
/// `mtime >= local midnight` is enough to include. Only files whose mtime
/// falls on local yesterday are opened for a `lastUpdated` peek (clock skew /
/// copied files). Older files are skipped. Inclusion is `max(lastUpdated, mtime)`.
fn usage_jsonl_paths(gemini_home: &Path, now: SystemTime) -> Vec<PathBuf> {
    let today_start = local_day_start(now);
    let yesterday_start = local_yesterday_start(now);
    let mut today = Vec::new();
    let mut borderline = Vec::new();

    for path in all_chat_jsonl_files(gemini_home) {
        let Some(metadata) = regular_file_meta(&path) else {
            continue;
        };
        let Ok(mtime) = metadata.modified() else {
            continue;
        };
        if mtime >= today_start {
            today.push((mtime, path));
        } else if mtime >= yesterday_start {
            borderline.push((mtime, path));
        }
    }

    let mut included = today;
    for (mtime, path) in borderline {
        let last = jsonl_last_updated_ms(&path).and_then(system_time_from_ms);
        let when = match last {
            Some(ts) => max_system_time(ts, mtime),
            None => mtime,
        };
        if when >= today_start {
            included.push((mtime, path));
        }
    }

    included.sort_by(|a, b| b.0.cmp(&a.0));
    included.truncate(MAX_USAGE_JSONL);
    included.into_iter().map(|(_, path)| path).collect()
}

/// Tokens are the **full session totals** for Gemini jsonl files touched today
/// (local calendar): `max(lastUpdated, mtime)` on or after local midnight.
/// Turns are not split at midnight — a session edited today contributes every
/// token record in that file, including earlier days in the same jsonl.
pub(crate) fn get_gemini_usage_inner(gemini_home: &Path, now: SystemTime) -> GeminiUsage {
    let mut usage = GeminiUsage::default();
    let mut any_cost = false;
    let mut cost_sum = 0.0;

    for path in usage_jsonl_paths(gemini_home, now) {
        usage.session_count += 1;
        let parsed = parse_gemini_jsonl(&path);
        for model in parsed.by_model {
            usage.input_tokens += model.input;
            usage.output_tokens += model.output;
            usage.cache_read += model.cache_read;
            if let Some(cost) = crate::agent_cost::estimate_token_cost_usd(
                &model.model,
                model.input,
                model.output,
                model.cache_read,
            ) {
                any_cost = true;
                cost_sum += cost;
            }
        }
    }

    usage.total_tokens = usage.input_tokens + usage.output_tokens + usage.cache_read;
    if any_cost {
        usage.cost_usd = Some(cost_sum);
    }
    usage
}

fn snapshot_gemini_sessions_inner(cwd: String) -> Result<Vec<GeminiSessionSnapshot>, String> {
    let Some(home) = gemini_home_dir() else {
        return Ok(Vec::new());
    };
    snapshot_gemini_sessions_from(&home, &cwd)
}

#[tauri::command]
pub async fn snapshot_gemini_sessions(cwd: String) -> Result<Vec<GeminiSessionSnapshot>, String> {
    tokio::task::spawn_blocking(move || snapshot_gemini_sessions_inner(cwd))
        .await
        .map_err(|error| format!("snapshot_gemini_sessions: blocking task failed: {error}"))?
}

#[tauri::command]
pub async fn get_gemini_usage() -> Result<GeminiUsage, String> {
    tokio::task::spawn_blocking(|| {
        let Some(home) = gemini_home_dir() else {
            return GeminiUsage::default();
        };
        get_gemini_usage_inner(&home, SystemTime::now())
    })
    .await
    .map_err(|error| format!("get_gemini_usage: blocking task failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    fn fixture_home() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/gemini")
    }

    #[test]
    fn snapshot_matches_project_root() {
        let snaps = snapshot_gemini_sessions_from(&fixture_home(), "/repo").unwrap();
        assert_eq!(snaps.len(), 1);
        assert_eq!(snaps[0].id, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
        assert!(snaps[0].size_bytes > 0);
        assert!(snaps[0].modified_at_ms > 0);
    }

    #[test]
    fn snapshot_empty_when_cwd_does_not_match_project_root() {
        let snaps = snapshot_gemini_sessions_from(&fixture_home(), "/other").unwrap();
        assert!(snaps.is_empty());
    }

    #[test]
    fn parse_dedups_duplicate_message_ids() {
        let path = fixture_home().join("tmp/demo/chats/session-demo.jsonl");
        let parsed = parse_gemini_jsonl(&path);
        assert_eq!(
            parsed.session_id.as_deref(),
            Some("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")
        );
        assert_eq!(parsed.token_record_count, 2);
        let input: u64 = parsed.by_model.iter().map(|m| m.input).sum();
        let output: u64 = parsed.by_model.iter().map(|m| m.output).sum();
        let cache_read: u64 = parsed.by_model.iter().map(|m| m.cache_read).sum();
        assert_eq!(input, 150);
        assert_eq!(output, 30);
        assert_eq!(cache_read, 5);
    }

    #[test]
    fn find_session_by_meta_id() {
        let path = find_session_jsonl(
            &fixture_home(),
            "/repo",
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        );
        assert!(path.is_some());
    }

    #[test]
    fn find_session_by_filename_contains_id() {
        let path = find_session_jsonl(&fixture_home(), "/repo", "demo");
        assert!(path
            .as_ref()
            .and_then(|p| p.file_name())
            .and_then(|n| n.to_str())
            .is_some_and(|n| n.contains("demo")));
    }

    #[test]
    fn find_session_unknown_id_is_none() {
        assert!(find_session_jsonl(&fixture_home(), "/repo", "does-not-exist").is_none());
    }

    #[test]
    fn scrape_pty_usage_last_match_wins() {
        let text = "Tokens: 40 input  12 output\n99 prompt tokens, 7 candidates";
        assert_eq!(scrape_pty_usage(text), Some((99, 7)));
    }

    #[test]
    fn scrape_pty_usage_none_when_absent() {
        assert_eq!(scrape_pty_usage("hello world"), None);
    }

    #[test]
    fn scrape_sibling_log_when_jsonl_has_no_tokens() {
        let path = fixture_home().join("tmp/notokens/chats/session-pty.jsonl");
        let parsed = parse_gemini_jsonl(&path);
        assert_eq!(parsed.token_record_count, 0);
        assert_eq!(scrape_session_pty_logs(&path), Some((99, 7)));
    }

    #[test]
    fn parse_skips_oversized_jsonl_lines() {
        let dir = std::env::temp_dir().join(format!("fw-gemini-cap-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("session.jsonl");
        let mut body = String::from("{\"sessionId\":\"cap-test\"}\n");
        body.push_str(&"x".repeat(MAX_LINE_BYTES + 8));
        body.push('\n');
        body.push_str(
            "{\"id\":\"m1\",\"type\":\"gemini\",\"tokens\":{\"input\":1,\"output\":1,\"cached\":0},\"model\":\"gemini-2.5-flash\"}\n",
        );
        fs::write(&path, body).unwrap();
        let parsed = parse_gemini_jsonl(&path);
        let _ = fs::remove_dir_all(&dir);
        assert_eq!(parsed.session_id.as_deref(), Some("cap-test"));
        assert_eq!(parsed.token_record_count, 1);
    }

    fn rfc3339_utc(t: SystemTime) -> String {
        let d = t.duration_since(UNIX_EPOCH).unwrap();
        chrono::DateTime::from_timestamp(d.as_secs() as i64, d.subsec_nanos())
            .expect("valid timestamp")
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
    }

    fn write_session_jsonl(path: &Path, session_id: &str, last_updated: &str, input: u64, output: u64) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(
            path,
            format!(
                "{{\"sessionId\":\"{session_id}\",\"lastUpdated\":\"{last_updated}\",\"kind\":\"main\"}}\n\
{{\"id\":\"m1\",\"type\":\"gemini\",\"tokens\":{{\"input\":{input},\"output\":{output},\"cached\":0}},\"model\":\"gemini-2.5-flash\"}}\n"
            ),
        )
        .unwrap();
    }

    #[test]
    fn get_gemini_usage_inner_aggregates_today_and_excludes_old() {
        let root = std::env::temp_dir().join(format!(
            "fw-gemini-usage-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("tmp/demo/chats")).unwrap();
        fs::create_dir_all(root.join("tmp/antigravity/chats")).unwrap();

        let now = SystemTime::now();
        let today = rfc3339_utc(now);
        let old = rfc3339_utc(now - Duration::from_secs(3 * 24 * 3600));

        write_session_jsonl(
            &root.join("tmp/demo/chats/today.jsonl"),
            "today-session",
            &today,
            100,
            20,
        );
        write_session_jsonl(
            &root.join("tmp/demo/chats/old.jsonl"),
            "old-session",
            &old,
            9999,
            8888,
        );
        fs::File::open(root.join("tmp/demo/chats/old.jsonl"))
            .unwrap()
            .set_modified(now - Duration::from_secs(3 * 24 * 3600))
            .unwrap();
        write_session_jsonl(
            &root.join("tmp/antigravity/chats/today.jsonl"),
            "agy-session",
            &today,
            50,
            50,
        );

        let mtime_path = root.join("tmp/demo/chats/mtime-today.jsonl");
        fs::write(
            &mtime_path,
            "{\"sessionId\":\"mtime-session\"}\n{\"id\":\"m1\",\"type\":\"gemini\",\"tokens\":{\"input\":5,\"output\":1,\"cached\":2},\"model\":\"gemini-2.5-flash\"}\n",
        )
        .unwrap();
        fs::File::open(&mtime_path)
            .unwrap()
            .set_modified(now)
            .unwrap();

        let usage = get_gemini_usage_inner(&root, now);
        let _ = fs::remove_dir_all(&root);

        assert_eq!(usage.session_count, 2);
        assert_eq!(usage.input_tokens, 105);
        assert_eq!(usage.output_tokens, 21);
        assert_eq!(usage.cache_read, 2);
        assert_eq!(usage.total_tokens, 128);
        assert!(usage.cost_usd.is_some());
        assert!(usage.cost_usd.unwrap() > 0.0);
    }

    #[test]
    fn get_gemini_usage_inner_counts_today_session_with_zero_tokens() {
        let root = std::env::temp_dir().join(format!(
            "fw-gemini-zero-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        let now = SystemTime::now();
        let path = root.join("tmp/demo/chats/empty.jsonl");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(
            &path,
            format!(
                "{{\"sessionId\":\"empty-today\",\"lastUpdated\":\"{}\",\"kind\":\"main\"}}\n",
                rfc3339_utc(now)
            ),
        )
        .unwrap();
        fs::File::open(&path).unwrap().set_modified(now).unwrap();

        let usage = get_gemini_usage_inner(&root, now);
        let _ = fs::remove_dir_all(&root);

        assert_eq!(usage.session_count, 1);
        assert_eq!(usage.total_tokens, 0);
        assert_eq!(usage.input_tokens, 0);
        assert_eq!(usage.output_tokens, 0);
        assert!(usage.cost_usd.is_none());
    }

    #[test]
    fn get_gemini_usage_inner_includes_old_last_updated_when_mtime_is_today() {
        let root = std::env::temp_dir().join(format!(
            "fw-gemini-mtime-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let _ = fs::remove_dir_all(&root);
        let now = SystemTime::now();
        let path = root.join("tmp/demo/chats/stale-meta.jsonl");
        write_session_jsonl(
            &path,
            "stale-meta",
            &rfc3339_utc(now - Duration::from_secs(3 * 24 * 3600)),
            40,
            10,
        );
        fs::File::open(&path).unwrap().set_modified(now).unwrap();

        let usage = get_gemini_usage_inner(&root, now);
        let _ = fs::remove_dir_all(&root);

        assert_eq!(usage.session_count, 1);
        assert_eq!(usage.input_tokens, 40);
        assert_eq!(usage.output_tokens, 10);
    }
}
