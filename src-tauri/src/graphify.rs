//! Graphify integration (<https://github.com/Graphify-Labs/graphify>).
//!
//! 1. **Install/detect** the `graphify` CLI (PyPI `graphifyy[mcp]`) through
//!    `uv tool install` → `pipx install` → `pip install --user`, natively or, for a
//!    `\\wsl.localhost\<distro>\…` project on the Windows build, inside that distro.
//! 2. **Build** a code-only graph in the background: `graphify extract <root> --code-only`
//!    then `graphify cluster-only <root> --no-label`, with `GRAPHIFY_BACKEND=none` (local
//!    AST only, no API key, no LLM call). Output lands in `<root>/graphify-out/`.
//! 3. **MCP** — wire the stdio server `graphify-mcp <root>/graphify-out/graph.json` into every
//!    agent CLI: Claude (`--mcp-config` temp file), Codex (`.codex/config.toml`), OpenCode
//!    (`opencode.json`) and Gemini (`.gemini/settings.json`). WSL projects get the Linux
//!    path and the in-distro binary, since those files are read by Linux CLIs.
//! 4. **Viz + versioning** — normalize `graph.json` to `{ nodes, edges }` for the graph pane
//!    and snapshot/list/diff/rollback/prune it under `<repo>/.flashwork/graph-snapshots/`.
//!
//! Verified against graphify 0.9.92: `graphify <root> --mcp` is NOT an MCP server (it runs
//! an extraction and prints to stdout), so the server is always the `graphify-mcp` entrypoint.

use std::collections::HashMap;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use nanoid::nanoid;
use serde::Serialize;
use serde_json::Value;

use crate::git_control::{hide_console, repository_root};
use crate::provider_common::now_ms;
use crate::wsl::{self, WslPath};

const CLI_COMMAND: &str = "graphify";
const MCP_COMMAND: &str = "graphify-mcp";
const PACKAGE_SPEC: &str = "graphifyy[mcp]";
const MCP_SERVER_NAME: &str = "graphify";

/// Graphs above this size are truncated for the viz (with the `truncated` flag), keeping the
/// first N nodes.
const MAX_VIZ_NODES: usize = 3000;

const GRAPH_SUBDIR: &str = "graphify-out";
const GRAPH_FILE: &str = "graph.json";
const SNAPSHOTS_SUBDIR: &str = "graph-snapshots";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyStatus {
    available: bool,
    command: String,
    version: Option<String>,
}

/// Install state of Graphify for a project (native, or inside the project's WSL distro).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyInstallStatus {
    installed: bool,
    version: Option<String>,
    /// Resolved `graphify` binary.
    command: Option<String>,
    /// Resolved `graphify-mcp` binary (absent when installed without the `[mcp]` extra).
    mcp_command: Option<String>,
    /// Installers found, in fallback order (`uv`, `pipx`, `pip`).
    installers: Vec<String>,
    /// Distro the probe ran in, for WSL projects.
    wsl_distro: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphifyInstallResult {
    ok: bool,
    /// Installer that succeeded (or the last one tried).
    installer: Option<String>,
    output: String,
    status: GraphifyInstallStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    id: String,
    label: String,
    kind: Option<String>,
    group: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    id: String,
    source: String,
    target: String,
    label: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
    node_count: usize,
    edge_count: usize,
    truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    id: String,
    path: String,
    created_ms: u64,
    size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDiff {
    nodes_added: usize,
    nodes_removed: usize,
    edges_added: usize,
    edges_removed: usize,
}

fn short_hash(input: &str) -> String {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    input.hash(&mut hasher);
    format!("{:x}", hasher.finish())
}

fn graph_path(root: &Path) -> PathBuf {
    root.join(GRAPH_SUBDIR).join(GRAPH_FILE)
}

fn snapshots_dir(root: &Path) -> PathBuf {
    root.join(".flashwork").join(SNAPSHOTS_SUBDIR)
}

fn emit(event_type: &str, project_id: Option<String>, data: Value) {
    crate::event_bus::publish_event_simple(
        event_type,
        &format!("graphify-{}", nanoid!()),
        project_id,
        None,
        data,
    );
}

// ---------------------------------------------------------------------------
// Target resolution (native folder vs. WSL distro)
// ---------------------------------------------------------------------------

/// Where Graphify runs for a project folder.
#[derive(Debug, Clone, PartialEq, Eq)]
enum Target {
    /// A folder the app reaches directly (git toplevel, or the folder itself).
    Native { root: PathBuf },
    /// A folder inside a WSL distro, opened by the Windows build through its UNC path.
    Wsl { wsl: WslPath, host_root: PathBuf },
}

impl Target {
    /// Path the app uses for its own file I/O (graph.json, config files).
    fn host_root(&self) -> &Path {
        match self {
            Target::Native { root } => root,
            Target::Wsl { host_root, .. } => host_root,
        }
    }

    fn distro(&self) -> Option<&str> {
        match self {
            Target::Native { .. } => None,
            Target::Wsl { wsl, .. } => Some(&wsl.distro),
        }
    }
}

/// Git toplevel when the folder is a repository, otherwise the folder itself: every project
/// with a folder gets a graph, git or not.
fn project_root(repo: &str) -> Result<PathBuf, String> {
    match repository_root(repo) {
        Ok(root) => Ok(root),
        Err(error) => {
            let path = PathBuf::from(repo.trim());
            if path.is_dir() {
                path.canonicalize().map_err(|_| error)
            } else {
                Err(error)
            }
        }
    }
}

fn resolve_target(repo: &str) -> Result<Target, String> {
    if let Some(wsl) = wsl::wsl_target_for_cwd(Some(repo)) {
        return Ok(Target::Wsl {
            host_root: PathBuf::from(repo.trim()),
            wsl,
        });
    }
    Ok(Target::Native {
        root: project_root(repo)?,
    })
}

fn host_root(repo: &str) -> Result<PathBuf, String> {
    resolve_target(repo).map(|target| target.host_root().to_path_buf())
}

/// Drops the `\\?\` verbatim prefix `canonicalize` adds on Windows, so the path handed to
/// Python/CLIs is the plain `C:\…` spelling. Verbatim UNC paths are kept as-is.
fn plain_path_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    match raw.strip_prefix(r"\\?\") {
        Some(rest) if !rest.starts_with(r"UNC\") => rest.to_string(),
        _ => raw.into_owned(),
    }
}

fn linux_graph_json(linux_root: &str) -> String {
    let trimmed = linux_root.trim_end_matches('/');
    format!("{trimmed}/{GRAPH_SUBDIR}/{GRAPH_FILE}")
}

// ---------------------------------------------------------------------------
// Toolchain probing
// ---------------------------------------------------------------------------

/// What is available to run/install Graphify in a target.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct Toolchain {
    graphify: Option<String>,
    mcp: Option<String>,
    uv: Option<String>,
    pipx: Option<String>,
    /// Interpreter for the `pip install --user` fallback (`py`, `python3` or `python`).
    python: Option<String>,
}

impl Toolchain {
    fn installers(&self) -> Vec<String> {
        install_plan(self)
            .into_iter()
            .map(|step| step.installer.to_string())
            .collect()
    }
}

/// `pip install --user` script dirs that are often missing from PATH.
fn python_user_script_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    let mut push_children = |base: PathBuf, leaf: &str| {
        if let Ok(entries) = std::fs::read_dir(&base) {
            for entry in entries.flatten() {
                dirs.push(entry.path().join(leaf));
            }
        }
    };
    if cfg!(windows) {
        if let Some(app_data) = std::env::var_os("APPDATA") {
            push_children(PathBuf::from(app_data).join("Python"), "Scripts");
        }
    } else if cfg!(target_os = "macos") {
        if let Some(home) = std::env::var_os("HOME") {
            push_children(PathBuf::from(home).join("Library").join("Python"), "bin");
        }
    }
    dirs
}

/// Resolves a binary through the shared CLI resolver (PATH plus `~/.local/bin` /
/// `%USERPROFILE%\.local\bin`, where uv and pipx put tools), then the pip user dirs.
fn resolve_native_bin(name: &str) -> Option<String> {
    if let Some(path) = crate::cli_resolver::find_windows_cli_launcher(name) {
        return Some(plain_path_string(&path));
    }
    let candidates: Vec<String> = if cfg!(windows) {
        vec![format!("{name}.exe"), format!("{name}.cmd")]
    } else {
        vec![name.to_string()]
    };
    python_user_script_dirs().into_iter().find_map(|dir| {
        candidates
            .iter()
            .map(|candidate| dir.join(candidate))
            .find(|path| path.is_file())
            .map(|path| plain_path_string(&path))
    })
}

fn native_toolchain() -> Toolchain {
    let python_names: &[&str] = if cfg!(windows) {
        &["py", "python3", "python"]
    } else {
        &["python3", "python"]
    };
    Toolchain {
        graphify: resolve_native_bin(CLI_COMMAND),
        mcp: resolve_native_bin(MCP_COMMAND),
        uv: resolve_native_bin("uv"),
        pipx: resolve_native_bin("pipx"),
        python: python_names.iter().find_map(|name| resolve_native_bin(name)),
    }
}

const WSL_PROBE_NAMES: [&str; 5] = [CLI_COMMAND, MCP_COMMAND, "uv", "pipx", "python3"];
const WSL_PROBE_TTL: Duration = Duration::from_secs(30);

type WslProbeEntry = (Instant, Toolchain);
static WSL_PROBE_CACHE: OnceLock<Mutex<HashMap<String, WslProbeEntry>>> = OnceLock::new();

fn toolchain_from_probe(hits: &HashMap<String, String>) -> Toolchain {
    Toolchain {
        graphify: hits.get(CLI_COMMAND).cloned(),
        mcp: hits.get(MCP_COMMAND).cloned(),
        uv: hits.get("uv").cloned(),
        pipx: hits.get("pipx").cloned(),
        python: hits.get("python3").cloned(),
    }
}

/// `command -v` of the Graphify toolchain inside `distro`, one wsl.exe call. Cached briefly
/// (spawn paths call it per agent launch); `fresh` bypasses the cache after an install.
fn wsl_toolchain(distro: &str, fresh: bool) -> Toolchain {
    let cache = WSL_PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if !fresh {
        if let Ok(map) = cache.lock() {
            if let Some((at, toolchain)) = map.get(distro) {
                if at.elapsed() < WSL_PROBE_TTL {
                    return toolchain.clone();
                }
            }
        }
    }
    let script = wsl::command_v_script(&WSL_PROBE_NAMES);
    let args = vec![
        "-d".to_string(),
        distro.to_string(),
        "--exec".to_string(),
        "bash".to_string(),
        "-lc".to_string(),
        script,
    ];
    let hits = wsl::wsl_command(&args)
        .output()
        .map(|output| wsl::parse_command_v_output(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default();
    let toolchain = toolchain_from_probe(&hits);
    if let Ok(mut map) = cache.lock() {
        map.insert(distro.to_string(), (Instant::now(), toolchain.clone()));
    }
    toolchain
}

fn toolchain_for(target: &Target, fresh: bool) -> Toolchain {
    match target.distro() {
        Some(distro) => wsl_toolchain(distro, fresh),
        None => native_toolchain(),
    }
}

/// Native `graphify --version` (Python startup, ~100-300 ms).
fn native_version(command: &str) -> Option<String> {
    let mut probe = Command::new(command);
    probe.arg("--version");
    python_env(&mut probe);
    hide_console(&mut probe);
    let output = probe.output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// UTF-8 stdio for the Python CLI: a cp1252 Windows console would crash on graph labels.
fn python_env(command: &mut Command) {
    command.env("PYTHONIOENCODING", "utf-8");
    command.env("PYTHONUTF8", "1");
}

fn install_status(target: &Target, fresh: bool) -> GraphifyInstallStatus {
    let toolchain = toolchain_for(target, fresh);
    let version = match target {
        Target::Native { .. } => toolchain.graphify.as_deref().and_then(native_version),
        Target::Wsl { .. } => None,
    };
    GraphifyInstallStatus {
        installed: toolchain.graphify.is_some(),
        version,
        command: toolchain.graphify.clone(),
        mcp_command: toolchain.mcp.clone(),
        installers: toolchain.installers(),
        wsl_distro: target.distro().map(str::to_string),
    }
}

/// Status for `repo` (or the native host when absent / not a folder).
fn status_target(repo: Option<&str>) -> Target {
    repo.and_then(|repo| resolve_target(repo).ok())
        .unwrap_or_else(|| Target::Native {
            root: std::env::temp_dir(),
        })
}

#[tauri::command]
pub async fn graphify_status(repo: Option<String>) -> Result<GraphifyInstallStatus, String> {
    tokio::task::spawn_blocking(move || install_status(&status_target(repo.as_deref()), false))
        .await
        .map_err(|error| format!("graphify_status: blocking task failed: {error}"))
}

fn graphify_detect_inner(
    command: Option<String>,
    repo: Option<String>,
) -> Result<GraphifyStatus, String> {
    if let Some(cmd) = command {
        let version = native_version(&cmd);
        return Ok(GraphifyStatus {
            available: version.is_some(),
            command: cmd,
            version,
        });
    }
    let status = install_status(&status_target(repo.as_deref()), false);
    Ok(GraphifyStatus {
        available: status.installed,
        command: status.command.unwrap_or_else(|| CLI_COMMAND.to_string()),
        version: status.version,
    })
}

#[tauri::command]
pub async fn graphify_detect(
    command: Option<String>,
    repo: Option<String>,
) -> Result<GraphifyStatus, String> {
    tokio::task::spawn_blocking(move || graphify_detect_inner(command, repo))
        .await
        .map_err(|error| format!("graphify_detect: blocking task failed: {error}"))?
}

// ---------------------------------------------------------------------------
// Install (uv → pipx → pip)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq)]
struct InstallStep {
    installer: &'static str,
    program: String,
    args: Vec<String>,
}

/// Install commands in fallback order, only for the installers present.
fn install_plan(toolchain: &Toolchain) -> Vec<InstallStep> {
    let spec = PACKAGE_SPEC.to_string();
    let mut plan = Vec::new();
    if let Some(uv) = &toolchain.uv {
        plan.push(InstallStep {
            installer: "uv",
            program: uv.clone(),
            args: vec!["tool".into(), "install".into(), spec.clone()],
        });
    }
    if let Some(pipx) = &toolchain.pipx {
        plan.push(InstallStep {
            installer: "pipx",
            program: pipx.clone(),
            args: vec!["install".into(), spec.clone()],
        });
    }
    if let Some(python) = &toolchain.python {
        plan.push(InstallStep {
            installer: "pip",
            program: python.clone(),
            args: vec![
                "-m".into(),
                "pip".into(),
                "install".into(),
                "--user".into(),
                spec,
            ],
        });
    }
    plan
}

/// The same fallback chain as one script for `bash -lc` inside a WSL distro. The installer
/// that ran is printed as `@@installer=<name>` so the caller can report it.
fn wsl_install_script() -> String {
    let spec = wsl::posix_quote(PACKAGE_SPEC);
    format!(
        "{prelude}\
if command -v uv >/dev/null 2>&1; then echo '@@installer=uv'; uv tool install {spec} && exit 0; fi; \
if command -v pipx >/dev/null 2>&1; then echo '@@installer=pipx'; pipx install {spec} && exit 0; fi; \
if command -v python3 >/dev/null 2>&1; then echo '@@installer=pip'; python3 -m pip install --user {spec} && exit 0; fi; \
echo 'graphify: no installer found (uv, pipx or pip)' >&2; exit 127",
        prelude = wsl::PATH_PRELUDE,
    )
}

fn last_installer_marker(output: &str) -> Option<String> {
    output
        .lines()
        .filter_map(|line| line.trim().strip_prefix("@@installer="))
        .last()
        .map(str::to_string)
}

fn combined_output(output: &std::process::Output) -> String {
    let mut text = String::from_utf8_lossy(&output.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&output.stderr);
    if !stderr.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&stderr);
    }
    text
}

static INSTALLING: AtomicBool = AtomicBool::new(false);

struct InstallGuard;

impl Drop for InstallGuard {
    fn drop(&mut self) {
        INSTALLING.store(false, Ordering::SeqCst);
    }
}

fn graphify_install_inner(repo: Option<String>) -> Result<GraphifyInstallResult, String> {
    if INSTALLING.swap(true, Ordering::SeqCst) {
        return Err("install_in_progress".to_string());
    }
    let _guard = InstallGuard;
    let target = status_target(repo.as_deref());
    let mut log = String::new();
    let mut installer: Option<String> = None;

    match &target {
        Target::Wsl { wsl: path, .. } => {
            let script = wsl_install_script();
            let args = wsl::wsl_exec_args(&path.distro, "", Some(&script));
            let output = wsl::wsl_command(&args)
                .output()
                .map_err(|error| format!("wsl_failed:{error}"))?;
            log = combined_output(&output);
            installer = last_installer_marker(&log);
            if output.status.code() == Some(127) && installer.is_none() {
                return Err("no_installer".to_string());
            }
        }
        Target::Native { .. } => {
            let plan = install_plan(&native_toolchain());
            if plan.is_empty() {
                return Err("no_installer".to_string());
            }
            for step in plan {
                emit(
                    "GraphifyInstall",
                    None,
                    serde_json::json!({ "phase": "step", "installer": step.installer }),
                );
                log.push_str(&format!("$ {} {}\n", step.program, step.args.join(" ")));
                installer = Some(step.installer.to_string());
                let mut command = Command::new(&step.program);
                command.args(&step.args);
                python_env(&mut command);
                hide_console(&mut command);
                match command.output() {
                    Ok(output) => {
                        log.push_str(&combined_output(&output));
                        if output.status.success() {
                            break;
                        }
                    }
                    Err(error) => log.push_str(&format!("{error}\n")),
                }
            }
        }
    }

    let status = install_status(&target, true);
    emit(
        "GraphifyInstall",
        None,
        serde_json::json!({ "phase": "done", "installed": status.installed }),
    );
    Ok(GraphifyInstallResult {
        ok: status.installed,
        installer,
        output: log,
        status,
    })
}

#[tauri::command]
pub async fn graphify_install(repo: Option<String>) -> Result<GraphifyInstallResult, String> {
    tokio::task::spawn_blocking(move || graphify_install_inner(repo))
        .await
        .map_err(|error| format!("graphify_install: blocking task failed: {error}"))?
}

// ---------------------------------------------------------------------------
// Code-only graph build
// ---------------------------------------------------------------------------

static GENERATING: OnceLock<Mutex<std::collections::HashSet<PathBuf>>> = OnceLock::new();

fn generating_set() -> &'static Mutex<std::collections::HashSet<PathBuf>> {
    GENERATING.get_or_init(|| Mutex::new(std::collections::HashSet::new()))
}

/// `graphify` argv for a code-only build of `root`: AST extraction, then clustering without
/// LLM community naming (writes GRAPH_REPORT.md and graph.html).
fn build_steps(root: &str) -> Vec<Vec<String>> {
    vec![
        vec!["extract".into(), root.into(), "--code-only".into()],
        vec!["cluster-only".into(), root.into(), "--no-label".into()],
    ]
}

/// The build as one `bash -lc` script, run with `--cd <linux root>` inside the distro.
fn wsl_build_script(cli: &str) -> String {
    let cli = wsl::posix_quote(cli);
    format!(
        "{prelude}export GRAPHIFY_BACKEND=none; {cli} extract . --code-only && {cli} cluster-only . --no-label",
        prelude = wsl::PATH_PRELUDE,
    )
}

fn run_build(target: &Target, cli: &str) -> Result<(), String> {
    match target {
        Target::Native { root } => {
            let root_str = plain_path_string(root);
            for step in build_steps(&root_str) {
                let mut command = Command::new(cli);
                command
                    .args(&step)
                    .current_dir(root)
                    .env("GRAPHIFY_BACKEND", "none");
                python_env(&mut command);
                hide_console(&mut command);
                let output = command.output().map_err(|error| error.to_string())?;
                if !output.status.success() {
                    return Err(combined_output(&output).trim().to_string());
                }
            }
            Ok(())
        }
        Target::Wsl { wsl: path, .. } => {
            let script = wsl_build_script(cli);
            let args = wsl::wsl_exec_args(&path.distro, &path.linux_path, Some(&script));
            let output = wsl::wsl_command(&args)
                .output()
                .map_err(|error| error.to_string())?;
            if output.status.success() {
                Ok(())
            } else {
                Err(combined_output(&output).trim().to_string())
            }
        }
    }
}

/// Records the graph in `.flashwork/rag/STATUS.json` when the folder is a Flashwork home.
fn write_rag_exists(root: &Path) {
    let status = crate::project_home::RagStatus {
        graphify: crate::project_home::RagGraphifyStatus::Exists,
        updated_at: chrono::Utc::now().to_rfc3339(),
    };
    let _ = crate::project_home::write_rag_status(&root.to_string_lossy(), &status);
}

// Every blocking step (git, the CLI probe) runs off the async runtime: it is called on every
// agent spawn of a project, and under AV scanning a probe can take seconds.
fn graphify_ensure_graph_inner(repo: String, command: Option<String>) -> Result<String, String> {
    let target = resolve_target(&repo)?;
    let root = target.host_root().to_path_buf();
    if graph_path(&root).is_file() {
        return Ok("exists".to_string());
    }

    if generating_set()
        .lock()
        .map_err(|e| e.to_string())?
        .contains(&root)
    {
        return Ok("generating".to_string());
    }

    let cli = match command {
        Some(cmd) => native_version(&cmd).map(|_| cmd),
        None => toolchain_for(&target, false).graphify,
    };
    let Some(cli) = cli else {
        return Ok("unavailable".to_string());
    };

    {
        let mut set = generating_set().lock().map_err(|e| e.to_string())?;
        if set.contains(&root) {
            return Ok("generating".to_string());
        }
        set.insert(root.clone());
    }

    tauri::async_runtime::spawn_blocking(move || {
        let outcome = run_build(&target, &cli);
        if let Ok(mut set) = generating_set().lock() {
            set.remove(&root);
        }
        match outcome {
            Ok(()) => {
                write_rag_exists(&root);
                emit(
                    "GraphUpdated",
                    None,
                    serde_json::json!({ "action": "bootstrap", "repo": root.to_string_lossy() }),
                );
            }
            Err(error) => eprintln!("[graphify] build failed: {error}"),
        }
    });

    Ok("started".to_string())
}

#[tauri::command]
pub async fn graphify_ensure_graph(
    repo: String,
    command: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || graphify_ensure_graph_inner(repo, command))
        .await
        .map_err(|error| format!("graphify_ensure_graph: blocking task failed: {error}"))?
}

// ---------------------------------------------------------------------------
// MCP wiring for every agent CLI
// ---------------------------------------------------------------------------

/// The stdio MCP server launch, as the agent CLI will spawn it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct McpLaunch {
    command: String,
    args: Vec<String>,
}

fn native_mcp_launch(command: &str, graph_root: &Path) -> McpLaunch {
    McpLaunch {
        command: command.to_string(),
        args: vec![plain_path_string(&graph_path(graph_root))],
    }
}

/// For Linux CLIs inside a distro: Linux binary path and Linux graph path.
fn wsl_mcp_launch(command: &str, linux_root: &str) -> McpLaunch {
    McpLaunch {
        command: command.to_string(),
        args: vec![linux_graph_json(linux_root)],
    }
}

/// `None` when Graphify (its MCP entrypoint) is not installed for the target, so agents
/// never get a server entry that can only fail. `command` overrides resolution.
fn mcp_launch_for(graph_target: &Target, command: Option<&str>) -> Option<McpLaunch> {
    let resolved = match command {
        Some(cmd) => Some(cmd.to_string()),
        None => toolchain_for(graph_target, false).mcp,
    }?;
    Some(match graph_target {
        Target::Native { root } => native_mcp_launch(&resolved, root),
        Target::Wsl { wsl, .. } => wsl_mcp_launch(&resolved, &wsl.linux_path),
    })
}

/// Config dir (`repo`, where the CLI runs — may be a worktree) and the launch for the graph
/// of `graph_repo` (the project folder; defaults to `repo`).
fn mcp_context(
    repo: &str,
    graph_repo: Option<&str>,
    command: Option<&str>,
) -> Result<(PathBuf, Option<McpLaunch>), String> {
    let config_root = host_root(repo)?;
    let graph_target = match graph_repo.map(str::trim).filter(|g| !g.is_empty()) {
        Some(graph_repo) => resolve_target(graph_repo)?,
        None => resolve_target(repo)?,
    };
    Ok((config_root, mcp_launch_for(&graph_target, command)))
}

fn launch_json(launch: &McpLaunch) -> Value {
    serde_json::json!({ "command": launch.command, "args": launch.args })
}

fn claude_mcp_config(launch: &McpLaunch) -> Value {
    serde_json::json!({ "mcpServers": { MCP_SERVER_NAME: launch_json(launch) } })
}

/// Parses a JSON object config; `None` (leave the file alone) when it is not a JSON object.
fn parse_json_object(existing: Option<&str>) -> Option<Option<serde_json::Map<String, Value>>> {
    match existing {
        None => Some(None),
        Some(raw) if raw.trim().is_empty() => Some(None),
        Some(raw) => match serde_json::from_str::<Value>(raw) {
            Ok(Value::Object(map)) => Some(Some(map)),
            _ => None,
        },
    }
}

/// Upserts `<root_key>.graphify` with `fields`, keeping every other key, including keys of an
/// existing graphify entry Flashwork does not manage (env, cwd, a user `enabled: false`…).
fn upsert_json_server(
    existing: Option<&str>,
    seed: serde_json::Map<String, Value>,
    root_key: &str,
    fields: serde_json::Map<String, Value>,
    defaults: serde_json::Map<String, Value>,
) -> Option<String> {
    let mut config = parse_json_object(existing)?.unwrap_or(seed);
    let servers = config
        .entry(root_key.to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    let Value::Object(servers) = servers else {
        return None;
    };
    let entry = servers
        .entry(MCP_SERVER_NAME.to_string())
        .or_insert_with(|| Value::Object(serde_json::Map::new()));
    if !entry.is_object() {
        *entry = Value::Object(serde_json::Map::new());
    }
    let Value::Object(entry) = entry else {
        return None;
    };
    for (key, value) in fields {
        entry.insert(key, value);
    }
    for (key, value) in defaults {
        entry.entry(key).or_insert(value);
    }
    let mut body = serde_json::to_string_pretty(&Value::Object(config)).ok()?;
    body.push('\n');
    Some(body)
}

/// `opencode.json` `mcp.graphify` (<https://opencode.ai/docs/mcp-servers/>).
fn upsert_opencode_config(existing: Option<&str>, launch: &McpLaunch) -> Option<String> {
    let mut seed = serde_json::Map::new();
    seed.insert(
        "$schema".to_string(),
        Value::String("https://opencode.ai/config.json".to_string()),
    );
    let mut command = vec![Value::String(launch.command.clone())];
    command.extend(launch.args.iter().cloned().map(Value::String));
    let mut fields = serde_json::Map::new();
    fields.insert("type".into(), Value::String("local".into()));
    fields.insert("command".into(), Value::Array(command));
    let mut defaults = serde_json::Map::new();
    defaults.insert("enabled".into(), Value::Bool(true));
    upsert_json_server(existing, seed, "mcp", fields, defaults)
}

/// `.gemini/settings.json` `mcpServers.graphify` (same shape `gemini mcp add -s project`
/// writes).
fn upsert_gemini_settings(existing: Option<&str>, launch: &McpLaunch) -> Option<String> {
    let mut fields = serde_json::Map::new();
    fields.insert("command".into(), Value::String(launch.command.clone()));
    fields.insert(
        "args".into(),
        Value::Array(launch.args.iter().cloned().map(Value::String).collect()),
    );
    upsert_json_server(
        existing,
        serde_json::Map::new(),
        "mcpServers",
        fields,
        serde_json::Map::new(),
    )
}

/// `.codex/config.toml` `[mcp_servers.graphify]`, edited with toml_edit so comments, order and
/// every other table survive. `None` when the file does not parse (left untouched).
fn upsert_codex_config(existing: &str, launch: &McpLaunch) -> Option<String> {
    use toml_edit::{value, Array, DocumentMut, Item, Table};
    let mut doc: DocumentMut = existing.parse().ok()?;
    if !doc.contains_key("mcp_servers") {
        let mut servers = Table::new();
        servers.set_implicit(true);
        doc.insert("mcp_servers", Item::Table(servers));
    }
    let servers = doc.get_mut("mcp_servers")?.as_table_like_mut()?;
    if servers.get(MCP_SERVER_NAME).is_none() {
        servers.insert(MCP_SERVER_NAME, Item::Table(Table::new()));
    }
    let entry = servers.get_mut(MCP_SERVER_NAME)?.as_table_like_mut()?;
    entry.insert("command", value(launch.command.as_str()));
    let args: Array = launch.args.iter().map(String::as_str).collect();
    entry.insert("args", value(args));
    let mut body = doc.to_string();
    if !body.ends_with('\n') {
        body.push('\n');
    }
    Some(body)
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    if !path.is_file() {
        return Ok(None);
    }
    std::fs::read_to_string(path)
        .map(Some)
        .map_err(|e| format!("read_failed:{e}"))
}

/// Writes only when the content changed, so CLIs watching their config are not poked.
fn write_if_changed(path: &Path, previous: Option<&str>, body: &str) -> Result<(), String> {
    if previous == Some(body) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
    }
    std::fs::write(path, body).map_err(|e| format!("write_failed:{e}"))
}

fn graphify_mcp_config_path_inner(
    repo: String,
    graph_repo: Option<String>,
    command: Option<String>,
) -> Result<String, String> {
    let (config_root, launch) = mcp_context(&repo, graph_repo.as_deref(), command.as_deref())?;
    let launch = launch.ok_or_else(|| "unavailable".to_string())?;
    let body = serde_json::to_string_pretty(&claude_mcp_config(&launch)).map_err(|e| e.to_string())?;
    let file_name = format!(
        "flashwork-graphify-mcp-{}.json",
        short_hash(&format!("{}\u{0}{body}", config_root.to_string_lossy()))
    );
    // Lives in the Windows %TEMP% even for WSL projects: pty.rs translates the
    // `--mcp-config` argument to `/mnt/c/…`; the content already carries Linux paths.
    let path = std::env::temp_dir().join(file_name);
    std::fs::write(&path, body).map_err(|e| format!("write_failed:{e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn graphify_mcp_config_path(
    repo: String,
    graph_repo: Option<String>,
    command: Option<String>,
) -> Result<String, String> {
    tokio::task::spawn_blocking(move || graphify_mcp_config_path_inner(repo, graph_repo, command))
        .await
        .map_err(|error| format!("graphify_mcp_config_path: blocking task failed: {error}"))?
}

/// Upserts `mcp.graphify` in `<repo>/opencode.json`. Skipped when Graphify is not installed,
/// when the file is not a JSON object, or when the project uses `opencode.jsonc`.
pub(crate) fn graphify_opencode_config_write_inner(
    repo: String,
    command: Option<String>,
) -> Result<(), String> {
    write_opencode_config(&repo, None, command.as_deref())
}

fn write_opencode_config(
    repo: &str,
    graph_repo: Option<&str>,
    command: Option<&str>,
) -> Result<(), String> {
    let (config_root, launch) = mcp_context(repo, graph_repo, command)?;
    let Some(launch) = launch else {
        return Ok(());
    };
    if config_root.join("opencode.jsonc").is_file() {
        return Ok(());
    }
    let path = config_root.join("opencode.json");
    let existing = read_optional(&path)?;
    match upsert_opencode_config(existing.as_deref(), &launch) {
        Some(body) => write_if_changed(&path, existing.as_deref(), &body),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn graphify_opencode_config_write(
    repo: String,
    graph_repo: Option<String>,
    command: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        write_opencode_config(&repo, graph_repo.as_deref(), command.as_deref())
    })
    .await
    .map_err(|error| format!("graphify_opencode_config_write: blocking task failed: {error}"))?
}

fn write_codex_config(
    repo: &str,
    graph_repo: Option<&str>,
    command: Option<&str>,
) -> Result<(), String> {
    let (config_root, launch) = mcp_context(repo, graph_repo, command)?;
    let Some(launch) = launch else {
        return Ok(());
    };
    let path = config_root.join(".codex").join("config.toml");
    let existing = read_optional(&path)?;
    match upsert_codex_config(existing.as_deref().unwrap_or(""), &launch) {
        Some(body) => write_if_changed(&path, existing.as_deref(), &body),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn graphify_codex_config_write(
    repo: String,
    graph_repo: Option<String>,
    command: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        write_codex_config(&repo, graph_repo.as_deref(), command.as_deref())
    })
    .await
    .map_err(|error| format!("graphify_codex_config_write: blocking task failed: {error}"))?
}

fn write_gemini_config(
    repo: &str,
    graph_repo: Option<&str>,
    command: Option<&str>,
) -> Result<(), String> {
    let (config_root, launch) = mcp_context(repo, graph_repo, command)?;
    let Some(launch) = launch else {
        return Ok(());
    };
    let path = config_root.join(".gemini").join("settings.json");
    let existing = read_optional(&path)?;
    match upsert_gemini_settings(existing.as_deref(), &launch) {
        Some(body) => write_if_changed(&path, existing.as_deref(), &body),
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn graphify_gemini_config_write(
    repo: String,
    graph_repo: Option<String>,
    command: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        write_gemini_config(&repo, graph_repo.as_deref(), command.as_deref())
    })
    .await
    .map_err(|error| format!("graphify_gemini_config_write: blocking task failed: {error}"))?
}

// ---------------------------------------------------------------------------
// Graph viz + snapshots
// ---------------------------------------------------------------------------

fn value_to_id(value: &Value) -> Option<String> {
    match value {
        Value::String(s) => Some(s.clone()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

fn first_str<'a>(obj: &'a serde_json::Map<String, Value>, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| obj.get(*k).and_then(|v| v.as_str()))
}

/// Normalizes `graph.json` to `{ nodes, edges }`, accepting common field names.
fn graphify_read_graph_inner(repo: String) -> Result<GraphData, String> {
    let root = host_root(&repo)?;
    let path = graph_path(&root);
    if !path.is_file() {
        return Err("graph_not_found".to_string());
    }
    let raw = std::fs::read_to_string(&path).map_err(|e| format!("read_failed:{e}"))?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid_graph_json:{e}"))?;

    let node_values = value
        .get("nodes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let edge_values = value
        .get("edges")
        .or_else(|| value.get("links"))
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let total_nodes = node_values.len();
    let total_edges = edge_values.len();
    let truncated = total_nodes > MAX_VIZ_NODES;

    let mut nodes = Vec::new();
    let mut kept_ids = std::collections::HashSet::new();
    for node in node_values.into_iter().take(MAX_VIZ_NODES) {
        let Some(obj) = node.as_object() else {
            continue;
        };
        let Some(id) = obj.get("id").and_then(value_to_id) else {
            continue;
        };
        let label = first_str(obj, &["label", "name", "title"])
            .map(|s| s.to_string())
            .unwrap_or_else(|| id.clone());
        let kind = first_str(obj, &["type", "kind", "category"]).map(|s| s.to_string());
        let group = first_str(obj, &["group", "community", "module"]).map(|s| s.to_string());
        kept_ids.insert(id.clone());
        nodes.push(GraphNode {
            id,
            label,
            kind,
            group,
        });
    }

    let mut edges = Vec::new();
    for edge in edge_values {
        let Some(obj) = edge.as_object() else {
            continue;
        };
        let (Some(source), Some(target)) = (
            obj.get("source").and_then(value_to_id),
            obj.get("target").and_then(value_to_id),
        ) else {
            continue;
        };

        if !kept_ids.contains(&source) || !kept_ids.contains(&target) {
            continue;
        }
        let label = first_str(obj, &["label", "relation", "type"]).map(|s| s.to_string());
        let id = obj
            .get("id")
            .and_then(value_to_id)
            .unwrap_or_else(|| format!("{source}->{target}"));
        edges.push(GraphEdge {
            id,
            source,
            target,
            label,
        });
    }

    Ok(GraphData {
        nodes,
        edges,
        node_count: total_nodes,
        edge_count: total_edges,
        truncated,
    })
}

#[tauri::command]
pub async fn graphify_read_graph(repo: String) -> Result<GraphData, String> {
    tokio::task::spawn_blocking(move || graphify_read_graph_inner(repo))
        .await
        .map_err(|error| format!("graphify_read_graph: blocking task failed: {error}"))?
}

/// Copies the current `graph.json` to `.flashwork/graph-snapshots/<ts>.json`.

pub(crate) fn graphify_snapshot_inner(
    repo: String,
    project_id: Option<String>,
) -> Result<SnapshotInfo, String> {
    let root = host_root(&repo)?;
    let source = graph_path(&root);
    if !source.is_file() {
        return Err("graph_not_found".to_string());
    }
    let dir = snapshots_dir(&root);
    std::fs::create_dir_all(&dir).map_err(|e| format!("mkdir_failed:{e}"))?;
    let ts = now_ms();
    let dest = dir.join(format!("{ts}.json"));
    std::fs::copy(&source, &dest).map_err(|e| format!("copy_failed:{e}"))?;
    let size_bytes = std::fs::metadata(&dest).map(|m| m.len()).unwrap_or(0);

    let info = SnapshotInfo {
        id: ts.to_string(),
        path: dest.to_string_lossy().into_owned(),
        created_ms: ts,
        size_bytes,
    };
    emit(
        "GraphSnapshotted",
        project_id,
        serde_json::json!({ "snapshot_id": info.id, "size_bytes": size_bytes }),
    );
    Ok(info)
}

#[tauri::command]
pub async fn graphify_snapshot(
    repo: String,
    project_id: Option<String>,
) -> Result<SnapshotInfo, String> {
    tokio::task::spawn_blocking(move || graphify_snapshot_inner(repo, project_id))
        .await
        .map_err(|error| format!("graphify_snapshot: blocking task failed: {error}"))?
}

fn read_snapshots(root: &Path) -> Result<Vec<SnapshotInfo>, String> {
    let dir = snapshots_dir(root);
    let mut result = Vec::new();
    if !dir.is_dir() {
        return Ok(result);
    }
    let entries = std::fs::read_dir(&dir).map_err(|e| format!("read_dir_failed:{e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let Ok(created_ms) = stem.parse::<u64>() else {
            continue;
        };
        let size_bytes = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
        result.push(SnapshotInfo {
            id: stem.to_string(),
            path: path.to_string_lossy().into_owned(),
            created_ms,
            size_bytes,
        });
    }
    result.sort_by(|a, b| b.created_ms.cmp(&a.created_ms));
    Ok(result)
}

fn graphify_list_snapshots_inner(repo: String) -> Result<Vec<SnapshotInfo>, String> {
    let root = host_root(&repo)?;
    read_snapshots(&root)
}

#[tauri::command]
pub async fn graphify_list_snapshots(repo: String) -> Result<Vec<SnapshotInfo>, String> {
    tokio::task::spawn_blocking(move || graphify_list_snapshots_inner(repo))
        .await
        .map_err(|error| format!("graphify_list_snapshots: blocking task failed: {error}"))?
}

fn id_sets(
    path: &Path,
) -> Result<
    (
        std::collections::HashSet<String>,
        std::collections::HashSet<String>,
    ),
    String,
> {
    let raw = std::fs::read_to_string(path).map_err(|e| format!("read_failed:{e}"))?;
    let value: Value = serde_json::from_str(&raw).map_err(|e| format!("invalid_graph_json:{e}"))?;
    let mut node_ids = std::collections::HashSet::new();
    if let Some(arr) = value.get("nodes").and_then(|v| v.as_array()) {
        for node in arr {
            if let Some(id) = node.get("id").and_then(value_to_id) {
                node_ids.insert(id);
            }
        }
    }
    let mut edge_ids = std::collections::HashSet::new();
    let edges = value
        .get("edges")
        .or_else(|| value.get("links"))
        .and_then(|v| v.as_array());
    if let Some(arr) = edges {
        for edge in arr {
            if let (Some(s), Some(t)) = (
                edge.get("source").and_then(value_to_id),
                edge.get("target").and_then(value_to_id),
            ) {
                edge_ids.insert(format!("{s}->{t}"));
            }
        }
    }
    Ok((node_ids, edge_ids))
}

fn snapshot_file(root: &Path, id: &str) -> Result<PathBuf, String> {
    // Digits only: a forged id must not allow path traversal.
    if id.is_empty() || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err("invalid_snapshot_id".to_string());
    }
    let path = snapshots_dir(root).join(format!("{id}.json"));
    if !path.is_file() {
        return Err("snapshot_not_found".to_string());
    }
    Ok(path)
}

fn graphify_diff_snapshot_inner(
    repo: String,
    base_id: String,
    compare_id: Option<String>,
) -> Result<GraphDiff, String> {
    let root = host_root(&repo)?;
    let base_path = snapshot_file(&root, &base_id)?;
    let compare_path = match compare_id {
        Some(id) => snapshot_file(&root, &id)?,
        None => graph_path(&root),
    };
    let (base_nodes, base_edges) = id_sets(&base_path)?;
    let (cmp_nodes, cmp_edges) = id_sets(&compare_path)?;
    Ok(GraphDiff {
        nodes_added: cmp_nodes.difference(&base_nodes).count(),
        nodes_removed: base_nodes.difference(&cmp_nodes).count(),
        edges_added: cmp_edges.difference(&base_edges).count(),
        edges_removed: base_edges.difference(&cmp_edges).count(),
    })
}

#[tauri::command]
pub async fn graphify_diff_snapshot(
    repo: String,
    base_id: String,
    compare_id: Option<String>,
) -> Result<GraphDiff, String> {
    tokio::task::spawn_blocking(move || graphify_diff_snapshot_inner(repo, base_id, compare_id))
        .await
        .map_err(|error| format!("graphify_diff_snapshot: blocking task failed: {error}"))?
}

/// Restores a snapshot over `graphify-out/graph.json`.
fn graphify_rollback_inner(
    repo: String,
    snapshot_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    let root = host_root(&repo)?;
    let source = snapshot_file(&root, &snapshot_id)?;
    let dest = graph_path(&root);
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("mkdir_failed:{e}"))?;
    }
    std::fs::copy(&source, &dest).map_err(|e| format!("copy_failed:{e}"))?;
    emit(
        "GraphUpdated",
        project_id,
        serde_json::json!({ "action": "rollback", "snapshot_id": snapshot_id }),
    );
    Ok(())
}

#[tauri::command]
pub async fn graphify_rollback(
    repo: String,
    snapshot_id: String,
    project_id: Option<String>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || graphify_rollback_inner(repo, snapshot_id, project_id))
        .await
        .map_err(|error| format!("graphify_rollback: blocking task failed: {error}"))?
}

fn graphify_prune_snapshots_inner(
    repo: String,
    keep_last: usize,
    max_age_days: Option<u64>,
    project_id: Option<String>,
) -> Result<usize, String> {
    let root = host_root(&repo)?;
    let snapshots = read_snapshots(&root)?;
    let now = now_ms();
    let max_age_ms = max_age_days.map(|d| d.saturating_mul(24 * 60 * 60 * 1000));
    let mut removed = 0usize;

    for (index, snap) in snapshots.iter().enumerate() {
        let too_many = index >= keep_last;
        let too_old = max_age_ms
            .map(|age| now.saturating_sub(snap.created_ms) > age)
            .unwrap_or(false);
        if too_many || too_old {
            if std::fs::remove_file(&snap.path).is_ok() {
                removed += 1;
            }
        }
    }

    if removed > 0 {
        emit(
            "GraphSnapshotted",
            project_id,
            serde_json::json!({ "action": "prune", "removed": removed }),
        );
    }
    Ok(removed)
}

#[tauri::command]
pub async fn graphify_prune_snapshots(
    repo: String,
    keep_last: usize,
    max_age_days: Option<u64>,
    project_id: Option<String>,
) -> Result<usize, String> {
    tokio::task::spawn_blocking(move || {
        graphify_prune_snapshots_inner(repo, keep_last, max_age_days, project_id)
    })
    .await
    .map_err(|error| format!("graphify_prune_snapshots: blocking task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    use super::graphify_diff_snapshot_inner as graphify_diff_snapshot;
    use super::graphify_ensure_graph_inner as graphify_ensure_graph;
    use super::graphify_list_snapshots_inner as graphify_list_snapshots;
    use super::graphify_prune_snapshots_inner as graphify_prune_snapshots;
    use super::graphify_read_graph_inner as graphify_read_graph;
    use super::graphify_rollback_inner as graphify_rollback;
    use super::graphify_snapshot_inner as graphify_snapshot;
    use crate::git_control::checked_output;
    use std::fs;

    const FAKE_MCP: &str = "/opt/graphify/bin/graphify-mcp";

    fn temp_repo_with_graph() -> PathBuf {
        let suffix = now_ms();
        let root = std::env::temp_dir().join(format!("flashwork-graphify-{suffix}-{}", nanoid!(6)));
        fs::create_dir_all(&root).unwrap();
        let run = |args: &[&str]| checked_output(&root, args).unwrap();
        run(&["init"]);
        run(&["config", "user.name", "Flashwork Test"]);
        run(&["config", "user.email", "flashwork@example.invalid"]);
        let out_dir = root.join(GRAPH_SUBDIR);
        fs::create_dir_all(&out_dir).unwrap();
        let graph = serde_json::json!({
            "nodes": [
                { "id": "a", "label": "File A", "type": "file" },
                { "id": "b", "name": "func_b", "kind": "function" },
                { "id": "c" }
            ],
            "links": [
                { "source": "a", "target": "b", "relation": "calls" },
                { "source": "b", "target": "c" }
            ]
        });
        fs::write(out_dir.join(GRAPH_FILE), graph.to_string()).unwrap();
        root
    }

    fn launch() -> McpLaunch {
        McpLaunch {
            command: FAKE_MCP.to_string(),
            args: vec!["/repo/graphify-out/graph.json".to_string()],
        }
    }

    #[test]
    fn reads_and_normalizes_graph() {
        let root = temp_repo_with_graph();
        let root_str = root.to_string_lossy().into_owned();
        let data = graphify_read_graph(root_str).unwrap();
        assert_eq!(data.node_count, 3);
        assert_eq!(data.nodes.len(), 3);
        assert_eq!(data.edges.len(), 2);
        assert!(!data.truncated);

        let c = data.nodes.iter().find(|n| n.id == "c").unwrap();
        assert_eq!(c.label, "c");
        let a = data.nodes.iter().find(|n| n.id == "a").unwrap();
        assert_eq!(a.kind.as_deref(), Some("file"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_list_diff_rollback_and_prune() {
        let root = temp_repo_with_graph();
        let root_str = root.to_string_lossy().into_owned();

        let snap = graphify_snapshot(root_str.clone(), None).unwrap();
        assert!(snap.size_bytes > 0);
        assert_eq!(graphify_list_snapshots(root_str.clone()).unwrap().len(), 1);

        let out = root.join(GRAPH_SUBDIR).join(GRAPH_FILE);
        let smaller = serde_json::json!({
            "nodes": [ { "id": "a" }, { "id": "b" } ],
            "links": [ { "source": "a", "target": "b" } ]
        });
        fs::write(&out, smaller.to_string()).unwrap();
        let diff = graphify_diff_snapshot(root_str.clone(), snap.id.clone(), None).unwrap();
        assert_eq!(diff.nodes_removed, 1); // 'c' is gone
        assert_eq!(diff.edges_removed, 1);

        graphify_rollback(root_str.clone(), snap.id.clone(), None).unwrap();
        assert_eq!(graphify_read_graph(root_str.clone()).unwrap().node_count, 3);

        // keep_last=0 removes everything.
        let removed = graphify_prune_snapshots(root_str.clone(), 0, None, None).unwrap();
        assert_eq!(removed, 1);
        assert_eq!(graphify_list_snapshots(root_str).unwrap().len(), 0);

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ensure_graph_bootstrap_states() {
        let root = temp_repo_with_graph();
        let root_str = root.to_string_lossy().into_owned();
        assert_eq!(graphify_ensure_graph(root_str, None).unwrap(), "exists");

        let bare = std::env::temp_dir().join(format!("flashwork-graphify-lock-{}", nanoid!(6)));
        fs::create_dir_all(&bare).unwrap();
        let run = |args: &[&str]| checked_output(&bare, args).unwrap();
        run(&["init"]);
        let canon = bare.canonicalize().unwrap();
        generating_set().lock().unwrap().insert(canon.clone());
        let bare_str = bare.to_string_lossy().into_owned();
        assert_eq!(
            graphify_ensure_graph(bare_str.clone(), None).unwrap(),
            "generating"
        );
        generating_set().lock().unwrap().remove(&canon);

        let status = graphify_ensure_graph(
            bare_str,
            Some("flashwork-nonexistent-graphify-cli".to_string()),
        )
        .unwrap();
        assert_eq!(status, "unavailable");

        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(bare).unwrap();
    }

    #[test]
    fn non_git_folders_still_resolve_to_themselves() {
        let dir = std::env::temp_dir().join(format!("flashwork-graphify-plain-{}", nanoid!(6)));
        fs::create_dir_all(&dir).unwrap();
        let root = host_root(&dir.to_string_lossy()).unwrap();
        assert_eq!(root, dir.canonicalize().unwrap());
        assert!(host_root("/definitely/not/a/folder/flashwork").is_err());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_forged_snapshot_id() {
        let root = temp_repo_with_graph();
        let root_str = root.to_string_lossy().into_owned();
        assert!(graphify_rollback(root_str.clone(), "../evil".into(), None).is_err());
        assert!(graphify_diff_snapshot(root_str, "abc".into(), None).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn install_plan_follows_uv_pipx_pip_order() {
        let all = Toolchain {
            uv: Some("/bin/uv".into()),
            pipx: Some("/bin/pipx".into()),
            python: Some("/bin/python3".into()),
            ..Toolchain::default()
        };
        let plan = install_plan(&all);
        let installers: Vec<&str> = plan.iter().map(|s| s.installer).collect();
        assert_eq!(installers, ["uv", "pipx", "pip"]);
        assert_eq!(plan[0].args, ["tool", "install", "graphifyy[mcp]"]);
        assert_eq!(plan[1].args, ["install", "graphifyy[mcp]"]);
        assert_eq!(
            plan[2].args,
            ["-m", "pip", "install", "--user", "graphifyy[mcp]"]
        );

        let pip_only = Toolchain {
            python: Some("py".into()),
            ..Toolchain::default()
        };
        let plan = install_plan(&pip_only);
        assert_eq!(plan.len(), 1);
        assert_eq!(plan[0].program, "py");
        assert_eq!(pip_only.installers(), ["pip"]);

        assert!(install_plan(&Toolchain::default()).is_empty());
    }

    #[test]
    fn wsl_install_script_chains_the_fallbacks() {
        let script = wsl_install_script();
        assert!(script.starts_with(wsl::PATH_PRELUDE));
        let uv = script.find("uv tool install 'graphifyy[mcp]'").unwrap();
        let pipx = script.find("pipx install 'graphifyy[mcp]'").unwrap();
        let pip = script
            .find("python3 -m pip install --user 'graphifyy[mcp]'")
            .unwrap();
        assert!(uv < pipx && pipx < pip);
        assert!(script.ends_with("exit 127"));
        assert_eq!(
            last_installer_marker("@@installer=uv\nfailed\n@@installer=pipx\nok"),
            Some("pipx".to_string())
        );
        assert_eq!(last_installer_marker("nothing"), None);
    }

    #[test]
    fn build_commands_are_code_only_and_offline() {
        let steps = build_steps("/repo");
        assert_eq!(steps[0], ["extract", "/repo", "--code-only"]);
        assert_eq!(steps[1], ["cluster-only", "/repo", "--no-label"]);
        let script = wsl_build_script("/home/u/.local/bin/graphify");
        assert!(script.contains("export GRAPHIFY_BACKEND=none;"));
        assert!(script.contains("'/home/u/.local/bin/graphify' extract . --code-only &&"));
        assert!(script.ends_with("'/home/u/.local/bin/graphify' cluster-only . --no-label"));
    }

    #[test]
    fn toolchain_from_wsl_probe_maps_linux_paths() {
        let hits = wsl::parse_command_v_output(
            "graphify\t/home/u/.local/bin/graphify\ngraphify-mcp\t/home/u/.local/bin/graphify-mcp\npython3\t/usr/bin/python3\n",
        );
        let toolchain = toolchain_from_probe(&hits);
        assert_eq!(toolchain.graphify.as_deref(), Some("/home/u/.local/bin/graphify"));
        assert_eq!(toolchain.mcp.as_deref(), Some("/home/u/.local/bin/graphify-mcp"));
        assert_eq!(toolchain.uv, None);
        assert_eq!(toolchain.installers(), ["pip"]);
    }

    #[test]
    fn mcp_launches_use_graphify_mcp_with_the_graph_json() {
        let native = native_mcp_launch("graphify-mcp", Path::new("/repo"));
        assert_eq!(native.command, "graphify-mcp");
        assert_eq!(
            PathBuf::from(&native.args[0]),
            Path::new("/repo").join("graphify-out").join("graph.json")
        );

        let wsl_launch = wsl_mcp_launch("/home/u/.local/bin/graphify-mcp", "/home/u/proj/");
        assert_eq!(wsl_launch.command, "/home/u/.local/bin/graphify-mcp");
        assert_eq!(wsl_launch.args, ["/home/u/proj/graphify-out/graph.json"]);

        // A UNC project path maps to its Linux root for the launch.
        let parsed = wsl::parse_wsl_unc(r"\\wsl.localhost\Ubuntu\home\u\proj").unwrap();
        let target = Target::Wsl {
            host_root: PathBuf::from(r"\\wsl.localhost\Ubuntu\home\u\proj"),
            wsl: parsed,
        };
        let launch = mcp_launch_for(&target, Some("graphify-mcp")).unwrap();
        assert_eq!(launch.args, ["/home/u/proj/graphify-out/graph.json"]);
        assert_eq!(target.distro(), Some("Ubuntu"));

        let claude = claude_mcp_config(&launch);
        assert_eq!(claude["mcpServers"]["graphify"]["command"], "graphify-mcp");
        assert_eq!(
            claude["mcpServers"]["graphify"]["args"][0],
            "/home/u/proj/graphify-out/graph.json"
        );
    }

    #[test]
    fn plain_path_strips_only_the_verbatim_drive_prefix() {
        assert_eq!(plain_path_string(Path::new(r"\\?\C:\repo")), r"C:\repo");
        assert_eq!(
            plain_path_string(Path::new(r"\\?\UNC\server\share")),
            r"\\?\UNC\server\share"
        );
        assert_eq!(plain_path_string(Path::new("/repo")), "/repo");
    }

    #[test]
    fn opencode_upsert_creates_and_merges_without_clobbering() {
        let created = upsert_opencode_config(None, &launch()).unwrap();
        let parsed: Value = serde_json::from_str(&created).unwrap();
        assert_eq!(parsed["$schema"], "https://opencode.ai/config.json");
        assert_eq!(parsed["mcp"]["graphify"]["type"], "local");
        assert_eq!(parsed["mcp"]["graphify"]["command"][0], FAKE_MCP);
        assert_eq!(
            parsed["mcp"]["graphify"]["command"][1],
            "/repo/graphify-out/graph.json"
        );
        assert_eq!(parsed["mcp"]["graphify"]["enabled"], true);

        let existing = r#"{"model": "anthropic/claude-sonnet-4-5", "mcp": {"other": {"type": "local", "command": ["x"]}, "graphify": {"type": "local", "command": ["graphify", "/repo", "--mcp"], "enabled": false, "environment": {"A": "1"}}}}"#;
        let merged: Value =
            serde_json::from_str(&upsert_opencode_config(Some(existing), &launch()).unwrap())
                .unwrap();
        assert_eq!(merged["model"], "anthropic/claude-sonnet-4-5");
        assert_eq!(merged["mcp"]["other"]["command"][0], "x");
        assert_eq!(merged["mcp"]["graphify"]["command"][0], FAKE_MCP);
        assert_eq!(merged["mcp"]["graphify"]["command"].as_array().unwrap().len(), 2);
        // The user's own switch and env survive.
        assert_eq!(merged["mcp"]["graphify"]["enabled"], false);
        assert_eq!(merged["mcp"]["graphify"]["environment"]["A"], "1");
        assert!(merged.get("$schema").is_none());

        // Idempotent.
        let once = upsert_opencode_config(Some(existing), &launch()).unwrap();
        assert_eq!(upsert_opencode_config(Some(&once), &launch()).unwrap(), once);

        // Not a JSON object: left alone.
        assert!(upsert_opencode_config(Some("{ broken"), &launch()).is_none());
        assert!(upsert_opencode_config(Some("[1]"), &launch()).is_none());
    }

    #[test]
    fn gemini_upsert_writes_mcp_servers_and_keeps_other_settings() {
        let created: Value =
            serde_json::from_str(&upsert_gemini_settings(None, &launch()).unwrap()).unwrap();
        assert_eq!(created["mcpServers"]["graphify"]["command"], FAKE_MCP);
        assert_eq!(
            created["mcpServers"]["graphify"]["args"][0],
            "/repo/graphify-out/graph.json"
        );

        let existing = r#"{"theme": "Dracula", "mcpServers": {"other": {"command": "x"}, "graphify": {"command": "old", "trust": true}}}"#;
        let body = upsert_gemini_settings(Some(existing), &launch()).unwrap();
        let merged: Value = serde_json::from_str(&body).unwrap();
        assert_eq!(merged["theme"], "Dracula");
        assert_eq!(merged["mcpServers"]["other"]["command"], "x");
        assert_eq!(merged["mcpServers"]["graphify"]["command"], FAKE_MCP);
        assert_eq!(merged["mcpServers"]["graphify"]["trust"], true);
        assert_eq!(upsert_gemini_settings(Some(&body), &launch()).unwrap(), body);
        assert!(upsert_gemini_settings(Some("// comment\n{}"), &launch()).is_none());
    }

    #[test]
    fn codex_upsert_replaces_only_its_own_block() {
        let existing = "# my config\nmodel = \"gpt-5\"\n\n[mcp_servers.other]\ncommand = \"other-cmd\"\n\n[mcp_servers.graphify]\ncommand = \"graphify\"\nargs = [\"/repo\", \"--mcp\"]\n\n[mcp_servers.graphify.env]\nA = \"1\"\n";
        let body = upsert_codex_config(existing, &launch()).unwrap();
        assert!(body.starts_with("# my config\nmodel = \"gpt-5\""), "{body}");
        assert!(body.contains("[mcp_servers.other]\ncommand = \"other-cmd\""), "{body}");
        assert!(body.contains(&format!("command = \"{FAKE_MCP}\"")), "{body}");
        assert!(body.contains("args = [\"/repo/graphify-out/graph.json\"]"), "{body}");
        assert!(!body.contains("--mcp"), "{body}");
        assert!(body.contains("[mcp_servers.graphify.env]\nA = \"1\""), "{body}");
        assert_eq!(body.matches("[mcp_servers.graphify]").count(), 1);
        assert_eq!(upsert_codex_config(&body, &launch()).unwrap(), body);

        let fresh = upsert_codex_config("", &launch()).unwrap();
        assert!(fresh.contains("[mcp_servers.graphify]"), "{fresh}");
        assert!(!fresh.contains("[mcp_servers]\n"), "{fresh}");

        assert!(upsert_codex_config("not = = toml", &launch()).is_none());
    }

    #[test]
    fn codex_upsert_wsl_launch_uses_linux_paths() {
        let wsl_launch = wsl_mcp_launch("/home/u/.local/bin/graphify-mcp", "/home/u/proj");
        let body = upsert_codex_config("", &wsl_launch).unwrap();
        assert!(body.contains("command = \"/home/u/.local/bin/graphify-mcp\""), "{body}");
        assert!(body.contains("args = [\"/home/u/proj/graphify-out/graph.json\"]"), "{body}");
        assert!(!body.contains('\\'), "{body}");
    }

    #[test]
    fn config_writers_upsert_files_in_the_project_root() {
        let root = temp_repo_with_graph();
        let root_str = root.to_string_lossy().into_owned();

        write_opencode_config(&root_str, None, Some(FAKE_MCP)).unwrap();
        write_codex_config(&root_str, None, Some(FAKE_MCP)).unwrap();
        write_gemini_config(&root_str, None, Some(FAKE_MCP)).unwrap();

        let canon = root.canonicalize().unwrap();
        let graph = plain_path_string(&graph_path(&canon));
        let opencode: Value =
            serde_json::from_str(&fs::read_to_string(root.join("opencode.json")).unwrap()).unwrap();
        assert_eq!(opencode["mcp"]["graphify"]["command"][1], graph.as_str());
        let codex = fs::read_to_string(root.join(".codex/config.toml")).unwrap();
        assert!(codex.contains("[mcp_servers.graphify]"));
        let gemini: Value = serde_json::from_str(
            &fs::read_to_string(root.join(".gemini/settings.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(gemini["mcpServers"]["graphify"]["args"][0], graph.as_str());

        // opencode.jsonc projects are left alone.
        fs::remove_file(root.join("opencode.json")).unwrap();
        fs::write(root.join("opencode.jsonc"), "{}").unwrap();
        write_opencode_config(&root_str, None, Some(FAKE_MCP)).unwrap();
        assert!(!root.join("opencode.json").exists());

        let claude_path =
            graphify_mcp_config_path_inner(root_str, None, Some(FAKE_MCP.into())).unwrap();
        let claude: Value =
            serde_json::from_str(&fs::read_to_string(&claude_path).unwrap()).unwrap();
        assert_eq!(claude["mcpServers"]["graphify"]["command"], FAKE_MCP);
        let _ = fs::remove_file(claude_path);

        fs::remove_dir_all(root).unwrap();
    }
}
