use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::Duration;
use tauri::AppHandle;

use crate::git_control::hide_console;
use crate::mcp_model::{McpServer, McpTransport};

const PATH_ESCAPE: &str = "path_escape";
const LOOPBACK_HOST: &str = "127.0.0.1";
const MAX_HTTP_BYTES: u64 = 1_048_576;
const HTTP_TIMEOUT: Duration = Duration::from_secs(30);
const MCP_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowNodeRecord {
    pub id: String,
    #[serde(rename = "type")]
    pub node_type: String,
    pub x: f64,
    pub y: f64,
    pub data: Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowEdgeRecord {
    pub id: String,
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FlowGraphRecord {
    pub id: String,
    pub project_id: String,
    pub name: String,
    pub nodes: Vec<FlowNodeRecord>,
    pub edges: Vec<FlowEdgeRecord>,
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
struct HttpAllowlistFile {
    #[serde(default)]
    hosts: Vec<String>,
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_')
    {
        return Err(format!("invalid {label}"));
    }
    Ok(())
}

fn write_json_atomically(path: &Path, contents: &str) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, contents).map_err(|error| error.to_string())?;
    fs::rename(&temporary, path).map_err(|error| error.to_string())
}

fn confined_home_file(folder: &str, relative: &[&str]) -> Result<PathBuf, String> {
    let meta = crate::project_home::detect(folder).ok_or_else(|| "no project home".to_string())?;
    let _ = meta;
    let root = fs::canonicalize(folder).map_err(|error| error.to_string())?;
    let home = root.join(".flashwork");
    let home_meta = fs::symlink_metadata(&home).map_err(|error| error.to_string())?;
    if home_meta.file_type().is_symlink() || !home_meta.is_dir() {
        return Err(PATH_ESCAPE.into());
    }
    let resolved_home = fs::canonicalize(&home).map_err(|error| error.to_string())?;
    if !resolved_home.starts_with(&root) {
        return Err(PATH_ESCAPE.into());
    }
    let mut path = resolved_home.clone();
    for part in relative {
        path.push(part);
    }
    if !path.starts_with(&resolved_home) {
        return Err(PATH_ESCAPE.into());
    }
    Ok(path)
}

fn confined_flows_dir(folder: &str) -> Result<PathBuf, String> {
    crate::project_home::ensure_history_layout(folder)?;
    let dir = confined_home_file(folder, &["history", "flows"])?;
    let metadata = fs::symlink_metadata(&dir).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("history/flows is not a directory".into());
    }
    Ok(fs::canonicalize(&dir).map_err(|error| error.to_string())?)
}

fn flow_graph_path(folder: &str, graph_id: &str) -> Result<PathBuf, String> {
    validate_id(graph_id, "flow id")?;
    let dir = confined_flows_dir(folder)?;
    let path = dir.join(format!("{graph_id}.json"));
    if path.parent() != Some(dir.as_path()) {
        return Err("flow path escapes history/flows".into());
    }
    Ok(path)
}

fn allowlist_path(folder: &str) -> Result<PathBuf, String> {
    confined_home_file(folder, &["harness", "http-allowlist.json"])
}

fn load_allowlist(folder: &str) -> Result<Vec<String>, String> {
    let path = allowlist_path(folder)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err("http allowlist is not a regular file".into());
    }
    let raw = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let parsed: HttpAllowlistFile =
        serde_json::from_str(&raw).map_err(|error| error.to_string())?;
    Ok(parsed
        .hosts
        .into_iter()
        .map(|host| host.trim().to_ascii_lowercase())
        .filter(|host| !host.is_empty())
        .collect())
}

fn host_in(host: &str, list: &[String]) -> bool {
    let normalized = host.trim().to_ascii_lowercase();
    list.iter().any(|item| item.trim().eq_ignore_ascii_case(&normalized))
}

pub(crate) fn assert_flow_http_url(
    raw: &str,
    allow_loopback: bool,
    allowlist_hosts: &[String],
    confirmed_hosts: &[String],
) -> Result<reqwest::Url, String> {
    let parsed = reqwest::Url::parse(raw).map_err(|_| "url_invalid".to_string())?;
    let scheme = parsed.scheme().to_ascii_lowercase();
    if scheme != "https" && scheme != "http" {
        return Err("url_scheme".into());
    }
    let host = parsed.host_str().ok_or_else(|| "url_host".to_string())?.to_ascii_lowercase();
    if scheme == "http" {
        if host == LOOPBACK_HOST {
            if !allow_loopback {
                return Err("url_loopback_denied".into());
            }
        } else if !host_in(&host, allowlist_hosts) {
            return Err("url_not_allowlisted".into());
        }
    }
    if !host_in(&host, confirmed_hosts) {
        return Err("url_unconfirmed".into());
    }
    Ok(parsed)
}

fn save_flow_graph_inner(folder: String, graph: FlowGraphRecord) -> Result<(), String> {
    validate_id(&graph.id, "flow id")?;
    validate_id(&graph.project_id, "project id")?;
    let path = flow_graph_path(&folder, &graph.id)?;
    let json = serde_json::to_string_pretty(&graph).map_err(|error| error.to_string())?;
    write_json_atomically(&path, &json)
}

fn list_flow_graphs_inner(folder: String) -> Result<Vec<FlowGraphRecord>, String> {
    let Ok(dir) = confined_flows_dir(&folder) else {
        return Ok(Vec::new());
    };
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(Vec::new()),
    };
    let mut graphs = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => continue,
        };
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|stem| stem.to_str()) else {
            continue;
        };
        if validate_id(stem, "flow id").is_err() {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(graph) = serde_json::from_str::<FlowGraphRecord>(&raw) else {
            continue;
        };
        if graph.id != stem {
            continue;
        }
        graphs.push(graph);
    }
    graphs.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(graphs)
}

fn delete_flow_graph_inner(folder: String, graph_id: String) -> Result<(), String> {
    let path = flow_graph_path(&folder, &graph_id)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn set_allowlist_inner(folder: String, hosts: Vec<String>) -> Result<(), String> {
    crate::project_home::ensure_history_layout(&folder)?;
    let path = allowlist_path(&folder)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let cleaned: Vec<String> = hosts
        .into_iter()
        .map(|host| host.trim().to_ascii_lowercase())
        .filter(|host| !host.is_empty())
        .collect();
    let json = serde_json::to_string_pretty(&HttpAllowlistFile { hosts: cleaned })
        .map_err(|error| error.to_string())?;
    write_json_atomically(&path, &json)
}

fn allowed_method(method: &str) -> Result<reqwest::Method, String> {
    match method.trim().to_ascii_uppercase().as_str() {
        "GET" => Ok(reqwest::Method::GET),
        "POST" => Ok(reqwest::Method::POST),
        "PUT" => Ok(reqwest::Method::PUT),
        "PATCH" => Ok(reqwest::Method::PATCH),
        "DELETE" => Ok(reqwest::Method::DELETE),
        "HEAD" => Ok(reqwest::Method::HEAD),
        _ => Err("http_method".into()),
    }
}

async fn flow_http_send(
    parsed: reqwest::Url,
    method: reqwest::Method,
    body: Option<String>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HTTP_TIMEOUT)
        .build()
        .map_err(|error| error.to_string())?;
    let mut request = client.request(method.clone(), parsed);
    if method != reqwest::Method::GET && method != reqwest::Method::HEAD {
        if let Some(body) = body {
            if body.len() as u64 > MAX_HTTP_BYTES {
                return Err("http_body_too_large".into());
            }
            request = request
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body(body);
        }
    }
    let response = request.send().await.map_err(|error| error.to_string())?;
    let status = response.status();
    let bytes = response.bytes().await.map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_HTTP_BYTES {
        return Err("http_response_too_large".into());
    }
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if !status.is_success() {
        return Err(format!("http_error:{}:{text}", status.as_u16()));
    }
    Ok(text)
}

fn write_mcp_message(writer: &mut impl Write, payload: &Value) -> Result<(), String> {
    let encoded = serde_json::to_vec(payload).map_err(|error| error.to_string())?;
    write!(writer, "Content-Length: {}\r\n\r\n", encoded.len()).map_err(|error| error.to_string())?;
    writer.write_all(&encoded).map_err(|error| error.to_string())?;
    writer.flush().map_err(|error| error.to_string())
}

fn read_mcp_message(reader: &mut impl Read) -> Result<Value, String> {
    let mut header = Vec::new();
    let mut buf = [0_u8; 1];
    loop {
        reader.read_exact(&mut buf).map_err(|error| error.to_string())?;
        header.push(buf[0]);
        if header.ends_with(b"\r\n\r\n") {
            break;
        }
        if header.len() > 4096 {
            return Err("mcp_header_too_large".into());
        }
    }
    let header_text = String::from_utf8_lossy(&header);
    let length = header_text
        .lines()
        .find_map(|line| {
            let (name, value) = line.split_once(':')?;
            if name.eq_ignore_ascii_case("content-length") {
                value.trim().parse::<usize>().ok()
            } else {
                None
            }
        })
        .ok_or_else(|| "mcp_content_length".to_string())?;
    if length > MAX_HTTP_BYTES as usize {
        return Err("mcp_body_too_large".into());
    }
    let mut body = vec![0_u8; length];
    reader.read_exact(&mut body).map_err(|error| error.to_string())?;
    serde_json::from_slice(&body).map_err(|error| error.to_string())
}

fn mcp_text_from_result(value: &Value) -> String {
    if let Some(error) = value.get("error") {
        return error.to_string();
    }
    let result = value.get("result").cloned().unwrap_or_else(|| value.clone());
    if let Some(content) = result.get("content").and_then(Value::as_array) {
        let texts: Vec<String> = content
            .iter()
            .filter_map(|item| item.get("text").and_then(Value::as_str).map(str::to_string))
            .collect();
        if !texts.is_empty() {
            return texts.join("\n");
        }
    }
    result.to_string()
}

fn call_mcp_stdio(server: &McpServer, tool_name: &str, arguments: Value) -> Result<String, String> {
    let McpTransport::Stdio { command, args, cwd } = &server.transport else {
        return Err("mcp_not_stdio".into());
    };
    let mut child_cmd = Command::new(command);
    child_cmd
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(cwd) = cwd {
        child_cmd.current_dir(cwd);
    }
    for (key, entry) in &server.env {
        if let Some(literal) = &entry.literal {
            child_cmd.env(key, literal);
        } else if let Some(from) = &entry.passthrough_from {
            if let Ok(value) = std::env::var(from) {
                child_cmd.env(key, value);
            }
        }
    }
    hide_console(&mut child_cmd);
    let mut child = child_cmd.spawn().map_err(|error| error.to_string())?;
    let mut stdin = child.stdin.take().ok_or_else(|| "mcp_stdin".to_string())?;
    let mut stdout = child.stdout.take().ok_or_else(|| "mcp_stdout".to_string())?;
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "flashwork", "version": "1.3.0" }
        }
    });
    write_mcp_message(&mut stdin, &initialize)?;
    let _ = read_mcp_message(&mut stdout)?;
    write_mcp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }),
    )?;
    write_mcp_message(
        &mut stdin,
        &json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": { "name": tool_name, "arguments": arguments }
        }),
    )?;
    let reply = read_mcp_message(&mut stdout)?;
    let _ = child.kill();
    let _ = child.wait();
    Ok(mcp_text_from_result(&reply))
}

fn find_configured_server(folder: &str, server_id: &str) -> Result<McpServer, String> {
    crate::mcp_store::find_enabled_server(Some(folder.to_string()), server_id)
        .ok_or_else(|| "mcp_not_configured".to_string())
}

fn flow_mcp_call_inner(
    folder: String,
    server_id: String,
    tool_name: String,
    arguments: Option<Value>,
) -> Result<String, String> {
    if tool_name.trim().is_empty() {
        return Err("mcp_tool_missing".into());
    }
    let server = find_configured_server(&folder, &server_id)?;
    call_mcp_stdio(&server, tool_name.trim(), arguments.unwrap_or(json!({})))
}

#[tauri::command]
pub async fn save_flow_graph(folder: String, graph: FlowGraphRecord) -> Result<(), String> {
    tokio::task::spawn_blocking(move || save_flow_graph_inner(folder, graph))
        .await
        .map_err(|error| format!("save_flow_graph task failed: {error}"))?
}

#[tauri::command]
pub async fn list_flow_graphs(folder: String) -> Result<Vec<FlowGraphRecord>, String> {
    tokio::task::spawn_blocking(move || list_flow_graphs_inner(folder))
        .await
        .map_err(|error| format!("list_flow_graphs task failed: {error}"))?
}

#[tauri::command]
pub async fn delete_flow_graph(folder: String, graph_id: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || delete_flow_graph_inner(folder, graph_id))
        .await
        .map_err(|error| format!("delete_flow_graph task failed: {error}"))?
}

#[tauri::command]
pub async fn flow_http_allowlist(folder: String) -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(move || load_allowlist(&folder))
        .await
        .map_err(|error| format!("flow_http_allowlist task failed: {error}"))?
}

#[tauri::command]
pub async fn flow_http_allowlist_set(folder: String, hosts: Vec<String>) -> Result<(), String> {
    tokio::task::spawn_blocking(move || set_allowlist_inner(folder, hosts))
        .await
        .map_err(|error| format!("flow_http_allowlist_set task failed: {error}"))?
}

#[tauri::command]
pub async fn flow_http(
    folder: String,
    url: String,
    method: String,
    body: Option<String>,
    confirmed_hosts: Vec<String>,
    allow_loopback: bool,
) -> Result<String, String> {
    let allowlist = tokio::task::spawn_blocking({
        let folder = folder.clone();
        move || load_allowlist(&folder)
    })
    .await
    .map_err(|error| format!("flow_http allowlist task failed: {error}"))??;
    let parsed = assert_flow_http_url(&url, allow_loopback, &allowlist, &confirmed_hosts)?;
    let method = allowed_method(&method)?;
    flow_http_send(parsed, method, body).await
}

#[tauri::command]
pub async fn flow_mcp_call(
    folder: String,
    server_id: String,
    tool_name: String,
    arguments: Option<Value>,
) -> Result<String, String> {
    let work = tokio::task::spawn_blocking(move || {
        flow_mcp_call_inner(folder, server_id, tool_name, arguments)
    });
    match tokio::time::timeout(MCP_TIMEOUT, work).await {
        Ok(Ok(result)) => result,
        Ok(Err(error)) => Err(format!("flow_mcp_call task failed: {error}")),
        Err(_) => Err("mcp_timeout".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> (bool, Vec<String>, Vec<String>) {
        (false, Vec::new(), vec!["example.com".into()])
    }

    #[test]
    fn denies_non_http_schemes() {
        let (loopback, allowlist, confirmed) = policy();
        for url in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "data:text/plain,hi",
            "ftp://example.com/a",
        ] {
            assert_eq!(
                assert_flow_http_url(url, loopback, &allowlist, &confirmed).unwrap_err(),
                "url_scheme"
            );
        }
    }

    #[test]
    fn https_needs_per_run_confirm() {
        let (loopback, allowlist, confirmed) = policy();
        assert!(assert_flow_http_url("https://example.com/v1", loopback, &allowlist, &confirmed).is_ok());
        assert_eq!(
            assert_flow_http_url("https://other.test/v1", loopback, &allowlist, &confirmed).unwrap_err(),
            "url_unconfirmed"
        );
    }

    #[test]
    fn loopback_http_is_opt_in() {
        let confirmed = vec!["127.0.0.1".into()];
        assert_eq!(
            assert_flow_http_url("http://127.0.0.1:9/", false, &[], &confirmed).unwrap_err(),
            "url_loopback_denied"
        );
        assert!(assert_flow_http_url("http://127.0.0.1:9/", true, &[], &confirmed).is_ok());
    }

    #[test]
    fn other_http_hosts_need_allowlist() {
        let confirmed = vec!["api.internal".into()];
        assert_eq!(
            assert_flow_http_url("http://api.internal/v1", false, &[], &confirmed).unwrap_err(),
            "url_not_allowlisted"
        );
        assert!(assert_flow_http_url(
            "http://api.internal/v1",
            false,
            &["api.internal".into()],
            &confirmed
        )
        .is_ok());
    }
}
