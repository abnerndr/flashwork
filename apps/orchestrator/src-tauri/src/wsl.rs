//! WSL (Windows Subsystem for Linux) support.
//!
//! Two very different situations share this module:
//! - The **Windows build** opening a project that lives inside a distro
//!   (`\\wsl.localhost\Ubuntu\home\u\proj`). Shells and agent CLIs must run
//!   inside the distro through `wsl.exe`, never through Windows pwsh/launchers.
//! - The **Linux build running inside WSL** (`is_wsl()`), which only needs a few
//!   desktop/clipboard workarounds.
//!
//! Every parsing/quoting helper is pure and platform-independent so it is unit
//! tested on any host; only the process-spawning parts are `cfg(windows)`.

use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// A path inside a WSL distro, split into the distro name and the Linux path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WslPath {
    pub distro: String,
    pub linux_path: String,
}

/// Parses `\\wsl$\<distro>\x`, `\\wsl.localhost\<distro>\x`,
/// `\\?\UNC\wsl.localhost\<distro>\x` and their forward-slash spellings.
pub fn parse_wsl_unc(path: &str) -> Option<WslPath> {
    let normalized = path.trim().replace('/', "\\");
    let rest = if let Some(rest) = strip_prefix_ci(&normalized, r"\\?\UNC\") {
        rest
    } else {
        normalized.strip_prefix(r"\\")?
    };
    let mut segments = rest.split('\\');
    let host = segments.next()?;
    if !host.eq_ignore_ascii_case("wsl$") && !host.eq_ignore_ascii_case("wsl.localhost") {
        return None;
    }
    let distro = segments.next().filter(|d| !d.is_empty())?.to_string();
    let parts: Vec<&str> = segments.filter(|s| !s.is_empty()).collect();
    Some(WslPath {
        distro,
        linux_path: format!("/{}", parts.join("/")),
    })
}

fn strip_prefix_ci<'a>(value: &'a str, prefix: &str) -> Option<&'a str> {
    let head = value.get(..prefix.len())?;
    head.eq_ignore_ascii_case(prefix)
        .then(|| &value[prefix.len()..])
}

/// `/home/u/proj` in `Ubuntu` -> `\\wsl.localhost\Ubuntu\home\u\proj`.
pub fn linux_to_wsl_unc(distro: &str, linux_path: &str) -> String {
    let trimmed = linux_path.trim().trim_matches('/');
    if trimmed.is_empty() {
        return format!(r"\\wsl.localhost\{distro}");
    }
    format!(r"\\wsl.localhost\{distro}\{}", trimmed.replace('/', "\\"))
}

/// Windows drive path -> the path the distro sees it at (`C:\x` -> `/mnt/c/x`).
/// A WSL UNC path maps to its Linux path. Anything else returns `None`.
pub fn windows_to_wsl_path(path: &str) -> Option<String> {
    if let Some(wsl) = parse_wsl_unc(path) {
        return Some(wsl.linux_path);
    }
    let trimmed = path.trim();
    let unprefixed = trimmed.strip_prefix(r"\\?\").unwrap_or(trimmed);
    let bytes = unprefixed.as_bytes();
    if bytes.len() < 2 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return None;
    }
    if bytes.len() > 2 && bytes[2] != b'\\' && bytes[2] != b'/' {
        return None;
    }
    let drive = (bytes[0] as char).to_ascii_lowercase();
    let rest: Vec<&str> = unprefixed[2..]
        .split(['\\', '/'])
        .filter(|s| !s.is_empty())
        .collect();
    if rest.is_empty() {
        return Some(format!("/mnt/{drive}"));
    }
    Some(format!("/mnt/{drive}/{}", rest.join("/")))
}

/// Translates a CLI argument for a Linux process when it is a whole Windows
/// path (e.g. the `--mcp-config` file written to `%TEMP%`). Free text — prompts,
/// flags, model ids — is returned untouched.
pub fn translate_arg_for_wsl(arg: &str) -> String {
    if arg.contains(['\n', '\r', '\t']) {
        return arg.to_string();
    }
    windows_to_wsl_path(arg).unwrap_or_else(|| arg.to_string())
}

/// True when this process itself runs inside WSL (the Linux build under WSL).
pub fn is_wsl() -> bool {
    static IS_WSL: OnceLock<bool> = OnceLock::new();
    *IS_WSL.get_or_init(detect_wsl)
}

#[cfg(target_os = "linux")]
fn detect_wsl() -> bool {
    std::env::var_os("WSL_DISTRO_NAME").is_some()
        || std::env::var_os("WSL_INTEROP").is_some()
        || std::fs::read_to_string("/proc/version")
            .map(|v| v.to_ascii_lowercase().contains("microsoft"))
            .unwrap_or(false)
}

#[cfg(not(target_os = "linux"))]
fn detect_wsl() -> bool {
    false
}

/// The WSL target of a working directory, only on the Windows build: that is the
/// one place where a cwd inside a distro needs `wsl.exe` to run anything there.
pub fn wsl_target_for_cwd(cwd: Option<&str>) -> Option<WslPath> {
    if !cfg!(windows) {
        return None;
    }
    parse_wsl_unc(cwd?)
}

/// Decodes `wsl.exe -l -q` output. wsl.exe writes its own messages as UTF-16LE
/// (with or without BOM); newer builds honour `WSL_UTF8=1` and write UTF-8.
pub fn decode_wsl_output(bytes: &[u8]) -> String {
    let looks_utf16 = bytes.starts_with(&[0xFF, 0xFE])
        || (bytes.len() >= 2
            && bytes.len() % 2 == 0
            && bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count() * 2 >= bytes.len() / 2);
    if looks_utf16 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    }
}

/// Distro names from `wsl.exe -l -q` output.
pub fn parse_distro_list(bytes: &[u8]) -> Vec<String> {
    decode_wsl_output(bytes)
        .lines()
        .map(|line| line.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}' || c == '\0'))
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect()
}

/// POSIX single-quote escaping: the result is one word for `sh`/`bash`.
pub fn posix_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

/// Shell prelude for non-interactive `bash -lc` inside a distro. A login shell
/// reads `.profile` but not `.bashrc`, where nvm/bun usually add themselves, so
/// the well-known user bin dirs are appended (never prepended: the user's own
/// PATH order wins).
pub const PATH_PRELUDE: &str = concat!(
    r#"for d in "$HOME/.local/bin" "$HOME/.bun/bin" "$HOME/.cargo/bin" "$HOME/.npm-global/bin" "#,
    r#""$HOME/.volta/bin" "$HOME/.local/share/pnpm" "$HOME"/.nvm/versions/node/*/bin; do "#,
    r#"[ -d "$d" ] && case ":$PATH:" in *":$d:"*) ;; *) PATH="$PATH:$d" ;; esac; done; export PATH; "#
);

/// Script that execs the first available alias of `command` with `args`. The
/// last alias is exec'd unconditionally so a missing CLI still prints bash's
/// "command not found" in the terminal.
pub fn agent_exec_script(aliases: &[&str], args: &[String]) -> String {
    let quoted_args: String = args
        .iter()
        .map(|arg| format!(" {}", posix_quote(&translate_arg_for_wsl(arg))))
        .collect();
    let mut script = String::from(PATH_PRELUDE);
    let (last, rest) = match aliases.split_last() {
        Some(split) => split,
        None => return script,
    };
    for alias in rest {
        let q = posix_quote(alias);
        script.push_str(&format!(
            "if command -v {q} >/dev/null 2>&1; then exec {q}{quoted_args}; fi; "
        ));
    }
    script.push_str(&format!("exec {}{quoted_args}", posix_quote(last)));
    script
}

/// Arguments for `wsl.exe`. `--exec` hands argv straight to the Linux process
/// (no extra pass through the default shell), so the only quoting layer that
/// matters is the POSIX one inside `script`. `None` = the distro's login shell.
pub fn wsl_exec_args(distro: &str, linux_cwd: &str, script: Option<&str>) -> Vec<String> {
    let mut args = vec![
        "-d".to_string(),
        distro.to_string(),
        "--cd".to_string(),
        if linux_cwd.is_empty() {
            "~".to_string()
        } else {
            linux_cwd.to_string()
        },
    ];
    if let Some(script) = script {
        args.extend([
            "--exec".to_string(),
            "bash".to_string(),
            "-lc".to_string(),
            script.to_string(),
        ]);
    }
    args
}

/// Appends `keys` to a `WSLENV` value (`/u` = Windows -> WSL only), keeping
/// what is already there. This is how env vars set on `wsl.exe` reach Linux.
pub fn merge_wslenv(existing: Option<&str>, keys: &[String]) -> String {
    let mut parts: Vec<String> = existing
        .unwrap_or("")
        .split(':')
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .collect();
    for key in keys {
        if key.is_empty() || key.eq_ignore_ascii_case("WSLENV") || key.eq_ignore_ascii_case("PATH")
        {
            continue;
        }
        let present = parts.iter().any(|p| {
            p.split('/')
                .next()
                .is_some_and(|name| name.eq_ignore_ascii_case(key))
        });
        if !present {
            parts.push(format!("{key}/u"));
        }
    }
    parts.join(":")
}

/// Parses `name\tpath` lines printed by the in-distro detection script.
pub fn parse_command_v_output(stdout: &str) -> HashMap<String, String> {
    stdout
        .lines()
        .filter_map(|line| {
            let (name, path) = line.trim().split_once('\t')?;
            let (name, path) = (name.trim(), path.trim());
            (!name.is_empty() && path.starts_with('/'))
                .then(|| (name.to_string(), path.to_string()))
        })
        .collect()
}

/// Detection script: one `command -v` per name, all in a single distro call.
pub fn command_v_script(names: &[&str]) -> String {
    let list: String = names
        .iter()
        .map(|n| format!(" {}", posix_quote(n)))
        .collect();
    format!(
        "{PATH_PRELUDE}for c in{list}; do p=$(command -v \"$c\" 2>/dev/null) && printf '%s\\t%s\\n' \"$c\" \"$p\"; done; exit 0"
    )
}

/// Builds the `wsl.exe` PTY command for a project inside a distro: the login
/// shell for shells, the in-distro binary for agent CLIs.
pub fn wsl_pty_command(
    target: &WslPath,
    requested_command: Option<&str>,
    extra_args: &[String],
) -> portable_pty::CommandBuilder {
    let mut builder = portable_pty::CommandBuilder::new(wsl_exe());
    let agent = requested_command
        .map(str::trim)
        .filter(|c| !c.is_empty() && !crate::cli_resolver::is_interactive_shell_name(c));
    let script = agent.map(|command| {
        let aliases = crate::cli_resolver::cli_name_aliases(command);
        agent_exec_script(&aliases, extra_args)
    });
    for arg in wsl_exec_args(&target.distro, &target.linux_path, script.as_deref()) {
        builder.arg(arg);
    }
    builder.env("TERM", "xterm-256color");
    builder.env("COLORTERM", "truecolor");
    let mut forwarded = vec!["TERM".to_string(), "COLORTERM".to_string()];
    if agent == Some("opencode") {
        builder.env("OPENTUI_FORCE_EXPLICIT_WIDTH", "false");
        forwarded.push("OPENTUI_FORCE_EXPLICIT_WIDTH".to_string());
    }
    forward_env_keys(&mut builder, &forwarded);
    builder
}

/// Makes `keys` (already set on `builder`) visible inside the distro.
pub fn forward_env_keys(builder: &mut portable_pty::CommandBuilder, keys: &[String]) {
    let existing = builder
        .get_env("WSLENV")
        .map(|v| v.to_string_lossy().to_string());
    builder.env("WSLENV", merge_wslenv(existing.as_deref(), keys));
}

/// Absolute `wsl.exe` path when available, so a PATH without System32 still works.
pub fn wsl_exe() -> std::path::PathBuf {
    #[cfg(windows)]
    {
        if let Some(root) = std::env::var_os("SystemRoot") {
            let candidate = std::path::PathBuf::from(root)
                .join("System32")
                .join("wsl.exe");
            if candidate.is_file() {
                return candidate;
            }
        }
    }
    std::path::PathBuf::from("wsl.exe")
}

/// `wsl.exe` subprocess with no console window flashing.
pub fn wsl_command(args: &[String]) -> std::process::Command {
    let mut command = std::process::Command::new(wsl_exe());
    command.args(args);
    // Ask newer wsl.exe builds for UTF-8; older ones ignore it (decode handles both).
    command.env("WSL_UTF8", "1");
    crate::git_control::hide_console(&mut command);
    command
}

/// Installed distros (Windows only; empty elsewhere or on failure).
pub fn list_distros() -> Vec<String> {
    if !cfg!(windows) {
        return Vec::new();
    }
    match wsl_command(&["-l".to_string(), "-q".to_string()]).output() {
        Ok(output) if output.status.success() => parse_distro_list(&output.stdout),
        _ => Vec::new(),
    }
}

#[tauri::command]
pub async fn wsl_list_distros() -> Vec<String> {
    tokio::task::spawn_blocking(list_distros)
        .await
        .unwrap_or_default()
}

static HOME_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

/// `$HOME` of the default user of `distro` (cached for the process lifetime).
pub fn distro_home(distro: &str) -> Option<String> {
    if !cfg!(windows) {
        return None;
    }
    let cache = HOME_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    if let Some(home) = cache.lock().ok()?.get(distro) {
        return Some(home.clone());
    }
    let args = vec![
        "-d".to_string(),
        distro.to_string(),
        "--exec".to_string(),
        "sh".to_string(),
        "-c".to_string(),
        "echo $HOME".to_string(),
    ];
    let output = wsl_command(&args).output().ok()?;
    let home = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !home.starts_with('/') {
        return None;
    }
    cache.lock().ok()?.insert(distro.to_string(), home.clone());
    Some(home)
}

/// `\\wsl.localhost\<distro>\home\<user>\<segments…>` for the distro user.
pub fn distro_home_dir(distro: &str, segments: &[&str]) -> Option<std::path::PathBuf> {
    let home = distro_home(distro)?;
    let linux = segments
        .iter()
        .fold(home.trim_end_matches('/').to_string(), |acc, seg| {
            format!("{acc}/{seg}")
        });
    Some(std::path::PathBuf::from(linux_to_wsl_unc(distro, &linux)))
}

const PROBE_TTL: Duration = Duration::from_secs(30);

type ProbeEntry = (Instant, HashMap<String, String>);
static PROBE_CACHE: OnceLock<Mutex<HashMap<String, ProbeEntry>>> = OnceLock::new();

/// `command -v` for every name inside `distro`, one wsl.exe call, short TTL cache.
pub fn probe_commands_in_distro(distro: &str, names: &[&str]) -> HashMap<String, String> {
    let cache = PROBE_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
    let key = format!("{distro}\u{0}{}", names.join(","));
    if let Ok(map) = cache.lock() {
        if let Some((at, hits)) = map.get(&key) {
            if at.elapsed() < PROBE_TTL {
                return hits.clone();
            }
        }
    }
    let args = vec![
        "-d".to_string(),
        distro.to_string(),
        "--exec".to_string(),
        "bash".to_string(),
        "-lc".to_string(),
        command_v_script(names),
    ];
    let hits = wsl_command(&args)
        .output()
        .map(|output| parse_command_v_output(&String::from_utf8_lossy(&output.stdout)))
        .unwrap_or_default();
    if let Ok(mut map) = cache.lock() {
        map.insert(key, (Instant::now(), hits.clone()));
    }
    hits
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentDetection {
    /// CLI command name as asked (`claude`, `agy`, `gemini`…).
    pub agent: String,
    pub installed: bool,
    pub path: Option<String>,
    pub version: Option<String>,
    /// Distro the CLI was probed in, when the cwd is inside WSL.
    pub wsl_distro: Option<String>,
}

const DEFAULT_AGENT_COMMANDS: [&str; 8] = [
    "claude", "codex", "opencode", "gemini", "agy", "copilot", "freebuff", "mimo",
];

/// Which agent CLIs can run for `cwd`. A WSL cwd (Windows build) is probed
/// inside its distro; everything else uses the regular launcher resolver.
#[tauri::command]
pub async fn detect_agents_for_cwd(
    cwd: Option<String>,
    agents: Option<Vec<String>>,
) -> Vec<AgentDetection> {
    tokio::task::spawn_blocking(move || {
        let commands: Vec<String> = agents.filter(|list| !list.is_empty()).unwrap_or_else(|| {
            DEFAULT_AGENT_COMMANDS
                .iter()
                .map(|s| s.to_string())
                .collect()
        });
        detect_agents_blocking(cwd.as_deref(), &commands)
    })
    .await
    .unwrap_or_default()
}

fn detect_agents_blocking(cwd: Option<&str>, commands: &[String]) -> Vec<AgentDetection> {
    if let Some(target) = wsl_target_for_cwd(cwd) {
        let mut names: Vec<&str> = Vec::new();
        for command in commands {
            for alias in crate::cli_resolver::cli_name_aliases(command) {
                if !names.contains(&alias) {
                    names.push(alias);
                }
            }
        }
        let hits = probe_commands_in_distro(&target.distro, &names);
        return commands
            .iter()
            .map(|command| {
                let path = crate::cli_resolver::cli_name_aliases(command)
                    .into_iter()
                    .find_map(|alias| hits.get(alias).cloned());
                AgentDetection {
                    agent: command.clone(),
                    installed: path.is_some(),
                    path,
                    version: None,
                    wsl_distro: Some(target.distro.clone()),
                }
            })
            .collect();
    }
    commands
        .iter()
        .map(|command| {
            let path = crate::cli_resolver::find_windows_cli_launcher(command)
                .map(|p| p.to_string_lossy().to_string());
            AgentDetection {
                agent: command.clone(),
                installed: path.is_some(),
                path,
                version: None,
                wsl_distro: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wp(distro: &str, linux: &str) -> Option<WslPath> {
        Some(WslPath {
            distro: distro.into(),
            linux_path: linux.into(),
        })
    }

    #[test]
    fn parses_every_wsl_unc_spelling() {
        assert_eq!(
            parse_wsl_unc(r"\\wsl$\Ubuntu\home\u\proj"),
            wp("Ubuntu", "/home/u/proj")
        );
        assert_eq!(
            parse_wsl_unc(r"\\wsl.localhost\Ubuntu-22.04\home\u\"),
            wp("Ubuntu-22.04", "/home/u")
        );
        assert_eq!(
            parse_wsl_unc(r"\\?\UNC\wsl.localhost\Debian\srv\x"),
            wp("Debian", "/srv/x")
        );
        assert_eq!(
            parse_wsl_unc("//wsl.localhost/Ubuntu/home/u"),
            wp("Ubuntu", "/home/u")
        );
        assert_eq!(parse_wsl_unc(r"\\WSL$\Ubuntu"), wp("Ubuntu", "/"));
        assert_eq!(
            parse_wsl_unc(r"\\?\unc\WSL.LOCALHOST\Arch\a b\c"),
            wp("Arch", "/a b/c")
        );
    }

    #[test]
    fn rejects_non_wsl_paths() {
        assert_eq!(parse_wsl_unc(r"C:\Users\u\proj"), None);
        assert_eq!(parse_wsl_unc(r"\\server\share\x"), None);
        assert_eq!(parse_wsl_unc("/home/u/proj"), None);
        assert_eq!(parse_wsl_unc(r"\\wsl$\"), None);
        assert_eq!(parse_wsl_unc(""), None);
    }

    #[test]
    fn maps_linux_paths_back_to_unc() {
        assert_eq!(
            linux_to_wsl_unc("Ubuntu", "/home/u/proj"),
            r"\\wsl.localhost\Ubuntu\home\u\proj"
        );
        assert_eq!(
            linux_to_wsl_unc("Ubuntu", "/home/u/proj/"),
            r"\\wsl.localhost\Ubuntu\home\u\proj"
        );
        assert_eq!(linux_to_wsl_unc("Ubuntu", "/"), r"\\wsl.localhost\Ubuntu");
        let unc = linux_to_wsl_unc("Debian", "/srv/a b");
        assert_eq!(parse_wsl_unc(&unc), wp("Debian", "/srv/a b"));
    }

    #[test]
    fn translates_windows_paths_to_mnt() {
        assert_eq!(
            windows_to_wsl_path(r"C:\Users\Jo Do\AppData\Local\Temp\mcp.json").as_deref(),
            Some("/mnt/c/Users/Jo Do/AppData/Local/Temp/mcp.json")
        );
        assert_eq!(windows_to_wsl_path("D:/x/y").as_deref(), Some("/mnt/d/x/y"));
        assert_eq!(
            windows_to_wsl_path(r"\\?\E:\a").as_deref(),
            Some("/mnt/e/a")
        );
        assert_eq!(windows_to_wsl_path(r"C:\").as_deref(), Some("/mnt/c"));
        assert_eq!(
            windows_to_wsl_path(r"\\wsl$\U\home\u").as_deref(),
            Some("/home/u")
        );
        assert_eq!(windows_to_wsl_path("--mcp-config"), None);
        assert_eq!(windows_to_wsl_path("C:relative"), None);
        assert_eq!(windows_to_wsl_path("/home/u"), None);
    }

    #[test]
    fn arg_translation_leaves_free_text_alone() {
        assert_eq!(translate_arg_for_wsl(r"C:\tmp\a.json"), "/mnt/c/tmp/a.json");
        assert_eq!(translate_arg_for_wsl("fix the bug"), "fix the bug");
        assert_eq!(translate_arg_for_wsl("C:\\a\nmore"), "C:\\a\nmore");
        assert_eq!(translate_arg_for_wsl("--model"), "--model");
    }

    #[test]
    fn posix_quote_escapes_single_quotes() {
        assert_eq!(posix_quote("plain"), "'plain'");
        assert_eq!(posix_quote("it's"), r"'it'\''s'");
        assert_eq!(posix_quote("$HOME `x` \"y\""), "'$HOME `x` \"y\"'");
        assert_eq!(posix_quote(""), "''");
    }

    #[test]
    fn agent_script_execs_aliases_with_quoted_args() {
        let script = agent_exec_script(
            &["gemini", "gemini-cli"],
            &[
                "-p".to_string(),
                "don't".to_string(),
                r"C:\t\m.json".to_string(),
            ],
        );
        assert!(script.starts_with(PATH_PRELUDE));
        assert!(script.contains(
            r"if command -v 'gemini' >/dev/null 2>&1; then exec 'gemini' '-p' 'don'\''t' '/mnt/c/t/m.json'; fi; "
        ));
        assert!(script.ends_with(r"exec 'gemini-cli' '-p' 'don'\''t' '/mnt/c/t/m.json'"));
    }

    #[test]
    fn wsl_args_use_exec_for_agents_and_login_shell_otherwise() {
        assert_eq!(
            wsl_exec_args("Ubuntu", "/home/u/p", Some("exec 'claude'")),
            vec![
                "-d",
                "Ubuntu",
                "--cd",
                "/home/u/p",
                "--exec",
                "bash",
                "-lc",
                "exec 'claude'"
            ]
        );
        assert_eq!(
            wsl_exec_args("Ubuntu", "/home/u/p", None),
            vec!["-d", "Ubuntu", "--cd", "/home/u/p"]
        );
    }

    #[test]
    fn decodes_utf16le_distro_list_with_and_without_bom() {
        let text = "Ubuntu\r\nDebian\r\n\r\n";
        let utf16: Vec<u8> = text.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
        assert_eq!(parse_distro_list(&utf16), vec!["Ubuntu", "Debian"]);
        let mut with_bom = vec![0xFF, 0xFE];
        with_bom.extend_from_slice(&utf16);
        assert_eq!(parse_distro_list(&with_bom), vec!["Ubuntu", "Debian"]);
        assert_eq!(
            parse_distro_list(b"Ubuntu-22.04\nkali-linux\n"),
            vec!["Ubuntu-22.04", "kali-linux"]
        );
        assert!(parse_distro_list(&[]).is_empty());
    }

    #[test]
    fn merges_wslenv_without_duplicates() {
        let keys = vec![
            "TERM".to_string(),
            "ANTHROPIC_API_KEY".to_string(),
            "PATH".to_string(),
        ];
        assert_eq!(merge_wslenv(None, &keys), "TERM/u:ANTHROPIC_API_KEY/u");
        assert_eq!(
            merge_wslenv(Some("USERPROFILE/p:TERM"), &keys),
            "USERPROFILE/p:TERM:ANTHROPIC_API_KEY/u"
        );
    }

    #[test]
    fn parses_command_v_lines() {
        let hits = parse_command_v_output(
            "claude\t/home/u/.local/bin/claude\ncodex\talias codex\n\ngarbage\n",
        );
        assert_eq!(
            hits.get("claude").map(String::as_str),
            Some("/home/u/.local/bin/claude")
        );
        assert_eq!(hits.len(), 1);
        let script = command_v_script(&["claude", "codex"]);
        assert!(script.contains("for c in 'claude' 'codex'; do"));
    }

    #[test]
    fn wsl_target_only_applies_on_windows() {
        let target = wsl_target_for_cwd(Some(r"\\wsl$\Ubuntu\home\u"));
        assert_eq!(target.is_some(), cfg!(windows));
        assert_eq!(wsl_target_for_cwd(None), None);
    }
}
