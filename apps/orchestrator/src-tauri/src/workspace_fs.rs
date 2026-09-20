use serde::Serialize;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

const PATH_ESCAPE: &str = "path_escape";
const FILE_TOO_LARGE: &str = "file_too_large";
const MAX_READ_BYTES: u64 = 2 * 1024 * 1024;
const IGNORED_NAMES: &[&str] = &[".git", "node_modules", "target", "dist"];
const IGNORED_PREFIXES: &[&str] = &[".flashwork/rag"];

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntry {
    name: String,
    rel: String,
    is_dir: bool,
}

fn normalize_lexically(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                let _ = out.pop();
            }
            Component::CurDir => {}
            Component::Prefix(_) | Component::RootDir | Component::Normal(_) => {
                out.push(component.as_os_str());
            }
        }
    }
    out
}

fn is_within(root: &Path, candidate: &Path) -> bool {
    candidate.starts_with(root)
}

fn posix_rel(rel: &Path) -> String {
    rel.to_string_lossy().replace('\\', "/")
}

fn is_ignored_rel(rel: &str) -> bool {
    if rel.is_empty() {
        return false;
    }
    let normalized = rel.replace('\\', "/");
    if normalized
        .split('/')
        .any(|part| !part.is_empty() && IGNORED_NAMES.contains(&part))
    {
        return true;
    }
    IGNORED_PREFIXES
        .iter()
        .any(|prefix| normalized == *prefix || normalized.starts_with(&format!("{prefix}/")))
}

fn is_rooted(path: &Path) -> bool {
    path.is_absolute() || path.has_root()
}

fn confined_target(root: &str, rel: &str) -> Result<PathBuf, String> {
    let root_raw = PathBuf::from(root.trim());
    if root_raw.as_os_str().is_empty() {
        return Err("empty root".into());
    }

    let rel_path = PathBuf::from(rel.trim());
    let joined = if is_rooted(&rel_path) {
        rel_path
    } else {
        root_raw.join(rel_path)
    };

    let lex_root = normalize_lexically(&root_raw);
    let lex_joined = normalize_lexically(&joined);
    if lex_root.as_os_str().is_empty() || !is_within(&lex_root, &lex_joined) {
        return Err(PATH_ESCAPE.into());
    }

    let canonical_root = fs::canonicalize(&root_raw).map_err(|error| error.to_string())?;
    if !canonical_root.is_dir() {
        return Err("root is not a directory".into());
    }

    match fs::canonicalize(&joined) {
        Ok(canonical) => {
            if !is_within(&canonical_root, &canonical) {
                return Err(PATH_ESCAPE.into());
            }
            Ok(canonical)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            let parent = joined.parent().ok_or_else(|| PATH_ESCAPE.to_string())?;
            let canonical_parent = match fs::canonicalize(parent) {
                Ok(path) => path,
                Err(parent_error) if parent_error.kind() == ErrorKind::NotFound => {
                    return Err("parent directory not found".into());
                }
                Err(parent_error) => return Err(parent_error.to_string()),
            };
            if !is_within(&canonical_root, &canonical_parent) {
                return Err(PATH_ESCAPE.into());
            }
            let name = joined.file_name().ok_or_else(|| PATH_ESCAPE.to_string())?;
            if matches!(name.to_str(), Some(".") | Some("..")) {
                return Err(PATH_ESCAPE.into());
            }
            Ok(canonical_parent.join(name))
        }
        Err(error) => Err(error.to_string()),
    }
}

fn read_file(root: &str, path: &str) -> Result<String, String> {
    let target = confined_target(root, path)?;
    let metadata = fs::metadata(&target).map_err(|error| {
        if error.kind() == ErrorKind::NotFound {
            "file not found".to_string()
        } else {
            error.to_string()
        }
    })?;
    if !metadata.is_file() {
        return Err("file not found".into());
    }
    if metadata.len() > MAX_READ_BYTES {
        return Err(FILE_TOO_LARGE.into());
    }
    fs::read_to_string(&target).map_err(|error| error.to_string())
}

fn write_file(root: &str, rel: &str, contents: &str) -> Result<(), String> {
    let target = confined_target(root, rel)?;
    if let Ok(metadata) = fs::symlink_metadata(&target) {
        if metadata.is_dir() {
            return Err("path is a directory".into());
        }
    }
    fs::write(&target, contents).map_err(|error| error.to_string())
}

fn list_dir(root: &str, rel: &str) -> Result<Vec<WorkspaceEntry>, String> {
    let target = confined_target(root, rel)?;
    if !target.is_dir() {
        return Err("directory not found".into());
    }

    let canonical_root = fs::canonicalize(root.trim()).map_err(|error| error.to_string())?;
    let listed_rel = posix_rel(
        target
            .strip_prefix(&canonical_root)
            .map_err(|_| PATH_ESCAPE.to_string())?,
    );
    if is_ignored_rel(&listed_rel) {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for entry in fs::read_dir(&target).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let child_rel = if listed_rel.is_empty() {
            name.clone()
        } else {
            format!("{listed_rel}/{name}")
        };
        if is_ignored_rel(&child_rel) {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        entries.push(WorkspaceEntry {
            name,
            rel: child_rel,
            is_dir: file_type.is_dir(),
        });
    }

    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[tauri::command]
pub fn workspace_list(root: String, rel: String) -> Result<Vec<WorkspaceEntry>, String> {
    list_dir(&root, &rel)
}

#[tauri::command]
pub fn workspace_read(root: String, rel: String) -> Result<String, String> {
    read_file(&root, &rel)
}

#[tauri::command]
pub fn workspace_write(root: String, rel: String, contents: String) -> Result<(), String> {
    write_file(&root, &rel, &contents)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn read_refuses_path_outside_root() {
        let err = read_file("/tmp/root", "/etc/passwd").unwrap_err();
        assert!(err.contains("path_escape"));
    }

    #[test]
    fn list_skips_node_modules_and_flashwork_rag() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("node_modules/pkg")).unwrap();
        fs::write(root.join("node_modules/pkg/index.js"), "x").unwrap();
        fs::create_dir_all(root.join(".flashwork/rag")).unwrap();
        fs::write(root.join(".flashwork/rag/blob.bin"), [0u8; 16]).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/main.rs"), "fn main() {}").unwrap();
        fs::write(root.join("README.md"), "hi").unwrap();

        let root_s = root.to_string_lossy().into_owned();
        let entries = list_dir(&root_s, "").unwrap();
        let names: Vec<_> = entries.iter().map(|entry| entry.name.as_str()).collect();
        assert!(
            !names.contains(&"node_modules"),
            "root list should skip node_modules, got {names:?}"
        );
        assert!(names.contains(&"src"));
        assert!(names.contains(&"README.md"));
        assert!(names.contains(&".flashwork"));

        let nested = list_dir(&root_s, ".flashwork").unwrap();
        let nested_names: Vec<_> = nested.iter().map(|entry| entry.name.as_str()).collect();
        assert!(
            !nested_names.contains(&"rag"),
            ".flashwork list should skip rag, got {nested_names:?}"
        );

        let src = list_dir(&root_s, "src").unwrap();
        assert!(
            src.iter()
                .any(|entry| entry.rel == "src/main.rs" && !entry.is_dir),
            "listed files should use root-relative paths, got {src:?}"
        );
    }

    #[test]
    fn write_then_read_roundtrip_under_root() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        write_file(&root, "note.txt", "hello workspace").unwrap();
        let contents = read_file(&root, "note.txt").unwrap();
        assert_eq!(contents, "hello workspace");
    }

    #[test]
    fn relative_parent_escape_is_path_escape() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        fs::write(dir.path().join("inside.txt"), "ok").unwrap();
        let err = read_file(&root, "../outside.txt").unwrap_err();
        assert!(err.contains("path_escape"));
        let err = write_file(&root, "../escape.txt", "nope").unwrap_err();
        assert!(err.contains("path_escape"));
    }

    #[test]
    fn file_larger_than_two_mib_is_file_too_large() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let oversized = 2 * 1024 * 1024 + 1;
        fs::write(dir.path().join("big.txt"), vec![b'a'; oversized]).unwrap();
        let err = read_file(&root, "big.txt").unwrap_err();
        assert!(err.contains("file_too_large"));
    }

    #[cfg(unix)]
    #[test]
    fn symlink_escape_is_path_escape() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let secret = outside.path().join("secret.txt");
        fs::write(&secret, "classified").unwrap();
        std::os::unix::fs::symlink(&secret, dir.path().join("link.txt")).unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let err = read_file(&root, "link.txt").unwrap_err();
        assert!(err.contains("path_escape"));
    }
}
