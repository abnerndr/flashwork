//

// get_session_cost(agent, cwd, session_id) periodicamente pro Token HUD.

use serde::Serialize;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};

/// USD per 1M tokens. Cache write/read multipliers match Claude (5m=1.25x, 1h=2x, read=0.1x).
struct Pricing {
    input: f64,
    output: f64,
    cache_write_5m: f64,
    cache_write_1h: f64,
    cache_read: f64,
}

///

pub(crate) fn opencode_db_path() -> Option<PathBuf> {
    if let Some(path) = opencode_db_path_from_cli() {
        return Some(path);
    }
    opencode_db_path_fallback_guess()
}

fn opencode_db_path_from_cli() -> Option<PathBuf> {
    let binary = crate::cli_resolver::find_windows_cli_launcher("opencode")?;
    let mut cmd = std::process::Command::new(&binary);
    cmd.args(["db", "path"]);
    crate::git_control::hide_console(&mut cmd);
    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let path = PathBuf::from(trimmed);
    if path.is_file() {
        Some(path)
    } else {
        None
    }
}

fn opencode_db_path_fallback_guess() -> Option<PathBuf> {
    #[cfg(target_os = "linux")]
    {
        dirs_next::data_local_dir().map(|d| d.join("opencode").join("opencode.db"))
    }
    #[cfg(not(target_os = "linux"))]
    {
        dirs_next::data_dir().map(|d| d.join("opencode").join("opencode.db"))
    }
}

/// Locked v1 family table: (needle, input USD/1M, output USD/1M). First `contains` match wins.
/// More-specific GPT needles (`gpt-5-mini`, `gpt-4o-mini`) come before generic `gpt-5` / `gpt-4o`.
const FAMILY_RATES: &[(&str, f64, f64)] = &[
    ("gpt-5-mini", 0.4, 1.6),
    ("o4-mini", 0.4, 1.6),
    ("gpt-4o-mini", 0.4, 1.6),
    ("gpt-5", 2.5, 10.0),
    ("gpt-4o", 2.5, 10.0),
    ("gemini-2.5-flash", 0.15, 0.60),
    ("gemini-2.0-flash", 0.15, 0.60),
    ("gemini-2.5-pro", 1.25, 10.0),
    ("opus", 5.0, 25.0),
    ("sonnet", 3.0, 15.0),
    ("haiku", 1.0, 5.0),
];

fn pricing_for(model: &str) -> Option<Pricing> {
    let m = model.to_ascii_lowercase();
    let (input, output) = FAMILY_RATES
        .iter()
        .find(|(needle, _, _)| m.contains(needle))
        .map(|(_, input, output)| (*input, *output))?;
    Some(Pricing {
        input,
        output,
        cache_write_5m: input * 1.25,
        cache_write_1h: input * 2.0,
        cache_read: input * 0.1,
    })
}

#[derive(Serialize, Default, Clone)]
pub struct ModelCost {
    pub model: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,

    pub cost_usd: Option<f64>,
}

#[derive(Serialize, Default)]
pub struct SessionCost {
    pub session_id: String,
    pub agent: String,
    pub input: u64,
    pub output: u64,
    pub cache_read: u64,
    pub cache_write_5m: u64,
    pub cache_write_1h: u64,
    pub total_tokens: u64,

    pub cost_usd: Option<f64>,
    /// Dominant model (highest output) — HUD label.
    pub model: Option<String>,
    pub by_model: Vec<ModelCost>,
    /// `pty` when tokens were scraped from a sibling log because the JSONL had none.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

pub(crate) fn estimate_token_cost_usd(
    model: &str,
    input: u64,
    output: u64,
    cache_read: u64,
) -> Option<f64> {
    let mut mc = ModelCost {
        model: model.to_string(),
        input,
        output,
        cache_read,
        ..Default::default()
    };
    mc.compute_cost();
    mc.cost_usd
}

impl ModelCost {
    fn compute_cost(&mut self) {
        if self.cost_usd.is_some() {
            return;
        }
        if let Some(p) = pricing_for(&self.model) {
            let cost = self.input as f64 / 1_000_000.0 * p.input
                + self.output as f64 / 1_000_000.0 * p.output
                + self.cache_read as f64 / 1_000_000.0 * p.cache_read
                + self.cache_write_5m as f64 / 1_000_000.0 * p.cache_write_5m
                + self.cache_write_1h as f64 / 1_000_000.0 * p.cache_write_1h;
            self.cost_usd = Some(cost);
        }
    }
}

/// agrupando por message.model.
fn parse_claude_cost(path: &PathBuf) -> std::collections::HashMap<String, ModelCost> {
    let mut by_model: std::collections::HashMap<String, ModelCost> =
        std::collections::HashMap::new();
    let Ok(file) = fs::File::open(path) else {
        return by_model;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let Some(message) = value.get("message") else {
            continue;
        };
        let Some(usage) = message.get("usage") else {
            continue;
        };
        let model = message
            .get("model")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown")
            .to_string();
        let entry = by_model.entry(model.clone()).or_insert_with(|| ModelCost {
            model,
            ..Default::default()
        });
        let u = |k: &str| usage.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
        entry.input += u("input_tokens");
        entry.output += u("output_tokens");
        entry.cache_read += u("cache_read_input_tokens");
        // Breakdown 5m/1h vem em cache_creation; fallback p/ cache_creation_input_tokens como 5m.
        let cc = usage.get("cache_creation");
        let cc5 = cc
            .and_then(|c| c.get("ephemeral_5m_input_tokens"))
            .and_then(|v| v.as_u64());
        let cc1 = cc
            .and_then(|c| c.get("ephemeral_1h_input_tokens"))
            .and_then(|v| v.as_u64());
        match (cc5, cc1) {
            (Some(a), Some(b)) => {
                entry.cache_write_5m += a;
                entry.cache_write_1h += b;
            }
            _ => {
                entry.cache_write_5m += u("cache_creation_input_tokens");
            }
        }
    }
    by_model
}

fn parse_codex_cost(path: &PathBuf) -> ModelCost {
    let mut cost = ModelCost {
        model: "codex".to_string(),
        ..Default::default()
    };
    let Ok(file) = fs::File::open(path) else {
        return cost;
    };
    for line in BufReader::new(file).lines().map_while(Result::ok) {
        if line.is_empty() {
            continue;
        }
        let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
            continue;
        };
        let payload = value.get("payload");
        let is_token_count =
            payload.and_then(|p| p.get("type")).and_then(|v| v.as_str()) == Some("token_count");
        if !is_token_count {
            continue;
        }
        let Some(total) = payload
            .and_then(|p| p.get("info"))
            .and_then(|i| i.get("total_token_usage"))
        else {
            continue;
        };
        let u = |k: &str| total.get(k).and_then(|v| v.as_u64()).unwrap_or(0);

        cost.input = u("input_tokens");
        cost.output = u("output_tokens");
        cost.cache_read = u("cached_input_tokens");
    }
    cost
}

fn find_codex_session_path(session_id: &str) -> Option<PathBuf> {
    let root = crate::codex_sessions::codex_sessions_dir()?;
    if !root.is_dir() {
        return None;
    }
    let mut files = Vec::new();
    crate::codex_sessions::collect_jsonl_files(&root, &mut files);
    for path in files {
        if let Some(id) = crate::codex_sessions::session_meta_id(&path) {
            if id == session_id {
                return Some(path);
            }
        }
    }
    None
}

#[tauri::command]
pub async fn get_session_cost(
    agent: String,
    cwd: String,
    session_id: String,
) -> Result<SessionCost, String> {
    tokio::task::spawn_blocking(move || get_session_cost_inner(agent, cwd, session_id))
        .await
        .map_err(|e| e.to_string())?
}

fn get_session_cost_inner(
    agent: String,
    cwd: String,
    session_id: String,
) -> Result<SessionCost, String> {
    let by_model: Vec<ModelCost> = match agent.as_str() {
        "codex" => {
            let Some(path) = find_codex_session_path(&session_id) else {
                return Err(format!("sessão codex {session_id} não encontrada"));
            };
            vec![parse_codex_cost(&path)]
        }
        "claude" => {
            let dirs = crate::claude_sessions::project_dirs_for_cwd(&cwd)?;
            let mut path: Option<PathBuf> = None;
            for dir in dirs {
                let candidate = dir.join(format!("{session_id}.jsonl"));
                if candidate.is_file() {
                    path = Some(candidate);
                    break;
                }
            }
            let Some(path) = path else {
                return Err(format!("sessão claude {session_id} não encontrada"));
            };
            parse_claude_cost(&path).into_values().collect()
        }
        "opencode" => {
            let db_path = opencode_db_path()
                .ok_or_else(|| "caminho do banco do OpenCode não encontrado".to_string())?;
            if !db_path.is_file() {
                return Err(format!("banco do OpenCode não encontrado em: {db_path:?}"));
            }

            let conn = rusqlite::Connection::open_with_flags(
                &db_path,
                rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
                    | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
            )
            .map_err(|e| format!("falha ao abrir banco do OpenCode: {e}"))?;

            let mut stmt = conn
                .prepare(
                    "SELECT model, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost FROM session WHERE id = ?1",
                )
                .map_err(|e| format!("falha ao preparar query: {e}"))?;

            let mut rows = stmt
                .query(rusqlite::params![session_id])
                .map_err(|e| format!("falha ao executar query: {e}"))?;

            let mut result_by_model = Vec::new();
            if let Some(row) = rows
                .next()
                .map_err(|e| format!("falha ao ler linha: {e}"))?
            {
                let model_raw: String = row.get(0).unwrap_or_default();
                let tokens_input: u64 = row.get(1).unwrap_or(0);
                let tokens_output: u64 = row.get(2).unwrap_or(0);
                let tokens_cache_read: u64 = row.get(3).unwrap_or(0);
                let tokens_cache_write: u64 = row.get(4).unwrap_or(0);
                let cost: f64 = row.get(5).unwrap_or(0.0);

                let model_name =
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&model_raw) {
                        v.get("id")
                            .and_then(|id| id.as_str())
                            .unwrap_or(&model_raw)
                            .to_string()
                    } else {
                        model_raw
                    };

                result_by_model.push(ModelCost {
                    model: model_name,
                    input: tokens_input,
                    output: tokens_output,
                    cache_read: tokens_cache_read,
                    cache_write_5m: tokens_cache_write,
                    cost_usd: Some(cost),
                    ..Default::default()
                });
            }
            result_by_model
        }
        "gemini" => {
            let home = crate::gemini_sessions::gemini_home_dir()
                .ok_or_else(|| "gemini home directory not found".to_string())?;
            return gemini_session_cost(&home, &cwd, &session_id);
        }
        other => return Err(format!("agente sem custo suportado: {other}")),
    };

    Ok(aggregate(agent, session_id, by_model))
}

pub(crate) fn gemini_session_cost(
    gemini_home: &Path,
    cwd: &str,
    session_id: &str,
) -> Result<SessionCost, String> {
    let Some(path) = crate::gemini_sessions::find_session_jsonl(gemini_home, cwd, session_id)
    else {
        return Err(format!("gemini session {session_id} not found"));
    };
    let parsed = crate::gemini_sessions::parse_gemini_jsonl(&path);
    let (by_model, source) = if parsed.token_record_count == 0 {
        if let Some((input, output)) = crate::gemini_sessions::scrape_session_pty_logs(&path) {
            (
                vec![ModelCost {
                    model: "gemini".to_string(),
                    input,
                    output,
                    ..Default::default()
                }],
                Some("pty".to_string()),
            )
        } else {
            (Vec::new(), None)
        }
    } else {
        (
            parsed
                .by_model
                .into_iter()
                .map(|m| ModelCost {
                    model: m.model,
                    input: m.input,
                    output: m.output,
                    cache_read: m.cache_read,
                    ..Default::default()
                })
                .collect(),
            None,
        )
    };
    let mut cost = aggregate("gemini".to_string(), session_id.to_string(), by_model);
    cost.source = source;
    Ok(cost)
}

#[tauri::command]
pub async fn get_transcript_cost(path: String) -> Result<SessionCost, String> {
    tokio::task::spawn_blocking(move || get_transcript_cost_inner(path))
        .await
        .map_err(|e| e.to_string())?
}

fn get_transcript_cost_inner(path: String) -> Result<SessionCost, String> {
    let pb = PathBuf::from(&path);
    if !pb.is_file() {
        return Err(format!("transcript não encontrado: {path}"));
    }
    let by_model: Vec<ModelCost> = parse_claude_cost(&pb).into_values().collect();
    Ok(aggregate("claude".to_string(), path, by_model))
}

/// modelo dominante por output). Compartilhado por get_session_cost e

fn aggregate(agent: String, session_id: String, mut by_model: Vec<ModelCost>) -> SessionCost {
    for mc in &mut by_model {
        mc.compute_cost();
    }

    let mut total = SessionCost {
        session_id,
        agent,
        ..Default::default()
    };
    let mut any_cost = false;
    let mut dominant: Option<(u64, String)> = None;
    for mc in &by_model {
        total.input += mc.input;
        total.output += mc.output;
        total.cache_read += mc.cache_read;
        total.cache_write_5m += mc.cache_write_5m;
        total.cache_write_1h += mc.cache_write_1h;
        if let Some(c) = mc.cost_usd {
            any_cost = true;
            total.cost_usd = Some(total.cost_usd.unwrap_or(0.0) + c);
        }
        let by_output = dominant
            .as_ref()
            .map(|(o, _)| mc.output > *o)
            .unwrap_or(true);
        if by_output {
            dominant = Some((mc.output, mc.model.clone()));
        }
    }
    if !any_cost {
        total.cost_usd = None;
    }
    total.total_tokens =
        total.input + total.output + total.cache_read + total.cache_write_5m + total.cache_write_1h;
    total.model = dominant.map(|(_, m)| m);
    total.by_model = by_model;
    total
}

#[derive(Serialize)]
pub struct ModelRate {
    pub family: String,
    pub input: f64,
    pub output: f64,
    pub cache_write_5m: f64,
    pub cache_write_1h: f64,
    pub cache_read: f64,
}

#[tauri::command]
pub fn get_model_pricing() -> Vec<ModelRate> {
    FAMILY_RATES
        .iter()
        .filter_map(|(family, _, _)| {
            pricing_for(family).map(|p| ModelRate {
                family: (*family).to_string(),
                input: p.input,
                output: p.output,
                cache_write_5m: p.cache_write_5m,
                cache_write_1h: p.cache_write_1h,
                cache_read: p.cache_read,
            })
        })
        .collect()
}

#[derive(Serialize, Default)]
pub struct OpenCodeUsageSummary {
    pub cost_usd: f64,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub session_count: u32,
    pub by_model: Vec<ModelCost>,
}

#[tauri::command]
pub async fn get_opencode_usage_summary(hours: u32) -> Result<OpenCodeUsageSummary, String> {
    tokio::task::spawn_blocking(move || get_opencode_usage_summary_inner(hours))
        .await
        .map_err(|e| e.to_string())?
}

fn get_opencode_usage_summary_inner(hours: u32) -> Result<OpenCodeUsageSummary, String> {
    let db_path = opencode_db_path()
        .ok_or_else(|| "caminho do banco do OpenCode não encontrado".to_string())?;
    if !db_path.is_file() {
        return Ok(OpenCodeUsageSummary::default());
    }

    let conn = rusqlite::Connection::open_with_flags(
        &db_path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| format!("falha ao abrir banco do OpenCode: {e}"))?;

    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let since_ms = now_ms - (hours as i64) * 3_600_000;

    let mut stmt = conn
        .prepare(
            "SELECT model, cost, tokens_input, tokens_output, tokens_cache_read, tokens_cache_write \
             FROM session WHERE time_updated >= ?1",
        )
        .map_err(|e| format!("falha ao preparar query: {e}"))?;

    let mut rows = stmt
        .query(rusqlite::params![since_ms])
        .map_err(|e| format!("falha ao executar query: {e}"))?;

    let mut by_model: std::collections::HashMap<String, ModelCost> =
        std::collections::HashMap::new();
    let mut session_count = 0u32;
    while let Some(row) = rows
        .next()
        .map_err(|e| format!("falha ao ler linha: {e}"))?
    {
        let model_raw: String = row.get(0).unwrap_or_default();
        let cost: f64 = row.get(1).unwrap_or(0.0);
        let tokens_input: u64 = row.get(2).unwrap_or(0);
        let tokens_output: u64 = row.get(3).unwrap_or(0);
        let tokens_cache_read: u64 = row.get(4).unwrap_or(0);
        let tokens_cache_write: u64 = row.get(5).unwrap_or(0);

        let model_name = if let Ok(v) = serde_json::from_str::<serde_json::Value>(&model_raw) {
            v.get("id")
                .and_then(|id| id.as_str())
                .unwrap_or(&model_raw)
                .to_string()
        } else {
            model_raw
        };
        if model_name.is_empty() {
            continue;
        }

        session_count += 1;
        let entry = by_model
            .entry(model_name.clone())
            .or_insert_with(|| ModelCost {
                model: model_name,
                cost_usd: Some(0.0),
                ..Default::default()
            });
        entry.input += tokens_input;
        entry.output += tokens_output;
        entry.cache_read += tokens_cache_read;
        entry.cache_write_5m += tokens_cache_write;
        entry.cost_usd = Some(entry.cost_usd.unwrap_or(0.0) + cost);
    }

    let mut by_model: Vec<ModelCost> = by_model.into_values().collect();
    by_model.sort_by(|a, b| {
        b.cost_usd
            .partial_cmp(&a.cost_usd)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    let cost_usd = by_model.iter().filter_map(|m| m.cost_usd).sum();
    let input_tokens = by_model.iter().map(|m| m.input).sum();
    let output_tokens = by_model.iter().map(|m| m.output).sum();

    Ok(OpenCodeUsageSummary {
        cost_usd,
        input_tokens,
        output_tokens,
        session_count,
        by_model,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pricing_for_still_resolves_claude_families_after_opencode_table_removal() {
        assert!(pricing_for("claude-opus-4-8").is_some());
        assert!(pricing_for("claude-sonnet-4-6").is_some());
        assert!(pricing_for("claude-haiku-4-5").is_some());

        assert!(pricing_for("deepseek-v4-flash-free").is_none());
    }

    #[test]
    fn compute_cost_never_overwrites_a_pre_set_cost_from_the_opencode_db() {
        // Simula o que o branch "opencode" de get_session_cost_inner faz: seta

        let mut mc = ModelCost {
            model: "deepseek-v4-flash".to_string(),
            input: 1000,
            output: 500,
            cost_usd: Some(0.0123),
            ..Default::default()
        };
        mc.compute_cost();
        assert_eq!(mc.cost_usd, Some(0.0123));
    }

    #[test]
    fn compute_cost_fills_in_claude_pricing_when_none_was_set() {
        let mut mc = ModelCost {
            model: "claude-opus-4-8".to_string(),
            input: 1_000_000,
            output: 0,
            ..Default::default()
        };
        mc.compute_cost();
        assert_eq!(mc.cost_usd, Some(5.0));
    }

    #[test]
    fn pricing_for_gemini_25_flash_is_some() {
        let p = pricing_for("gemini-2.5-flash").expect("gemini-2.5-flash should have pricing");
        assert_eq!(p.input, 0.15);
        assert_eq!(p.output, 0.60);
    }

    #[test]
    fn pricing_for_gpt5_mini_rates_differ_from_gpt5() {
        let mini = pricing_for("gpt-5-mini").expect("gpt-5-mini should have pricing");
        let full = pricing_for("gpt-5").expect("gpt-5 should have pricing");
        assert_eq!(mini.input, 0.4);
        assert_eq!(mini.output, 1.6);
        assert_eq!(full.input, 2.5);
        assert_eq!(full.output, 10.0);
        assert_ne!(mini.input, full.input);
        assert_ne!(mini.output, full.output);
    }

    #[test]
    fn unknown_model_leaves_cost_usd_none_but_still_sums_tokens() {
        let mc = ModelCost {
            model: "deepseek-v4-flash-free".to_string(),
            input: 100,
            output: 50,
            cache_read: 10,
            cache_write_5m: 5,
            cache_write_1h: 2,
            ..Default::default()
        };
        let total = aggregate("opencode".to_string(), "sess".to_string(), vec![mc]);
        assert_eq!(total.cost_usd, None);
        assert_eq!(total.input, 100);
        assert_eq!(total.output, 50);
        assert_eq!(total.cache_read, 10);
        assert_eq!(total.cache_write_5m, 5);
        assert_eq!(total.cache_write_1h, 2);
        assert_eq!(total.total_tokens, 167);
    }

    fn gemini_fixture_home() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/gemini")
    }

    #[test]
    fn gemini_fixture_session_cost_dedups_and_prices() {
        let cost = gemini_session_cost(
            &gemini_fixture_home(),
            "/repo",
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
        )
        .expect("fixture session");
        assert_eq!(cost.input, 150);
        assert_eq!(cost.output, 30);
        assert_eq!(cost.cache_read, 5);
        assert!(cost.cost_usd.is_some());
        assert_eq!(cost.source, None);
        assert_eq!(cost.model.as_deref(), Some("gemini-2.5-flash"));
    }

    #[test]
    fn gemini_unknown_session_id_errors() {
        match gemini_session_cost(&gemini_fixture_home(), "/repo", "does-not-exist") {
            Ok(_) => panic!("missing session should error"),
            Err(err) => assert!(err.contains("does-not-exist")),
        }
    }

    #[test]
    fn gemini_pty_scrape_sets_source_when_jsonl_has_no_tokens() {
        let cost = gemini_session_cost(
            &gemini_fixture_home(),
            "/repo-pty",
            "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
        )
        .expect("pty fixture session");
        assert_eq!(cost.input, 99);
        assert_eq!(cost.output, 7);
        assert_eq!(cost.source.as_deref(), Some("pty"));
    }
}
