use serde::Serialize;
use std::fs::{self, File};
use std::io::{self, ErrorKind, Read, Write};
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

fn is_symlink_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

fn path_is_symlink(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| is_symlink_or_reparse(&metadata))
        .unwrap_or(false)
}

fn confined_join(root: &str, rel: &str) -> Result<(PathBuf, PathBuf), String> {
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

    Ok((canonical_root, joined))
}

fn confined_unfollowed_leaf(canonical_root: &Path, joined: &Path) -> Result<PathBuf, String> {
    let parent = joined.parent().ok_or_else(|| PATH_ESCAPE.to_string())?;
    let canonical_parent = match fs::canonicalize(parent) {
        Ok(path) => path,
        Err(parent_error) if parent_error.kind() == ErrorKind::NotFound => {
            return Err("parent directory not found".into());
        }
        Err(parent_error) => return Err(parent_error.to_string()),
    };
    if !is_within(canonical_root, &canonical_parent) {
        return Err(PATH_ESCAPE.into());
    }
    let name = joined.file_name().ok_or_else(|| PATH_ESCAPE.to_string())?;
    if matches!(name.to_str(), Some(".") | Some("..")) {
        return Err(PATH_ESCAPE.into());
    }
    Ok(canonical_parent.join(name))
}

/// Resolve `rel` under `root` without following a leaf symlink out of the project.
pub(crate) fn confined_target(root: &str, rel: &str) -> Result<PathBuf, String> {
    let (canonical_root, joined) = confined_join(root, rel)?;

    match fs::canonicalize(&joined) {
        Ok(canonical) => {
            if !is_within(&canonical_root, &canonical) {
                return Err(PATH_ESCAPE.into());
            }
            Ok(canonical)
        }
        Err(error) if error.kind() == ErrorKind::NotFound => {
            if path_is_symlink(&joined) {
                return Err(PATH_ESCAPE.into());
            }
            Ok(confined_unfollowed_leaf(&canonical_root, &joined)?)
        }
        Err(error) => Err(error.to_string()),
    }
}

fn read_text_capped<R: Read>(reader: R, max_bytes: u64) -> Result<String, String> {
    let mut limited = reader.take(max_bytes.saturating_add(1));
    let mut buf = Vec::new();
    limited
        .read_to_end(&mut buf)
        .map_err(|error| error.to_string())?;
    if buf.len() as u64 > max_bytes {
        return Err(FILE_TOO_LARGE.into());
    }
    String::from_utf8(buf).map_err(|error| error.to_string())
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
    let file = File::open(&target).map_err(|error| error.to_string())?;
    read_text_capped(file, MAX_READ_BYTES)
}

#[cfg(unix)]
fn write_bytes_no_follow(path: &Path, contents: &[u8]) -> Result<(), String> {
    use std::os::unix::fs::OpenOptionsExt;
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    // O_NOFOLLOW: Linux/Android 0x20000, macOS/BSD 0x100.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const O_NOFOLLOW: i32 = 0x20000;
    #[cfg(any(
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd",
        target_os = "dragonfly"
    ))]
    const O_NOFOLLOW: i32 = 0x0100;
    #[cfg(not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd",
        target_os = "dragonfly"
    )))]
    const O_NOFOLLOW: i32 = 0;
    opts.custom_flags(O_NOFOLLOW);
    let mut file = match opts.open(path) {
        Ok(file) => file,
        Err(error) => {
            if path_is_symlink(path) || is_loop_error(&error) {
                return Err(PATH_ESCAPE.into());
            }
            return Err(error.to_string());
        }
    };
    file.write_all(contents).map_err(|error| error.to_string())
}

#[cfg(unix)]
fn is_loop_error(error: &io::Error) -> bool {
    error.raw_os_error() == Some(libc_eloop())
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn libc_eloop() -> i32 {
    40
}

#[cfg(any(
    target_os = "macos",
    target_os = "ios",
    target_os = "freebsd",
    target_os = "netbsd",
    target_os = "openbsd",
    target_os = "dragonfly"
))]
fn libc_eloop() -> i32 {
    62
}

#[cfg(all(
    unix,
    not(any(
        target_os = "linux",
        target_os = "android",
        target_os = "macos",
        target_os = "ios",
        target_os = "freebsd",
        target_os = "netbsd",
        target_os = "openbsd",
        target_os = "dragonfly"
    ))
))]
fn libc_eloop() -> i32 {
    -1
}

#[cfg(windows)]
fn write_bytes_no_follow(path: &Path, contents: &[u8]) -> Result<(), String> {
    // TOCTOU: symlink_metadata then fs::write can race with a reparse-point swap.
    // Opening with FILE_FLAG_OPEN_REPARSE_POINT needs a CreateFileW rewrite; skip for now.
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if is_symlink_or_reparse(&metadata) {
            return Err(PATH_ESCAPE.into());
        }
        if metadata.is_dir() {
            return Err("path is a directory".into());
        }
    }
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn write_file(root: &str, rel: &str, contents: &str) -> Result<(), String> {
    let (canonical_root, joined) = confined_join(root, rel)?;
    if path_is_symlink(&joined) {
        return Err(PATH_ESCAPE.into());
    }
    let leaf = confined_unfollowed_leaf(&canonical_root, &joined)?;
    if path_is_symlink(&leaf) {
        return Err(PATH_ESCAPE.into());
    }
    if let Ok(metadata) = fs::symlink_metadata(&leaf) {
        if metadata.is_dir() {
            return Err("path is a directory".into());
        }
    }
    write_bytes_no_follow(&leaf, contents.as_bytes())
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

    #[test]
    fn capped_read_errors_when_stream_exceeds_limit() {
        let data = vec![b'x'; 16];
        let err = read_text_capped(data.as_slice(), 8).unwrap_err();
        assert!(err.contains("file_too_large"));
        assert_eq!(read_text_capped(b"hello".as_slice(), 8).unwrap(), "hello");
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
        let err = write_file(&root, "link.txt", "pwned").unwrap_err();
        assert!(
            err.contains("path_escape"),
            "write through an outside symlink must be path_escape, got {err}"
        );
        assert_eq!(fs::read_to_string(&secret).unwrap(), "classified");
    }

    #[cfg(unix)]
    #[test]
    fn write_refuses_dangling_symlink_outside_root() {
        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let outside_file = outside.path().join("escaped.txt");
        assert!(!outside_file.exists());
        std::os::unix::fs::symlink(&outside_file, dir.path().join("link.txt")).unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let err = write_file(&root, "link.txt", "pwned").unwrap_err();
        assert!(
            err.contains("path_escape"),
            "dangling symlink write must be path_escape, got {err}"
        );
        assert!(
            !outside_file.exists(),
            "write must not create the dangling symlink target outside the root"
        );
    }

    #[cfg(unix)]
    #[test]
    fn write_refuses_symlink_even_when_target_is_inside_root() {
        let dir = tempfile::tempdir().unwrap();
        let inside = dir.path().join("real.txt");
        fs::write(&inside, "original").unwrap();
        std::os::unix::fs::symlink(&inside, dir.path().join("link.txt")).unwrap();
        let root = dir.path().to_string_lossy().into_owned();
        let err = write_file(&root, "link.txt", "rewritten").unwrap_err();
        assert!(
            err.contains("path_escape"),
            "write through an inside symlink must be path_escape, got {err}"
        );
        assert_eq!(fs::read_to_string(&inside).unwrap(), "original");
    }
}
