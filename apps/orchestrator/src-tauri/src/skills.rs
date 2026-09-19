use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::provider_common::provider_home_dir;

const SKILL_FILE: &str = "SKILL.md";
const CODEX_SYSTEM_MARKER: &str = ".codex-system-skills.marker";
const MAX_TREE_DEPTH: usize = 4;
const MAX_TREE_CHILDREN: usize = 100;

/// `shared` is the cross-agent store the other roots link into, not an agent of its own.
const ROOTS: [(&str, &[&str]); 5] = [
    ("claude", &[".claude", "skills"]),
    ("codex", &[".codex", "skills"]),
    ("opencode", &[".config", "opencode", "skill"]),
    ("antigravity", &[".gemini", "skills"]),
    ("shared", &[".agents", "skills"]),
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillSummary {
    pub name: String,
    pub agent: String,
    pub path: String,
    pub resolved_path: String,
    pub description: String,
    pub linked: bool,
    pub shared: bool,
    pub bundled: bool,
    pub entry_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillAgentSnapshot {
    pub agent: String,
    pub root: Option<String>,
    pub exists: bool,
    pub skills: Vec<SkillSummary>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub children: Vec<SkillNode>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillLockInfo {
    pub source: Option<String>,
    pub source_url: Option<String>,
    pub installed_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillDetail {
    pub summary: SkillSummary,
    pub frontmatter: BTreeMap<String, String>,
    pub frontmatter_raw: String,
    pub body: String,
    pub tree: Vec<SkillNode>,
    pub lock: Option<SkillLockInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRemoveReport {
    pub path: String,
    pub removed_link_only: bool,
    pub shared_copy_path: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum SkillInstallSource {
    Folder {
        path: String,
    },
    Git {
        url: String,
        #[serde(default)]
        spec: Option<String>,
    },
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInstallRequest {
    pub source: SkillInstallSource,
    #[serde(default)]
    pub agents: Vec<String>,
    #[serde(default)]
    pub overwrite: bool,
}

fn skills_home(segments: &[&str]) -> Option<PathBuf> {
    if let Some(root) = std::env::var_os("FLASHWORK_MCP_HOME") {
        let base = PathBuf::from(root);
        if !base.as_os_str().is_empty() {
            return Some(segments.iter().fold(base, |acc, seg| acc.join(seg)));
        }
    }
    provider_home_dir(segments)
}

fn root_for(agent: &str) -> Option<PathBuf> {
    ROOTS
        .iter()
        .find(|(name, _)| *name == agent)
        .and_then(|(_, segments)| skills_home(segments))
}

/// Strips the Windows verbatim prefix so the path is what the user would type.
fn display_path(path: &Path) -> String {
    let text = path.to_string_lossy().to_string();
    text.strip_prefix(r"\\?\")
        .map(str::to_string)
        .unwrap_or(text)
}

fn shared_root() -> Option<PathBuf> {
    skills_home(&[".agents", "skills"])
}

fn resolve(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

fn is_link(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.file_type().is_symlink())
        .unwrap_or(false)
}

fn entry_count(dir: &Path) -> usize {
    fs::read_dir(dir)
        .map(|entries| entries.count())
        .unwrap_or(0)
}

fn split_frontmatter(raw: &str) -> (String, String) {
    let normalized = raw.replace("\r\n", "\n");
    let Some(rest) = normalized.strip_prefix("---\n") else {
        return (String::new(), normalized);
    };
    match rest.split_once("\n---") {
        Some((front, body)) => (
            front.to_string(),
            body.trim_start_matches('\n').trim_start().to_string(),
        ),
        None => (String::new(), normalized),
    }
}

fn unquote(value: &str) -> String {
    let trimmed = value.trim();
    for quote in ['"', '\''] {
        if trimmed.len() >= 2 && trimmed.starts_with(quote) && trimmed.ends_with(quote) {
            return trimmed[1..trimmed.len() - 1].to_string();
        }
    }
    trimmed.to_string()
}

/// Handles the shapes actually present in installed skills: plain scalars, quoted
/// scalars, folded/literal blocks and nested maps kept as their raw text.
fn parse_frontmatter(front: &str) -> BTreeMap<String, String> {
    let lines: Vec<&str> = front.lines().collect();
    let mut out = BTreeMap::new();
    let mut index = 0;

    while index < lines.len() {
        let line = lines[index];
        index += 1;
        if line.trim().is_empty() || line.starts_with([' ', '\t', '#', '-']) {
            continue;
        }
        let Some((key, rest)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_string();
        let rest = rest.trim();

        let mut block: Vec<String> = Vec::new();
        if rest.is_empty() || rest.starts_with('>') || rest.starts_with('|') {
            while index < lines.len() {
                let next = lines[index];
                if next.trim().is_empty() {
                    index += 1;
                    continue;
                }
                if !next.starts_with([' ', '\t']) {
                    break;
                }
                block.push(next.trim().to_string());
                index += 1;
            }
        }

        let value = if block.is_empty() {
            unquote(rest)
        } else if rest.starts_with('|') {
            block.join("\n")
        } else {
            block.join(" ")
        };
        out.insert(key, value);
    }
    out
}

fn read_skill_file(dir: &Path) -> Option<String> {
    fs::read_to_string(dir.join(SKILL_FILE)).ok()
}

fn has_bundled_marker(dir: &Path, root: &Path) -> bool {
    let mut cursor = Some(dir);
    while let Some(current) = cursor {
        if current.join(CODEX_SYSTEM_MARKER).is_file() {
            return true;
        }
        if current == root {
            break;
        }
        cursor = current.parent();
    }
    false
}

fn summarize(agent: &str, root: &Path, dir: &Path, bundled: bool) -> Option<SkillSummary> {
    let raw = read_skill_file(dir)?;
    let (front, _) = split_frontmatter(&raw);
    let fields = parse_frontmatter(&front);
    let resolved = resolve(dir);
    let shared = shared_root()
        .map(|shared| resolved.starts_with(resolve(&shared)))
        .unwrap_or(false);

    Some(SkillSummary {
        name: dir
            .file_name()
            .map(|name| name.to_string_lossy().to_string())
            .unwrap_or_default(),
        agent: agent.to_string(),
        path: display_path(dir),
        resolved_path: display_path(&resolved),
        description: fields.get("description").cloned().unwrap_or_default(),
        linked: is_link(dir),
        shared: shared && agent != "shared",
        bundled: bundled || has_bundled_marker(dir, root),
        entry_count: entry_count(dir),
    })
}

fn collect_root(agent: &str, root: &Path) -> Vec<SkillSummary> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        if name == ".system" {
            if let Ok(bundled) = fs::read_dir(&path) {
                for nested in bundled.flatten() {
                    let nested_path = nested.path();
                    if nested_path.is_dir() {
                        if let Some(summary) = summarize(agent, root, &nested_path, true) {
                            out.push(summary);
                        }
                    }
                }
            }
            continue;
        }
        if name.starts_with('.') {
            continue;
        }
        if let Some(summary) = summarize(agent, root, &path, false) {
            out.push(summary);
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

fn scan_inner() -> Vec<SkillAgentSnapshot> {
    ROOTS
        .iter()
        .map(|(agent, segments)| {
            let root = skills_home(segments);
            let exists = root.as_ref().map(|path| path.is_dir()).unwrap_or(false);
            let skills = match (&root, exists) {
                (Some(path), true) => collect_root(agent, path),
                _ => Vec::new(),
            };
            SkillAgentSnapshot {
                agent: agent.to_string(),
                root: root.as_deref().map(display_path),
                exists,
                skills,
            }
        })
        .collect()
}

fn build_tree(dir: &Path, depth: usize) -> Vec<SkillNode> {
    if depth >= MAX_TREE_DEPTH {
        return Vec::new();
    }
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut items: Vec<PathBuf> = entries.flatten().map(|entry| entry.path()).collect();
    items.sort_by_key(|path| {
        (
            !path.is_dir(),
            path.file_name()
                .map(|name| name.to_string_lossy().to_lowercase())
                .unwrap_or_default(),
        )
    });

    let truncated = items.len() > MAX_TREE_CHILDREN;
    items
        .into_iter()
        .take(MAX_TREE_CHILDREN)
        .map(|path| {
            let is_dir = path.is_dir();
            SkillNode {
                name: path
                    .file_name()
                    .map(|name| name.to_string_lossy().to_string())
                    .unwrap_or_default(),
                path: display_path(&path),
                is_dir,
                size: fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0),
                children: if is_dir {
                    build_tree(&path, depth + 1)
                } else {
                    Vec::new()
                },
                truncated: false,
            }
        })
        .map(|mut node| {
            node.truncated = truncated;
            node
        })
        .collect()
}

fn lock_info(name: &str) -> Option<SkillLockInfo> {
    let path = skills_home(&[".agents", ".skill-lock.json"])?;
    let raw = fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&raw).ok()?;
    let entry = value.get("skills")?.get(name)?;
    let text = |key: &str| entry.get(key).and_then(Value::as_str).map(str::to_string);
    Some(SkillLockInfo {
        source: text("source"),
        source_url: text("sourceUrl"),
        installed_at: text("installedAt"),
        updated_at: text("updatedAt"),
    })
}

fn validate_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty() || name == "." || name == ".." || name.contains(['/', '\\', ':']) {
        return Err("invalid_name".to_string());
    }
    Ok(())
}

/// Resolves `<root>/<name>` and proves it did not escape the root, so a crafted name
/// can never point the reader or the uninstaller somewhere else.
fn locate(agent: &str, name: &str) -> Result<(PathBuf, PathBuf), String> {
    validate_name(name)?;
    let root = root_for(agent).ok_or_else(|| "unknown_agent".to_string())?;
    let direct = root.join(name);
    let system = root.join(".system").join(name);
    let target = if direct.is_dir() {
        direct
    } else if system.is_dir() {
        system
    } else {
        return Err("not_found".to_string());
    };

    let resolved_root = resolve(&root);
    let parent = target
        .parent()
        .map(resolve)
        .ok_or_else(|| "outside_root".to_string())?;
    if !parent.starts_with(&resolved_root) {
        return Err("outside_root".to_string());
    }
    Ok((root, target))
}

fn detail_inner(agent: String, name: String) -> Result<SkillDetail, String> {
    let (root, path) = locate(&agent, &name)?;
    let summary = summarize(&agent, &root, &path, false).ok_or_else(|| "not_found".to_string())?;
    let raw = read_skill_file(&path).ok_or_else(|| "not_found".to_string())?;
    let (front, body) = split_frontmatter(&raw);

    Ok(SkillDetail {
        lock: lock_info(&summary.name),
        frontmatter: parse_frontmatter(&front),
        frontmatter_raw: front,
        body,
        tree: build_tree(&path, 0),
        summary,
    })
}

fn uninstall_inner(agent: String, name: String) -> Result<SkillRemoveReport, String> {
    let (root, path) = locate(&agent, &name)?;
    let summary = summarize(&agent, &root, &path, false).ok_or_else(|| "not_found".to_string())?;
    if summary.bundled {
        return Err("bundled_skill".to_string());
    }

    if summary.linked {
        // A directory link (symlink or Windows junction) is unlinked, never followed —
        // the shared copy other agents point at has to survive.
        fs::remove_dir(&path)
            .or_else(|_| fs::remove_file(&path))
            .map_err(|error| format!("remove_failed:{error}"))?;
        return Ok(SkillRemoveReport {
            path: summary.path,
            removed_link_only: true,
            shared_copy_path: Some(summary.resolved_path),
        });
    }

    fs::remove_dir_all(&path).map_err(|error| format!("remove_failed:{error}"))?;
    Ok(SkillRemoveReport {
        path: summary.path,
        removed_link_only: false,
        shared_copy_path: None,
    })
}

const MAX_INSTALL_NAME_LEN: usize = 64;

/// Turns an arbitrary directory/repo basename into a safe store name: keeps only
/// `[a-zA-Z0-9._-]`, trims stray leading/trailing dots (so a name of only dots can
/// never collapse to `.`/`..`), and caps the length. This is deliberately stricter
/// than `validate_name`, which only guards the existing uninstall/detail lookups.
fn sanitize_install_name(raw: &str) -> Result<String, String> {
    let filtered: String = raw
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        .take(MAX_INSTALL_NAME_LEN)
        .collect();
    let trimmed = filtered.trim_matches('.');
    if trimmed.is_empty() {
        return Err("invalid_name".to_string());
    }
    Ok(trimmed.to_string())
}

/// Derives a candidate skill name from a git URL, e.g.
/// `https://github.com/foo/bar.git` -> `bar`. The result still goes through
/// `sanitize_install_name` before it is used as a directory name.
fn repo_name_from_url(url: &str) -> String {
    let trimmed = url.trim_end_matches('/').trim_end_matches(".git");
    trimmed
        .rsplit(['/', ':'])
        .next()
        .filter(|segment| !segment.is_empty())
        .unwrap_or(trimmed)
        .to_string()
}

/// Copies `current` into `dest`, resolving every entry and refusing any whose
/// target (typically a symlink) escapes `root`. `root` and the initial `current`
/// must already be canonicalized by the caller.
fn copy_tree_confined(root: &Path, current: &Path, dest: &Path) -> Result<(), String> {
    fs::create_dir_all(dest).map_err(|error| format!("write_failed:{error}"))?;
    let entries = fs::read_dir(current).map_err(|error| format!("read_failed:{error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("read_failed:{error}"))?;
        let path = entry.path();
        let resolved = resolve(&path);
        if !resolved.starts_with(root) {
            return Err("outside_root".to_string());
        }
        let dest_child = dest.join(entry.file_name());
        let file_type = entry
            .file_type()
            .map_err(|error| format!("read_failed:{error}"))?;
        if file_type.is_dir() || (file_type.is_symlink() && path.is_dir()) {
            copy_tree_confined(root, &path, &dest_child)?;
        } else {
            fs::copy(&path, &dest_child).map_err(|error| format!("write_failed:{error}"))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn create_agent_link(target: &Path, link: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(target, link).map_err(|error| format!("link_failed:{error}"))
}

#[cfg(windows)]
fn create_agent_link(target: &Path, link: &Path) -> Result<(), String> {
    if std::os::windows::fs::symlink_dir(target, link).is_ok() {
        return Ok(());
    }
    // A real symlink needs elevation on Windows; a directory junction does not,
    // so fall back to `mklink /J` when the symlink attempt is denied.
    let mut command = Command::new("cmd");
    command.args([
        "/C",
        "mklink",
        "/J",
        &link.to_string_lossy(),
        &target.to_string_lossy(),
    ]);
    crate::git_control::hide_console(&mut command);
    let output = command
        .output()
        .map_err(|error| format!("link_failed:{error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "link_failed:{}",
            String::from_utf8_lossy(&output.stderr)
        ))
    }
}

/// Unlinks a directory link without following it, or removes a real file/dir.
/// Mirrors the uninstall behavior so overwrite never deletes through a link.
fn remove_existing(path: &Path) -> Result<(), String> {
    if is_link(path) {
        fs::remove_dir(path)
            .or_else(|_| fs::remove_file(path))
            .map_err(|error| format!("remove_failed:{error}"))
    } else if path.is_dir() {
        fs::remove_dir_all(path).map_err(|error| format!("remove_failed:{error}"))
    } else if path.exists() {
        fs::remove_file(path).map_err(|error| format!("remove_failed:{error}"))
    } else {
        Ok(())
    }
}

/// Merges one entry into `.skill-lock.json`, preserving `installedAt` across
/// reinstalls/overwrites and only touching `updatedAt`.
fn write_lock_info(name: &str, source: &str, source_url: &str) -> Result<(), String> {
    let path =
        skills_home(&[".agents", ".skill-lock.json"]).ok_or_else(|| "unknown_agent".to_string())?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("write_failed:{error}"))?;
    }

    let mut root: Value = fs::read_to_string(&path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}));

    if !root.get("skills").map(Value::is_object).unwrap_or(false) {
        root["skills"] = serde_json::json!({});
    }

    let now = chrono::Utc::now().to_rfc3339();
    let installed_at = root["skills"]
        .get(name)
        .and_then(|entry| entry.get("installedAt"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| now.clone());

    root["skills"][name] = serde_json::json!({
        "source": source,
        "sourceUrl": source_url,
        "installedAt": installed_at,
        "updatedAt": now,
    });

    let serialized =
        serde_json::to_string_pretty(&root).map_err(|error| format!("write_failed:{error}"))?;
    fs::write(&path, serialized).map_err(|error| format!("write_failed:{error}"))
}

/// Shared tail of both install paths: validate, copy into the shared store,
/// record the lock entry, and link into every requested (non-`shared`) agent.
fn install_from_source_dir(
    source_dir: &Path,
    name: &str,
    source_kind: &str,
    source_url: &str,
    agents: &[String],
    overwrite: bool,
) -> Result<SkillSummary, String> {
    if !source_dir.join(SKILL_FILE).is_file() {
        return Err("no_skill_md".to_string());
    }
    for agent in agents {
        if agent != "shared" && root_for(agent).is_none() {
            return Err("unknown_agent".to_string());
        }
    }

    let shared = shared_root().ok_or_else(|| "unknown_agent".to_string())?;
    fs::create_dir_all(&shared).map_err(|error| format!("write_failed:{error}"))?;
    let dest = shared.join(name);

    if dest.exists() || is_link(&dest) {
        if !overwrite {
            return Err("skill_exists".to_string());
        }
        remove_existing(&dest)?;
    }

    let canonical_source =
        fs::canonicalize(source_dir).map_err(|error| format!("read_failed:{error}"))?;
    copy_tree_confined(&canonical_source, &canonical_source, &dest)?;

    write_lock_info(name, source_kind, source_url)?;

    for agent in agents {
        if agent == "shared" {
            continue;
        }
        let root = root_for(agent).ok_or_else(|| "unknown_agent".to_string())?;
        fs::create_dir_all(&root).map_err(|error| format!("write_failed:{error}"))?;
        let link_path = root.join(name);
        if link_path.exists() || is_link(&link_path) {
            remove_existing(&link_path)?;
        }
        create_agent_link(&dest, &link_path)?;
    }

    summarize("shared", &shared, &dest, false).ok_or_else(|| "not_found".to_string())
}

fn install_inner(req: SkillInstallRequest) -> Result<SkillSummary, String> {
    match req.source {
        SkillInstallSource::Folder { path } => {
            let source_dir = PathBuf::from(&path);
            if !source_dir.is_dir() {
                return Err("not_found".to_string());
            }
            let basename = source_dir
                .file_name()
                .map(|name| name.to_string_lossy().to_string())
                .ok_or_else(|| "invalid_name".to_string())?;
            let name = sanitize_install_name(&basename)?;
            install_from_source_dir(
                &source_dir,
                &name,
                "folder",
                &path,
                &req.agents,
                req.overwrite,
            )
        }
        SkillInstallSource::Git { url, spec } => {
            let temp_dir = std::env::temp_dir()
                .join(format!("flashwork-skill-install-{}", nanoid::nanoid!(8)));

            let mut command = Command::new("git");
            command.arg("clone").arg("--depth").arg("1");
            if let Some(branch) = spec.as_deref().filter(|value| !value.is_empty()) {
                command.arg("--branch").arg(branch);
            }
            command.arg(&url).arg(&temp_dir);
            crate::git_control::hide_console(&mut command);

            let output = command
                .output()
                .map_err(|error| format!("git_exec_failed:{error}"))?;
            if !output.status.success() {
                let _ = fs::remove_dir_all(&temp_dir);
                return Err(format!(
                    "git_clone_failed:{}",
                    String::from_utf8_lossy(&output.stderr)
                ));
            }

            let result = sanitize_install_name(&repo_name_from_url(&url)).and_then(|name| {
                install_from_source_dir(&temp_dir, &name, "git", &url, &req.agents, req.overwrite)
            });
            let _ = fs::remove_dir_all(&temp_dir);
            result
        }
    }
}

#[tauri::command]
pub async fn skills_scan() -> Result<Vec<SkillAgentSnapshot>, String> {
    tokio::task::spawn_blocking(scan_inner)
        .await
        .map_err(|error| format!("skills_scan:{error}"))
}

#[tauri::command]
pub async fn skills_detail(agent: String, name: String) -> Result<SkillDetail, String> {
    tokio::task::spawn_blocking(move || detail_inner(agent, name))
        .await
        .map_err(|error| format!("skills_detail:{error}"))?
}

#[tauri::command]
pub async fn skills_uninstall(agent: String, name: String) -> Result<SkillRemoveReport, String> {
    tokio::task::spawn_blocking(move || uninstall_inner(agent, name))
        .await
        .map_err(|error| format!("skills_uninstall:{error}"))?
}

#[tauri::command]
pub async fn skills_install(req: SkillInstallRequest) -> Result<SkillSummary, String> {
    tokio::task::spawn_blocking(move || install_inner(req))
        .await
        .map_err(|error| format!("skills_install:{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("flashwork-skills-{label}-{}", nanoid::nanoid!(8)))
    }

    /// `FLASHWORK_MCP_HOME` is process-global, so every test that touches it must
    /// serialize behind this lock to avoid a concurrent test observing a half-set
    /// (or another test's) value. Restores/removes the var and deletes its temp
    /// dir on drop.
    fn env_lock() -> &'static std::sync::Mutex<()> {
        static LOCK: std::sync::OnceLock<std::sync::Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| std::sync::Mutex::new(()))
    }

    struct EnvGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        dir: PathBuf,
    }

    impl EnvGuard {
        fn new(label: &str) -> Self {
            let lock = env_lock()
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let dir = unique_temp_dir(&format!("home-{label}"));
            fs::create_dir_all(&dir).unwrap();
            std::env::set_var("FLASHWORK_MCP_HOME", &dir);
            Self { _lock: lock, dir }
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            std::env::remove_var("FLASHWORK_MCP_HOME");
            let _ = fs::remove_dir_all(&self.dir);
        }
    }

    /// Nests the source under a random parent so the directory *basename* is
    /// exactly `name` (what `install_inner` derives the skill name from), while
    /// the parent stays unique across test runs.
    fn write_skill_source(name: &str) -> PathBuf {
        let parent = unique_temp_dir(&format!("source-{name}"));
        let dir = parent.join(name);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(SKILL_FILE),
            "---\nname: test\ndescription: a test skill\n---\n\nBody.\n",
        )
        .unwrap();
        dir
    }

    fn folder_request(path: &Path, agents: &[&str], overwrite: bool) -> SkillInstallRequest {
        SkillInstallRequest {
            source: SkillInstallSource::Folder {
                path: path.to_string_lossy().to_string(),
            },
            agents: agents.iter().map(|agent| agent.to_string()).collect(),
            overwrite,
        }
    }

    #[test]
    fn frontmatter_reads_plain_quoted_and_folded_values() {
        let front = "name: motion\ndescription: \"Creates motion graphics\"\nlicense: MIT";
        let fields = parse_frontmatter(front);
        assert_eq!(fields.get("name").map(String::as_str), Some("motion"));
        assert_eq!(
            fields.get("description").map(String::as_str),
            Some("Creates motion graphics")
        );
        assert_eq!(fields.get("license").map(String::as_str), Some("MIT"));
    }

    #[test]
    fn frontmatter_joins_a_folded_block() {
        let front =
            "name: pptx\ndescription: >-\n  Use this skill any time\n  a .pptx file is involved.\n";
        let fields = parse_frontmatter(front);
        assert_eq!(
            fields.get("description").map(String::as_str),
            Some("Use this skill any time a .pptx file is involved.")
        );
    }

    #[test]
    fn frontmatter_keeps_a_nested_map_as_its_indented_text() {
        let front = "name: imagegen\nmetadata:\n  short-description: Generates images\n";
        let fields = parse_frontmatter(front);
        assert_eq!(
            fields.get("metadata").map(String::as_str),
            Some("short-description: Generates images")
        );
    }

    #[test]
    fn split_frontmatter_separates_body_and_tolerates_its_absence() {
        let (front, body) = split_frontmatter("---\nname: a\n---\n\n# Title\ntext\n");
        assert_eq!(front, "name: a");
        assert!(body.starts_with("# Title"));

        let (front, body) = split_frontmatter("# Just a body\n");
        assert!(front.is_empty());
        assert_eq!(body, "# Just a body\n");
    }

    #[test]
    fn a_crafted_name_cannot_escape_the_root() {
        assert_eq!(validate_name("../../etc").unwrap_err(), "invalid_name");
        assert_eq!(validate_name("a/b").unwrap_err(), "invalid_name");
        assert_eq!(validate_name("..").unwrap_err(), "invalid_name");
        assert_eq!(validate_name("   ").unwrap_err(), "invalid_name");
        assert!(validate_name("promo-film").is_ok());
    }

    #[test]
    fn display_path_drops_the_windows_verbatim_prefix() {
        assert_eq!(
            display_path(Path::new(r"\\?\C:\Users\x\.agents\skills\brand")),
            r"C:\Users\x\.agents\skills\brand"
        );
    }

    #[test]
    fn scanning_returns_one_snapshot_per_root_without_panicking() {
        let snapshots = scan_inner();
        assert_eq!(snapshots.len(), ROOTS.len());
        for snapshot in &snapshots {
            if !snapshot.exists {
                assert!(snapshot.skills.is_empty());
            }
            for skill in &snapshot.skills {
                assert!(!skill.name.is_empty());
                assert_eq!(skill.agent, snapshot.agent);
            }
        }
    }

    #[test]
    fn every_root_resolves_to_a_path() {
        for (agent, _) in ROOTS {
            assert!(root_for(agent).is_some(), "{agent} has no root");
        }
        assert!(root_for("nonsense").is_none());
    }

    #[test]
    fn install_from_folder_requires_skill_md() {
        let source = unique_temp_dir("install-missing-skill-md");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("notes.txt"), "not a skill").unwrap();

        let req = SkillInstallRequest {
            source: SkillInstallSource::Folder {
                path: source.to_string_lossy().to_string(),
            },
            agents: vec!["shared".to_string()],
            overwrite: false,
        };

        let result = install_inner(req);
        let _ = fs::remove_dir_all(&source);
        assert_eq!(result.unwrap_err(), "no_skill_md");
    }

    #[test]
    fn install_from_folder_installs_into_shared_store() {
        let _guard = EnvGuard::new("happy-path");
        let source = write_skill_source("promo-film");
        let req = folder_request(&source, &["shared"], false);

        let summary = install_inner(req).expect("install should succeed");
        let _ = fs::remove_dir_all(&source);

        assert_eq!(summary.name, "promo-film");
        assert_eq!(summary.agent, "shared");
        let dest = shared_root().unwrap().join("promo-film");
        assert!(dest.join(SKILL_FILE).is_file());
    }

    #[test]
    fn install_without_overwrite_fails_when_skill_exists() {
        let _guard = EnvGuard::new("skill-exists");
        let source = write_skill_source("brand-kit");
        let req = folder_request(&source, &["shared"], false);
        install_inner(req).expect("first install should succeed");

        let req_again = folder_request(&source, &["shared"], false);
        let result = install_inner(req_again);
        let _ = fs::remove_dir_all(&source);

        assert_eq!(result.unwrap_err(), "skill_exists");
    }

    #[test]
    fn install_with_overwrite_replaces_existing_skill() {
        let _guard = EnvGuard::new("overwrite");
        let source = write_skill_source("motion-kit");
        install_inner(folder_request(&source, &["shared"], false)).expect("first install");

        // Change the source contents so the overwrite is observable.
        fs::write(source.join("extra.txt"), "new file").unwrap();
        let result = install_inner(folder_request(&source, &["shared"], true));
        let _ = fs::remove_dir_all(&source);

        let summary = result.expect("overwrite install should succeed");
        let dest = PathBuf::from(&summary.resolved_path);
        assert!(dest.join("extra.txt").is_file());
    }

    #[test]
    fn install_sanitizes_unsafe_characters_in_name() {
        let _guard = EnvGuard::new("sanitize-name");
        let parent = unique_temp_dir("sanitize-parent");
        let source = parent.join("My Skill!! 2024");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join(SKILL_FILE), "---\nname: x\n---\nbody").unwrap();

        let summary = install_inner(folder_request(&source, &["shared"], false)).expect("install");
        let _ = fs::remove_dir_all(&parent);

        assert_eq!(summary.name, "MySkill2024");
    }

    #[test]
    fn install_rejects_a_name_that_sanitizes_to_empty() {
        let _guard = EnvGuard::new("sanitize-empty");
        let parent = unique_temp_dir("sanitize-empty-parent");
        let source = parent.join("!!!");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join(SKILL_FILE), "body").unwrap();

        let result = install_inner(folder_request(&source, &["shared"], false));
        let _ = fs::remove_dir_all(&parent);

        assert_eq!(result.unwrap_err(), "invalid_name");
    }

    #[test]
    #[cfg(unix)]
    fn install_rejects_a_symlink_that_escapes_the_source_root() {
        let _guard = EnvGuard::new("confined-copy");
        let source = write_skill_source("escape-test");
        let outside = unique_temp_dir("escape-target");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("secret.txt"), "leaked").unwrap();
        std::os::unix::fs::symlink(&outside, source.join("escape")).unwrap();

        let result = install_inner(folder_request(&source, &["shared"], false));
        let _ = fs::remove_dir_all(&source);
        let _ = fs::remove_dir_all(&outside);

        assert_eq!(result.unwrap_err(), "outside_root");
    }

    #[test]
    fn install_writes_lock_info() {
        let _guard = EnvGuard::new("lock-info");
        let source = write_skill_source("lockable");
        install_inner(folder_request(&source, &["shared"], false)).expect("install");
        let _ = fs::remove_dir_all(&source);

        let lock = lock_info("lockable").expect("lock entry should exist");
        assert_eq!(lock.source.as_deref(), Some("folder"));
        assert!(lock.installed_at.is_some());
        assert!(lock.updated_at.is_some());
    }

    #[test]
    fn install_creates_agent_link_when_requested() {
        let _guard = EnvGuard::new("agent-link");
        let source = write_skill_source("linked-skill");
        let summary =
            install_inner(folder_request(&source, &["shared", "claude"], false)).expect("install");
        let _ = fs::remove_dir_all(&source);

        let claude_root = root_for("claude").unwrap();
        let link_path = claude_root.join("linked-skill");
        assert!(is_link(&link_path), "expected a link at {link_path:?}");
        assert_eq!(resolve(&link_path), PathBuf::from(&summary.resolved_path));
    }

    #[test]
    fn install_rejects_unknown_agent() {
        let _guard = EnvGuard::new("unknown-agent");
        let source = write_skill_source("agent-check");
        let result = install_inner(folder_request(&source, &["shared", "bogus"], false));
        let _ = fs::remove_dir_all(&source);

        assert_eq!(result.unwrap_err(), "unknown_agent");
    }

    fn init_git_repo_with_skill(dir: &Path) {
        fs::create_dir_all(dir).unwrap();
        Command::new("git")
            .current_dir(dir)
            .args(["init", "-q", "-b", "main"])
            .output()
            .expect("git init");
        fs::write(dir.join(SKILL_FILE), "---\nname: cloned\n---\nbody").unwrap();
        Command::new("git")
            .current_dir(dir)
            .args(["add", "."])
            .output()
            .expect("git add");
        Command::new("git")
            .current_dir(dir)
            .args([
                "-c",
                "user.email=test@example.com",
                "-c",
                "user.name=Flashwork Test",
                "commit",
                "-q",
                "-m",
                "init",
            ])
            .output()
            .expect("git commit");
    }

    #[test]
    fn install_from_git_clones_default_branch() {
        let _guard = EnvGuard::new("git-install");
        let repo = unique_temp_dir("git-repo");
        init_git_repo_with_skill(&repo);
        let canonical_repo = fs::canonicalize(&repo).unwrap();
        let url = format!("file://{}", canonical_repo.display());

        let req = SkillInstallRequest {
            source: SkillInstallSource::Git { url, spec: None },
            agents: vec!["shared".to_string()],
            overwrite: false,
        };
        let result = install_inner(req);
        let _ = fs::remove_dir_all(&repo);

        let summary = result.expect("git install should succeed");
        assert_eq!(
            summary.name,
            canonical_repo.file_name().unwrap().to_string_lossy()
        );
        let lock = lock_info(&summary.name).expect("lock entry for git install");
        assert_eq!(lock.source.as_deref(), Some("git"));
    }
}
