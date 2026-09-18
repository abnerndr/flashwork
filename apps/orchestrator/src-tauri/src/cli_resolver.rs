use portable_pty::CommandBuilder;
use std::collections::HashMap;
use std::env;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::OnceLock;
use std::time::{Duration, Instant, SystemTime};

#[cfg(windows)]
use winreg::{enums::*, RegKey};

static REBUILT_PATH: OnceLock<String> = OnceLock::new();

pub fn default_shell() -> String {
    #[cfg(windows)]
    {
        if which::which("pwsh.exe").is_ok() {
            return "pwsh.exe".to_string();
        }
        "powershell.exe".to_string()
    }
    #[cfg(not(windows))]
    {
        std::env::var("SHELL")
            .ok()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or_else(|| "/bin/bash".to_string())
    }
}

fn shell_stem(command: &str) -> String {
    std::path::Path::new(command)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or(command)
        .to_ascii_lowercase()
}

/// True when `command` is itself a shell we can spawn as the PTY process.
/// Used so installer PTYs get an interactive pwsh/bash instead of being wrapped
/// in `default_shell() -Command` / `-lc`, which is not a prompt we can write into.
pub(crate) fn is_interactive_shell_name(command: &str) -> bool {
    matches!(
        shell_stem(command).as_str(),
        "pwsh" | "powershell" | "bash" | "zsh" | "sh"
    )
}

pub fn command_builder_for_terminal(
    initial_command: Option<&str>,
    resolved_launcher: Option<&str>,
    extra_args: &[String],
) -> CommandBuilder {
    let trimmed = initial_command
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let mut builder = match trimmed {
        Some(command) if extra_args.is_empty() && is_interactive_shell_name(command) => {
            // Spawn pwsh/bash as the PTY process itself. Wrapping them in
            // default_shell() -NoProfile -Command / -lc would nest another
            // non-interactive shell and break writing an install pipeline
            // into the prompt.
            let exe = resolved_launcher.unwrap_or(command);
            let mut builder = CommandBuilder::new(exe);
            let stem = shell_stem(exe);
            if stem == "pwsh" || stem == "powershell" {
                builder.arg("-NoLogo");
            }
            builder
        }
        Some(command) => {
            let arg = resolved_launcher
                .map(|s| s.to_string())
                .unwrap_or_else(|| command.to_string());
            let shell = default_shell();

            #[cfg(windows)]
            {
                let escaped = arg.replace('\'', "''");
                let extras_pwsh = extra_args
                    .iter()
                    .map(|a| format!(" '{}'", a.replace('\'', "''")))
                    .collect::<String>();
                let mut builder = CommandBuilder::new(&shell);
                builder.arg("-NoLogo");
                builder.arg("-NoProfile");
                builder.arg("-Command");
                builder.arg(format!("& '{escaped}'{extras_pwsh}; exit $LASTEXITCODE"));
                builder
            }
            #[cfg(not(windows))]
            {
                // POSIX: exec the launcher plus args, with single quotes escaped.
                let esc = |s: &str| s.replace('\'', "'\\''");
                let mut line = format!("exec '{}'", esc(&arg));
                for a in extra_args {
                    line.push_str(&format!(" '{}'", esc(a)));
                }
                let mut builder = CommandBuilder::new(&shell);
                builder.arg("-lc");
                builder.arg(line);
                builder
            }
        }
        None => {
            let shell = default_shell();
            let mut builder = CommandBuilder::new(&shell);
            if shell.eq_ignore_ascii_case("pwsh.exe")
                || shell.eq_ignore_ascii_case("powershell.exe")
            {
                builder.arg("-NoLogo");
            }
            builder
        }
    };

    if cfg!(windows) {
        let existing = builder
            .get_env("Path")
            .or_else(|| builder.get_env("PATH"))
            .map(|value| value.to_string_lossy().to_string())
            .unwrap_or_default();
        let mut combined = existing;
        for extra in agent_search_dirs() {
            let extra = extra.to_string_lossy().to_string();
            if !combined
                .split(';')
                .any(|part| part.eq_ignore_ascii_case(&extra))
            {
                if !combined.is_empty() && !combined.ends_with(';') {
                    combined.push(';');
                }
                combined.push_str(&extra);
            }
        }
        builder.env("Path", combined);
    }
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");

    if trimmed == Some("opencode") {
        builder.env("OPENTUI_FORCE_EXPLICIT_WIDTH", "false");
    }
    scrub_editor_environment(&mut builder);
    builder.env_remove("EDITOR");
    builder.env_remove("VISUAL");
    builder.env_remove("CLAUDECODE");
    builder.env_remove("CLAUDE_CODE_ENTRYPOINT");
    builder.env_remove("CLAUDECODE_PARENT_PID");
    // Flashwork is often launched via `npm run`, which injects npm_config_prefix
    // pointing at the app package. nvm then refuses to start in the PTY.
    builder.env_remove("npm_config_prefix");
    builder.env_remove("npm_config_global_prefix");
    builder.env_remove("NPM_CONFIG_PREFIX");
    builder.env_remove("NPM_CONFIG_GLOBAL_PREFIX");
    builder
}

///

#[tauri::command]
pub async fn find_cli_launcher(agent: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        find_windows_cli_launcher(&agent).map(|p| p.to_string_lossy().to_string())
    })
    .await
    .unwrap_or(None)
}

/// After a successful install: drop any cached hit (the old binary may still exist —
/// that is the shadowing case), probe the user's login PATH, then resolve again.
#[tauri::command]
pub async fn refresh_cli_path(command: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        invalidate_launcher_cache(&command);
        let resolved = resolve_cli_launcher_refreshed(&command)?;
        cache_launcher(&command, resolved.clone());
        Some(resolved.to_string_lossy().to_string())
    })
    .await
    .unwrap_or(None)
}

static LAUNCHER_CACHE: OnceLock<std::sync::Mutex<HashMap<String, PathBuf>>> = OnceLock::new();

fn launcher_cache() -> &'static std::sync::Mutex<HashMap<String, PathBuf>> {
    LAUNCHER_CACHE.get_or_init(|| std::sync::Mutex::new(HashMap::new()))
}

fn cache_launcher(command: &str, path: PathBuf) {
    if let Ok(mut map) = launcher_cache().lock() {
        map.insert(command.to_string(), path);
    }
}

fn invalidate_launcher_cache(command: &str) {
    if let Ok(mut map) = launcher_cache().lock() {
        map.remove(command);
    }
}

#[cfg(test)]
fn launcher_cache_get(command: &str) -> Option<PathBuf> {
    launcher_cache().lock().ok()?.get(command).cloned()
}

/// Binary names to try when resolving `command`. Gemini ships as either `gemini`
/// or `gemini-cli`; every other agent keeps a single name.
pub(crate) fn cli_name_aliases(command: &str) -> Vec<&str> {
    match command {
        "gemini" => vec!["gemini", "gemini-cli"],
        "gemini-cli" => vec!["gemini-cli", "gemini"],
        other => vec![other],
    }
}

/// Well-known extra directories for Node-installed CLIs (nvm, fnm, npm global).
/// The nvm entry is the glob pattern `…/.nvm/versions/node/*/bin`.
/// Paths are constructed from `home` and optional `app_data` (`%APPDATA%`)
/// and need not exist on disk.
pub(crate) fn extra_cli_search_dir_candidates(
    home: &Path,
    app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut dirs = vec![
        home.join(".nvm")
            .join("versions")
            .join("node")
            .join("*")
            .join("bin"),
        home.join(".fnm").join("aliases").join("default").join("bin"),
        home.join(".local")
            .join("share")
            .join("fnm")
            .join("aliases")
            .join("default")
            .join("bin"),
        home.join(".npm-global").join("bin"),
    ];
    if let Some(app_data) = app_data {
        dirs.push(app_data.join("npm"));
    } else {
        dirs.push(home.join("AppData").join("Roaming").join("npm"));
    }
    dirs
}

/// Runtime extra dirs for launcher lookup only (not Windows PTY Path injection).
/// nvm glob expanded, extra fnm homes, well-known npm-global, and a cached
/// `npm prefix -g` that is killed on timeout. Parent `npm_config_prefix` is
/// ignored — it points at the Flashwork package when launched via `npm run`.
fn extra_cli_search_dirs() -> Vec<PathBuf> {
    let home = env::var_os("HOME")
        .or_else(|| env::var_os("USERPROFILE"))
        .map(PathBuf::from);
    let app_data = env::var_os("APPDATA").map(PathBuf::from);
    let mut dirs = Vec::new();

    if let Some(home) = home.as_ref() {
        dirs.extend(extra_node_manager_dirs(home, app_data.as_deref()));
    } else if let Some(app_data) = app_data.as_ref() {
        dirs.push(app_data.join("npm"));
    }

    dirs.extend(fnm_version_dirs());
    if let Some(prefix) = npm_prefix_global_cached() {
        dirs.push(prefix.join("bin"));
        dirs.push(prefix);
    }
    dedupe_paths(dirs)
}

/// Extra nvm/fnm/npm-global dirs derived from `home`. Used by tests so expansion
/// can be checked without spawning npm or mutating process env.
pub(crate) fn extra_node_manager_dirs(home: &Path, app_data: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = nvm_node_bin_dirs(home);
    for candidate in extra_cli_search_dir_candidates(home, app_data) {
        if is_nvm_versions_glob(&candidate) {
            continue;
        }
        dirs.push(candidate);
    }
    dirs.extend(fnm_installations_in(&home.join(".fnm")));
    dirs.extend(fnm_installations_in(
        &home.join(".local").join("share").join("fnm"),
    ));
    dirs
}

fn is_nvm_versions_glob(path: &Path) -> bool {
    path.file_name().is_some_and(|name| name == "bin")
        && path
            .parent()
            .and_then(|parent| parent.file_name())
            .is_some_and(|name| name == "*")
}

pub(crate) fn nvm_node_bin_dirs(home: &Path) -> Vec<PathBuf> {
    let versions = home.join(".nvm").join("versions").join("node");
    let Ok(entries) = fs::read_dir(&versions) else {
        return Vec::new();
    };
    let mut dirs: Vec<(PathBuf, SystemTime)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let bin = entry.path().join("bin");
            if !bin.is_dir() {
                return None;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).ok()?;
            Some((bin, modified))
        })
        .collect();
    dirs.sort_by(|a, b| b.1.cmp(&a.1));
    dirs.into_iter().map(|(path, _)| path).collect()
}

/// `None` = not yet known (including after a timeout). `Some(None)` = npm missing.
/// `Some(Some(path))` = hit. Timeouts must not freeze a miss for the process lifetime.
static NPM_PREFIX_CACHE: OnceLock<std::sync::Mutex<Option<Option<PathBuf>>>> = OnceLock::new();

fn npm_prefix_cache() -> &'static std::sync::Mutex<Option<Option<PathBuf>>> {
    NPM_PREFIX_CACHE.get_or_init(|| std::sync::Mutex::new(None))
}

enum NpmPrefixResult {
    Found(PathBuf),
    Missing,
    TimedOut,
}

fn npm_prefix_global_cached() -> Option<PathBuf> {
    if cfg!(test) {
        return None;
    }
    if let Ok(guard) = npm_prefix_cache().lock() {
        if let Some(cached) = guard.as_ref() {
            return cached.clone();
        }
    }
    match probe_npm_prefix_global(Duration::from_secs(1)) {
        NpmPrefixResult::Found(path) => {
            if let Ok(mut guard) = npm_prefix_cache().lock() {
                *guard = Some(Some(path.clone()));
            }
            Some(path)
        }
        NpmPrefixResult::Missing => {
            if let Ok(mut guard) = npm_prefix_cache().lock() {
                *guard = Some(None);
            }
            None
        }
        NpmPrefixResult::TimedOut => None,
    }
}

/// Time-boxed `npm prefix -g`. The child is killed on timeout so it cannot leak.
/// `npm_config_prefix` injected by `npm run` is stripped in the child so the
/// result is the user's global prefix, not the Flashwork package.
fn probe_npm_prefix_global(timeout: Duration) -> NpmPrefixResult {
    let mut cmd = std::process::Command::new("npm");
    cmd.args(["prefix", "-g"]);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::null());
    cmd.env_remove("npm_config_prefix");
    cmd.env_remove("npm_config_global_prefix");
    cmd.env_remove("NPM_CONFIG_PREFIX");
    cmd.env_remove("NPM_CONFIG_GLOBAL_PREFIX");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(_) => return NpmPrefixResult::Missing,
    };
    let mut stdout = match child.stdout.take() {
        Some(stdout) => stdout,
        None => {
            let _ = child.kill();
            let _ = child.wait();
            return NpmPrefixResult::Missing;
        }
    };

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return read_npm_prefix_output(status, &mut stdout),
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return NpmPrefixResult::TimedOut;
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => {
                let _ = child.kill();
                let _ = child.wait();
                return NpmPrefixResult::Missing;
            }
        }
    }
}

fn read_npm_prefix_output(
    status: std::process::ExitStatus,
    stdout: &mut impl Read,
) -> NpmPrefixResult {
    if !status.success() {
        return NpmPrefixResult::Missing;
    }
    let mut buf = Vec::new();
    if stdout.read_to_end(&mut buf).is_err() {
        return NpmPrefixResult::Missing;
    }
    let prefix = String::from_utf8_lossy(&buf);
    let prefix = prefix.trim();
    if prefix.is_empty() {
        NpmPrefixResult::Missing
    } else {
        NpmPrefixResult::Found(PathBuf::from(prefix))
    }
}

/// Resolving a launcher walks every PATH entry and every agent directory looking for four
/// extensions, and it runs on every terminal boot. Only hits are cached, and a hit is dropped as
/// soon as its file is gone — so installing an agent is picked up at once and uninstalling it is
/// noticed on the next lookup, without the cache ever answering for something that is not there.
pub fn find_windows_cli_launcher(command: &str) -> Option<PathBuf> {
    let cache = launcher_cache();

    if let Ok(map) = cache.lock() {
        if let Some(path) = map.get(command) {
            if path.is_file() {
                return Some(path.clone());
            }
        }
    }

    let resolved = resolve_cli_launcher(command)?;
    cache_launcher(command, resolved.clone());
    Some(resolved)
}

fn resolve_cli_launcher(command: &str) -> Option<PathBuf> {
    let aliases = cli_name_aliases(command);

    #[cfg(not(windows))]
    {
        for alias in &aliases {
            if let Ok(path) = which::which(alias) {
                return Some(path);
            }
        }
        let mut dirs = Vec::<PathBuf>::new();
        if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
            dirs.push(home.join(".local").join("bin"));
            dirs.push(home.join(".cargo").join("bin"));
        }
        // A .app launched from Finder inherits Launch Services' minimal PATH
        // (no .zshrc/.zprofile), so Homebrew CLIs are invisible to `which`
        // even when they exist on disk. Cover the default prefixes as a
        // fixed fallback.
        dirs.extend(homebrew_dirs());
        dirs.extend(extra_cli_search_dirs());
        for alias in &aliases {
            for dir in &dirs {
                let candidate = dir.join(alias);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        return None;
    }

    #[cfg(windows)]
    {
        let mut dirs = Vec::<PathBuf>::new();
        dirs.extend(split_windows_path_expanded(&rebuilt_path()));
        dirs.extend(agent_search_dirs());
        dirs.extend(extra_cli_search_dirs());
        for alias in &aliases {
            if let Some(path) = search_windows_cli(alias, &dirs) {
                return Some(path);
            }
        }
        None
    }
}

/// Login-shell probe plus a fresh PATH walk. Used only after install — not on
/// every terminal boot, because spawning bash/pwsh is relatively expensive.
fn resolve_cli_launcher_refreshed(command: &str) -> Option<PathBuf> {
    for alias in cli_name_aliases(command) {
        if let Some(path) = probe_login_shell_command(alias) {
            return Some(path);
        }
    }
    #[cfg(windows)]
    {
        let mut dirs = Vec::<PathBuf>::new();
        // Re-read the registry PATH; the installer may have just added
        // `%USERPROFILE%\.local\bin`. `rebuilt_path()` is cached for the
        // process lifetime and would still be stale here.
        dirs.extend(split_windows_path_expanded(&build_rebuilt_path()));
        dirs.extend(agent_search_dirs());
        dirs.extend(extra_cli_search_dirs());
        for alias in cli_name_aliases(command) {
            if let Some(path) = search_windows_cli(alias, &dirs) {
                return Some(path);
            }
        }
        return None;
    }
    #[cfg(not(windows))]
    {
        resolve_cli_launcher(command)
    }
}

#[cfg(windows)]
fn search_windows_cli(command: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    // Antigravity's CLI binary is exclusively `agy`. Never fall back to the desktop app.
    let candidates_to_try = match command {
        "antigravity" | "agy" => vec!["agy"],
        other => vec![other],
    };

    for cmd_name in candidates_to_try {
        for dir in dirs {
            for extension in ["cmd", "exe", "bat", "ps1"] {
                let candidate = dir.join(format!("{cmd_name}.{extension}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn is_safe_cli_name(command: &str) -> bool {
    !command.is_empty()
        && command.len() <= 64
        && command
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
}

/// First non-empty line of `command -v` / `Get-Command` stdout, if it looks like a path.
pub(crate) fn parse_which_output(stdout: &str) -> Option<PathBuf> {
    let line = stdout.lines().map(str::trim).find(|l| !l.is_empty())?;
    if line.contains(char::is_whitespace) {
        return None;
    }
    Some(PathBuf::from(line))
}

/// Expensive login-shell lookup. Post-install only — not used on terminal boot.
fn probe_login_shell_command(command: &str) -> Option<PathBuf> {
    if !is_safe_cli_name(command) {
        return None;
    }

    #[cfg(windows)]
    {
        let shell = default_shell();
        let script = format!(
            "(Get-Command -Name {command} -ErrorAction SilentlyContinue | Select-Object -First 1).Source"
        );
        let mut proc = std::process::Command::new(&shell);
        proc.args(["-NoLogo", "-NoProfile", "-Command", &script]);
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            proc.creation_flags(CREATE_NO_WINDOW);
        }
        let output = proc.output().ok()?;
        parse_which_output(&String::from_utf8_lossy(&output.stdout)).filter(|p| p.is_file())
    }

    #[cfg(not(windows))]
    {
        let output = std::process::Command::new("bash")
            .args(["-lc", &format!("command -v {command}")])
            .output()
            .ok()?;
        parse_which_output(&String::from_utf8_lossy(&output.stdout)).filter(|p| p.is_file())
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct InstallToolchain {
    pub node: Option<String>,
    pub npm: bool,
    pub winget: bool,
    pub scoop: bool,
    pub choco: bool,
    pub bun: bool,
    pub pnpm: bool,
    #[serde(default)]
    pub brew: bool,
    #[serde(default = "toolchain_os")]
    pub os: String,
}

impl Default for InstallToolchain {
    fn default() -> Self {
        Self {
            node: None,
            npm: false,
            winget: false,
            scoop: false,
            choco: false,
            bun: false,
            pnpm: false,
            brew: false,
            os: toolchain_os(),
        }
    }
}

/// Maps `std::env::consts::OS` onto the three families the install catalog uses.
fn map_toolchain_os(os: &str) -> String {
    match os {
        "macos" => "macos".to_string(),
        "windows" => "windows".to_string(),
        _ => "linux".to_string(),
    }
}

fn toolchain_os() -> String {
    map_toolchain_os(std::env::consts::OS)
}

fn node_version() -> Option<String> {
    let node = find_windows_cli_launcher("node")?;
    let output = std::process::Command::new(node)
        .arg("--version")
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!version.is_empty()).then_some(version)
}

/// Extracts the first dotted version out of `--version` output. Agents are not consistent here:
/// some print a bare `1.2.3`, others `codex-cli 1.2.3 (abc1234)` or a banner line first.
fn parse_version(raw: &str) -> Option<String> {
    raw.split(|c: char| !(c.is_ascii_digit() || c == '.'))
        .find(|token| token.contains('.') && token.starts_with(|c: char| c.is_ascii_digit()))
        .map(|token| token.trim_end_matches('.').to_string())
}

/// Flags tried in order. The agents disagree on this, and none of them documents it, so the probe
/// asks rather than assumes. Output is read from stdout and stderr because some print to stderr.
const VERSION_FLAGS: [&str; 3] = ["--version", "-v", "version"];

/// Version the agent's CLI reports, or `None` when it is missing or answers nothing usable.
#[tauri::command]
pub async fn agent_cli_version(agent: String) -> Option<String> {
    tokio::task::spawn_blocking(move || {
        let bin = find_windows_cli_launcher(&agent)?;
        for flag in VERSION_FLAGS {
            let mut command = std::process::Command::new(&bin);
            command.arg(flag);
            #[cfg(windows)]
            {
                use std::os::windows::process::CommandExt;
                const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                command.creation_flags(CREATE_NO_WINDOW);
            }
            let Ok(output) = command.output() else {
                continue;
            };
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Some(version) = parse_version(&stdout) {
                return Some(version);
            }
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let Some(version) = parse_version(&stderr) {
                return Some(version);
            }
        }
        None
    })
    .await
    .unwrap_or(None)
}

/// Reports which installers are usable on this machine so the UI can offer the
/// agent install methods that will actually work here.
#[tauri::command]
pub async fn probe_install_toolchain() -> InstallToolchain {
    tokio::task::spawn_blocking(|| {
        let has = |name: &str| find_windows_cli_launcher(name).is_some();
        InstallToolchain {
            node: node_version(),
            npm: has("npm"),
            winget: has("winget"),
            scoop: has("scoop"),
            choco: has("choco"),
            bun: has("bun"),
            pnpm: has("pnpm"),
            brew: has("brew"),
            os: toolchain_os(),
        }
    })
    .await
    .unwrap_or_default()
}

/// Default Homebrew prefixes on macOS (Apple Silicon uses `/opt/homebrew`, Intel
/// uses `/usr/local`). Fixed fallback — it does not rely on the login shell having
/// run `brew shellenv` in the session of the process that launched the app.
#[cfg(not(windows))]
fn homebrew_dirs() -> Vec<PathBuf> {
    vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/opt/homebrew/sbin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/local/sbin"),
    ]
}

/// Looks for the VS Code launcher (`code`) in common locations plus PATH.
/// Returns the first one that exists.
pub fn find_vscode_launcher() -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        which::which("code").ok()
    }

    #[cfg(windows)]
    {
        let root_candidates = ["Code.exe", "Code - Insiders.exe"];
        let path_candidates = [
            "code.exe",
            "code-insiders.exe",
            "code.cmd",
            "code-insiders.cmd",
        ];
        let mut dirs: Vec<PathBuf> = Vec::new();
        if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            dirs.push(local.join("Programs").join("Microsoft VS Code").join("bin"));
            dirs.push(
                local
                    .join("Programs")
                    .join("Microsoft VS Code Insiders")
                    .join("bin"),
            );
        }
        if let Some(pf) = env::var_os("ProgramFiles").map(PathBuf::from) {
            dirs.push(pf.join("Microsoft VS Code").join("bin"));
            dirs.push(pf.join("Microsoft VS Code Insiders").join("bin"));
        }
        if let Some(pf86) = env::var_os("ProgramFiles(x86)").map(PathBuf::from) {
            dirs.push(pf86.join("Microsoft VS Code").join("bin"));
        }

        for app_dir in dirs.iter().filter_map(|dir| dir.parent()) {
            for name in root_candidates {
                let candidate = app_dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }

        dirs.splice(0..0, split_windows_path_expanded(&rebuilt_path()));
        for dir in dirs {
            for name in path_candidates {
                let candidate = dir.join(name);
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
        None
    }
}

pub fn agent_search_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::<PathBuf>::new();
    if let Some(profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
        dirs.push(profile.join("AppData").join("Roaming").join("npm"));
        dirs.push(profile.join(".local").join("bin"));
        dirs.push(profile.join(".cargo").join("bin"));
        dirs.push(profile.join(".bun").join("bin"));
        dirs.push(profile.join("scoop").join("shims"));
        dirs.push(
            profile
                .join("AppData")
                .join("Local")
                .join("agy")
                .join("bin"),
        );
        dirs.push(
            profile
                .join("AppData")
                .join("Local")
                .join("antigravity")
                .join("bin"),
        );
    }
    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        dirs.push(app_data.join("npm"));
    }
    dirs.extend(volta_bin_dirs());
    dirs.extend(pnpm_bin_dirs());
    dirs.extend(fnm_version_dirs());
    if let Some(global) = env::var_os("SCOOP_GLOBAL").map(PathBuf::from) {
        dirs.push(global.join("shims"));
    } else {
        dirs.push(PathBuf::from(r"C:\ProgramData\scoop\shims"));
    }
    dirs.push(PathBuf::from(r"C:\ProgramData\chocolatey\bin"));
    dirs.extend(nvm_windows_version_dirs());
    dirs.push(PathBuf::from(r"C:\nvm4w\nodejs"));
    dirs.push(PathBuf::from(r"C:\Program Files\nodejs"));
    dirs.push(PathBuf::from(r"C:\Program Files (x86)\nodejs"));
    dirs
}

pub fn volta_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(volta_home) = env::var_os("VOLTA_HOME").map(PathBuf::from) {
        dirs.push(volta_home.join("bin"));
    }
    if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(local.join("Volta").join("bin"));
    }
    dirs
}

pub fn pnpm_bin_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(pnpm_home) = env::var_os("PNPM_HOME").map(PathBuf::from) {
        dirs.push(pnpm_home);
    }
    if let Some(local) = env::var_os("LOCALAPPDATA").map(PathBuf::from) {
        dirs.push(local.join("pnpm"));
    }
    dirs
}

pub fn fnm_version_dirs() -> Vec<PathBuf> {
    // PATH injection for Windows PTYs: FNM_DIR or %LOCALAPPDATA%\fnm only.
    // Extra Unix homes belong in extra_cli_search_dirs (launcher lookup).
    let fnm_root = env::var_os("FNM_DIR")
        .map(PathBuf::from)
        .or_else(|| env::var_os("LOCALAPPDATA").map(|p| PathBuf::from(p).join("fnm")));
    let Some(root) = fnm_root else {
        return Vec::new();
    };
    fnm_installations_in(&root)
}

fn fnm_installations_in(root: &Path) -> Vec<PathBuf> {
    let versions_dir = root.join("node-versions");
    let Ok(entries) = fs::read_dir(&versions_dir) else {
        return Vec::new();
    };
    let mut versions: Vec<(PathBuf, SystemTime)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !name.starts_with('v') {
                return None;
            }
            let install = path.join("installation");
            if !install.is_dir() {
                return None;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).ok()?;
            Some((install, modified))
        })
        .collect();
    versions.sort_by(|a, b| b.1.cmp(&a.1));
    versions.into_iter().map(|(path, _)| path).collect()
}

pub fn nvm_windows_version_dirs() -> Vec<PathBuf> {
    let Some(nvm_home) = env::var_os("NVM_HOME").map(PathBuf::from) else {
        return Vec::new();
    };
    let Ok(entries) = fs::read_dir(&nvm_home) else {
        return Vec::new();
    };
    let mut versions: Vec<(PathBuf, SystemTime)> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_name()?.to_str()?.to_string();
            if !name.starts_with('v') {
                return None;
            }
            let modified = entry.metadata().and_then(|m| m.modified()).ok()?;
            if !path.is_dir() {
                return None;
            }
            Some((path, modified))
        })
        .collect();
    versions.sort_by(|a, b| b.1.cmp(&a.1));
    versions.into_iter().map(|(path, _)| path).collect()
}

fn scrub_editor_environment(builder: &mut CommandBuilder) {
    for key in [
        "TERM_PROGRAM",
        "TERM_PROGRAM_VERSION",
        "VSCODE_CWD",
        "VSCODE_IPC_HOOK",
        "VSCODE_IPC_HOOK_CLI",
        "VSCODE_GIT_ASKPASS_NODE",
        "VSCODE_GIT_ASKPASS_EXTRA_ARGS",
        "VSCODE_GIT_ASKPASS_MAIN",
        "VSCODE_GIT_IPC_HANDLE",
        "GIT_ASKPASS",
        "ELECTRON_RUN_AS_NODE",
        "npm_config_prefix",
        "npm_config_global_prefix",
        "NPM_CONFIG_PREFIX",
        "NPM_CONFIG_GLOBAL_PREFIX",
    ] {
        builder.env_remove(key);
    }
}

pub fn rebuilt_path() -> String {
    REBUILT_PATH.get_or_init(build_rebuilt_path).clone()
}

pub(crate) fn build_rebuilt_path() -> String {
    if !cfg!(windows) {
        let mut paths: Vec<PathBuf> = env::var_os("PATH")
            .map(|value| env::split_paths(&value).collect())
            .unwrap_or_default();
        #[cfg(not(windows))]
        paths.extend(homebrew_dirs());
        return dedupe_paths(paths)
            .into_iter()
            .map(|path| path.to_string_lossy().to_string())
            .collect::<Vec<_>>()
            .join(":");
    }

    let mut paths = Vec::<PathBuf>::new();

    #[cfg(windows)]
    {
        let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
        if let Ok(env_key) =
            hklm.open_subkey("SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment")
        {
            if let Ok(path) = env_key.get_value::<String, _>("Path") {
                paths.extend(split_windows_path_expanded(&path));
            }
        }

        let hkcu = RegKey::predef(HKEY_CURRENT_USER);
        if let Ok(env_key) = hkcu.open_subkey("Environment") {
            if let Ok(path) = env_key.get_value::<String, _>("Path") {
                paths.extend(split_windows_path_expanded(&path));
            }
        }
    }

    if let Some(current_path) = env::var_os("PATH") {
        paths.extend(env::split_paths(&current_path));
    }

    if let Some(user_profile) = env::var_os("USERPROFILE").map(PathBuf::from) {
        paths.push(user_profile.join("AppData").join("Roaming").join("npm"));
        paths.push(user_profile.join(".local").join("bin"));
        paths.push(user_profile.join(".cargo").join("bin"));
        paths.push(user_profile.join(".bun").join("bin"));
    }

    if let Some(app_data) = env::var_os("APPDATA").map(PathBuf::from) {
        paths.push(app_data.join("npm"));
    }

    paths.push(PathBuf::from(r"C:\nvm4w\nodejs"));
    paths.push(PathBuf::from(r"C:\Program Files\nodejs"));
    paths.push(PathBuf::from(r"C:\Program Files (x86)\nodejs"));

    dedupe_paths(paths)
        .into_iter()
        .map(|path| path.to_string_lossy().to_string())
        .collect::<Vec<_>>()
        .join(";")
}

#[allow(dead_code)]
fn split_windows_path_expanded(path: &str) -> Vec<PathBuf> {
    path.split(';')
        .filter_map(|item| {
            let item = expand_windows_env_vars(item.trim());
            if item.is_empty() {
                None
            } else {
                Some(PathBuf::from(item))
            }
        })
        .collect()
}

#[allow(dead_code)]
fn expand_windows_env_vars(input: &str) -> String {
    let mut output = input.to_string();
    for (key, value) in env::vars() {
        output = output.replace(&format!("%{key}%"), &value);
        output = output.replace(&format!("%{}%", key.to_ascii_uppercase()), &value);
    }
    output
}

fn dedupe_paths(paths: Vec<PathBuf>) -> Vec<PathBuf> {
    let mut result = Vec::<PathBuf>::new();

    for path in paths {
        let path_string = path.to_string_lossy().to_string();
        if path_string.trim().is_empty() {
            continue;
        }
        if result.iter().any(|existing| {
            existing
                .to_string_lossy()
                .eq_ignore_ascii_case(&path_string)
        }) {
            continue;
        }
        result.push(path);
    }

    result
}

#[derive(serde::Serialize, serde::Deserialize, Debug, Clone)]
pub struct ModelOption {
    pub id: String,
    pub label: String,
}

fn is_valid_model_id(id: &str) -> bool {
    let id_lower = id.to_lowercase();
    if id.is_empty()
        || id.starts_with('-')
        || id.starts_with('#')
        || id_lower.starts_with("usage")
        || id_lower.starts_with("could")
        || id_lower.starts_with("error")
        || id_lower.starts_with("failed")
        || id_lower.starts_with("let")
        || id_lower.starts_with("flags")
        || id_lower.starts_with("available")
        || id.contains(' ')
        || id.len() < 3
    {
        return false;
    }
    true
}

fn discover_provider_models_inner(provider: String) -> Result<Vec<ModelOption>, String> {
    let mut models = Vec::new();
    let provider_lower = provider.to_lowercase();

    let cmd_name = match provider_lower.as_str() {
        "antigravity" | "agy" => "agy",
        other => other,
    };

    let bin_path = find_windows_cli_launcher(cmd_name)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| cmd_name.to_string());

    match provider_lower.as_str() {
        "antigravity" | "agy" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Antigravity agy)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "gemini-2.5-pro".into(),
                    label: "Gemini 2.5 Pro (Google DeepMind)".into(),
                });
                models.push(ModelOption {
                    id: "gemini-2.5-flash".into(),
                    label: "Gemini 2.5 Flash (Google DeepMind)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3.7-sonnet".into(),
                    label: "Claude 3.7 Sonnet (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "deepseek-r1".into(),
                    label: "DeepSeek R1 (Reasoning)".into(),
                });
            }
        }
        "opencode" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (OpenCode CLI)"),
                            id,
                        });
                    }
                }
            }
        }
        "claude" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Claude CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "claude-3-7-sonnet".into(),
                    label: "Claude 3.7 Sonnet (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3-5-sonnet".into(),
                    label: "Claude 3.5 Sonnet (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3-5-haiku".into(),
                    label: "Claude 3.5 Haiku (Anthropic)".into(),
                });
                models.push(ModelOption {
                    id: "claude-3-opus".into(),
                    label: "Claude 3 Opus (Anthropic)".into(),
                });
            }
        }
        "codex" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Codex CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "gpt-4o".into(),
                    label: "GPT-4o (OpenAI)".into(),
                });
                models.push(ModelOption {
                    id: "o3-mini".into(),
                    label: "o3-mini (Raciocínio OpenAI)".into(),
                });
                models.push(ModelOption {
                    id: "o1".into(),
                    label: "o1 (OpenAI)".into(),
                });
                models.push(ModelOption {
                    id: "gpt-4o-mini".into(),
                    label: "GPT-4o mini (OpenAI)".into(),
                });
            }
        }
        "mimo" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Mimo CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "mimo-v1-pro".into(),
                    label: "Mimo V1 Pro (Xiaomi AI)".into(),
                });
                models.push(ModelOption {
                    id: "mimo-v1-flash".into(),
                    label: "Mimo V1 Flash (Xiaomi AI)".into(),
                });
            }
        }
        "freebuff" => {
            if let Ok(output) = std::process::Command::new(&bin_path).arg("models").output() {
                let stdout = String::from_utf8_lossy(&output.stdout);
                for line in stdout.lines() {
                    let trimmed = line.trim();
                    let id = trimmed
                        .split_whitespace()
                        .next()
                        .unwrap_or(trimmed)
                        .to_string();
                    if is_valid_model_id(&id) {
                        models.push(ModelOption {
                            label: format!("{id} (Freebuff CLI)"),
                            id,
                        });
                    }
                }
            }
            if models.is_empty() {
                models.push(ModelOption {
                    id: "freebuff-auto".into(),
                    label: "Freebuff Auto-Router".into(),
                });
                models.push(ModelOption {
                    id: "freebuff-fast".into(),
                    label: "Freebuff Fast".into(),
                });
            }
        }
        "gemini" => {
            models.push(ModelOption {
                id: "gemini-2.5-pro".into(),
                label: "Gemini 2.5 Pro".into(),
            });
            models.push(ModelOption {
                id: "gemini-2.5-flash".into(),
                label: "Gemini 2.5 Flash".into(),
            });
            models.push(ModelOption {
                id: "gemini-2.0-flash".into(),
                label: "Gemini 2.0 Flash".into(),
            });
        }
        _ => {}
    }

    Ok(models)
}

/// `discover_provider_models_inner` roda `std::process::Command::output()`

/// `find_cli_launcher` acima.
#[tauri::command]
pub async fn discover_provider_models(provider: String) -> Result<Vec<ModelOption>, String> {
    tokio::task::spawn_blocking(move || discover_provider_models_inner(provider))
        .await
        .map_err(|error| format!("discover_provider_models: falha na task bloqueante: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    #[test]
    fn accepts_model_ids_and_rejects_cli_prose() {
        for id in ["claude-sonnet-4-5", "gpt-5", "o3-mini", "model-error-free"] {
            assert!(is_valid_model_id(id), "expected valid model id: {id}");
        }

        for id in [
            "",
            "ab",
            "--help",
            "# comment",
            "gpt 5",
            "usage: claude [options]",
            "Usage: claude [options]",
            "could not find model",
            "ERROR: invalid model",
            "failed to list models",
            "let me explain",
            "flags: --json",
            "available models:",
        ] {
            assert!(!is_valid_model_id(id), "expected invalid model id: {id}");
        }
    }

    #[test]
    fn dedupe_paths_drops_empty_values_and_keeps_first_spelling() {
        let paths = dedupe_paths(vec![
            PathBuf::from("  "),
            PathBuf::from(r"C:\Bin"),
            PathBuf::from(r"c:\bin"),
            PathBuf::from(r"D:\Tools"),
            PathBuf::from(""),
        ]);

        assert_eq!(
            paths,
            vec![PathBuf::from(r"C:\Bin"), PathBuf::from(r"D:\Tools")]
        );
    }

    #[cfg(windows)]
    #[test]
    fn expands_windows_environment_variables_case_insensitively() {
        std::env::set_var("flashwork_test_path", r"C:\Tools");

        assert_eq!(
            expand_windows_env_vars(r"%FLASHWORK_TEST_PATH%\bin;%flashwork_test_path%"),
            r"C:\Tools\bin;C:\Tools"
        );
        assert_eq!(expand_windows_env_vars(r"%NOPE%"), r"%NOPE%");

        std::env::remove_var("flashwork_test_path");
    }

    #[cfg(windows)]
    #[test]
    fn splits_expanded_windows_paths_and_drops_empty_segments() {
        assert_eq!(
            split_windows_path_expanded(r"a;; b ;"),
            vec![PathBuf::from("a"), PathBuf::from("b")]
        );
    }

    #[cfg(not(windows))]
    #[test]
    fn resolves_cli_launcher_on_unix() {
        assert!(find_windows_cli_launcher("sh").is_some());
        assert!(find_windows_cli_launcher("non_existent_binary_xyz_123").is_none());
    }

    #[test]
    fn map_toolchain_os_maps_known_families() {
        assert_eq!(map_toolchain_os("macos"), "macos");
        assert_eq!(map_toolchain_os("windows"), "windows");
        assert_eq!(map_toolchain_os("linux"), "linux");
        assert_eq!(map_toolchain_os("freebsd"), "linux");
    }

    #[test]
    fn omitted_brew_deserializes_to_false() {
        let parsed: InstallToolchain = serde_json::from_str(
            r#"{"node":null,"npm":false,"winget":false,"scoop":false,"choco":false,"bun":false,"pnpm":false}"#,
        )
        .expect("probe JSON without brew");
        assert!(!parsed.brew);
        assert_eq!(parsed.os, toolchain_os());
    }

    #[test]
    fn interactive_shell_names_are_detected() {
        assert!(is_interactive_shell_name("pwsh"));
        assert!(is_interactive_shell_name("pwsh.exe"));
        assert!(is_interactive_shell_name("/usr/bin/bash"));
        assert!(is_interactive_shell_name("/usr/bin/zsh"));
        assert!(!is_interactive_shell_name("claude"));
        assert!(!is_interactive_shell_name("npm"));
    }

    #[test]
    fn safe_cli_names_reject_shell_metacharacters() {
        assert!(is_safe_cli_name("claude"));
        assert!(is_safe_cli_name("agy"));
        assert!(is_safe_cli_name("gemini-cli"));
        assert!(!is_safe_cli_name(""));
        assert!(!is_safe_cli_name("claude; rm -rf /"));
        assert!(!is_safe_cli_name("$(evil)"));
        assert!(!is_safe_cli_name("claude | iex"));
    }

    #[test]
    fn parse_which_output_takes_the_first_path_line() {
        assert_eq!(
            parse_which_output("  /home/u/.local/bin/claude\n"),
            Some(PathBuf::from("/home/u/.local/bin/claude"))
        );
        assert_eq!(parse_which_output(""), None);
        assert_eq!(parse_which_output("claude () {\n  true\n}\n"), None);
    }

    #[test]
    fn invalidate_launcher_cache_drops_entry_even_if_the_file_still_exists() {
        let path = PathBuf::from("/tmp/flashwork-stale-cli-that-need-not-exist");
        cache_launcher("flashwork-test-cli", path.clone());
        assert_eq!(launcher_cache_get("flashwork-test-cli"), Some(path));
        invalidate_launcher_cache("flashwork-test-cli");
        assert_eq!(launcher_cache_get("flashwork-test-cli"), None);
    }

    #[test]
    fn cli_name_aliases_gemini_includes_gemini_cli() {
        assert_eq!(cli_name_aliases("gemini"), vec!["gemini", "gemini-cli"]);
    }

    #[test]
    fn cli_name_aliases_gemini_cli_puts_asked_name_first() {
        assert_eq!(
            cli_name_aliases("gemini-cli"),
            vec!["gemini-cli", "gemini"]
        );
    }

    #[test]
    fn cli_name_aliases_other_commands_stay_unaliased() {
        assert_eq!(cli_name_aliases("copilot"), vec!["copilot"]);
        assert_eq!(cli_name_aliases("claude"), vec!["claude"]);
        assert_eq!(cli_name_aliases("agy"), vec!["agy"]);
    }

    fn rendered_extra_dirs(home: &std::path::Path, app_data: Option<&std::path::Path>) -> Vec<String> {
        extra_cli_search_dir_candidates(home, app_data)
            .into_iter()
            .map(|d| d.to_string_lossy().replace('\\', "/"))
            .collect()
    }

    #[test]
    fn extra_cli_search_dir_candidates_include_nvm_fnm_and_appdata_npm() {
        let home = PathBuf::from("/home/tester");
        let app_data = PathBuf::from("/home/tester/AppData/Roaming");
        let dirs = rendered_extra_dirs(&home, Some(&app_data));

        assert!(
            dirs.iter()
                .any(|d| d.ends_with("/.nvm/versions/node/*/bin")),
            "expected nvm glob bin path, got {dirs:?}"
        );
        assert!(
            dirs.iter()
                .any(|d| d.ends_with("/.fnm/aliases/default/bin")),
            "expected fnm default alias bin, got {dirs:?}"
        );
        assert!(
            dirs.iter().any(|d| d.ends_with("/AppData/Roaming/npm")),
            "expected APPDATA npm, got {dirs:?}"
        );
        assert!(
            dirs.iter().any(|d| d.ends_with("/.npm-global/bin")),
            "expected well-known npm-global bin, got {dirs:?}"
        );
    }

    #[test]
    fn nvm_node_bin_dirs_expands_existing_bins_and_skips_star_path() {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let home = std::env::temp_dir().join(format!(
            "flashwork-nvm-glob-{}-{}",
            std::process::id(),
            nanos
        ));
        let _guard = DeleteDirOnDrop(home.clone());

        let node = home.join(".nvm").join("versions").join("node");
        fs::create_dir_all(node.join("v18")).expect("v18 dir without bin");
        let v22_bin = node.join("v22").join("bin");
        fs::create_dir_all(&v22_bin).expect("v22 bin");
        fs::write(v22_bin.join("gemini"), b"").expect("dummy gemini");

        let expanded = nvm_node_bin_dirs(&home);
        let rendered: Vec<String> = expanded
            .iter()
            .map(|d| d.to_string_lossy().replace('\\', "/"))
            .collect();
        assert!(
            rendered.iter().any(|d| d.ends_with("/v22/bin")),
            "expected v22/bin, got {rendered:?}"
        );
        assert!(
            !rendered.iter().any(|d| d.ends_with("/v18/bin")),
            "v18 has no bin dir, got {rendered:?}"
        );
        assert!(
            !rendered.iter().any(|d| d.contains('*')),
            "expansion must not keep a literal * path, got {rendered:?}"
        );

        let extra = extra_node_manager_dirs(&home, None);
        let extra_rendered: Vec<String> = extra
            .iter()
            .map(|d| d.to_string_lossy().replace('\\', "/"))
            .collect();
        assert!(
            extra_rendered.iter().any(|d| d.ends_with("/v22/bin")),
            "extra dirs should include expanded v22/bin, got {extra_rendered:?}"
        );
        assert!(
            !extra_rendered.iter().any(|d| d.contains('*')),
            "extra dirs must not include a literal * path, got {extra_rendered:?}"
        );
    }

    struct DeleteDirOnDrop(PathBuf);
    impl Drop for DeleteDirOnDrop {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
