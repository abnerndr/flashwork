use chrono::Utc;
use nanoid::nanoid;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

const HARNESS_GUIDE: &str = "This folder is a Flashwork project. Use `rag/` for project knowledge and `history/` for task, flow, and run history.\n";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHomeMeta {
    pub id: String,
    pub created_at: String,
    pub schema_version: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RagGraphifyStatus {
    Exists,
    Unavailable,
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RagStatus {
    pub graphify: RagGraphifyStatus,
    pub ai_memory: bool,
    pub updated_at: String,
}

fn path_metadata(path: &Path) -> Result<Option<fs::Metadata>, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => Ok(Some(metadata)),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn resolved_project_home(folder: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = fs::canonicalize(folder).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("project folder is not a directory".into());
    }

    let home = root.join(".flashwork");
    if let Some(metadata) = path_metadata(&home)? {
        if metadata.file_type().is_symlink() {
            return Err("project home escapes the project folder".into());
        }
        if !metadata.is_dir() {
            return Err("project home is not a directory".into());
        }
        let resolved_home = fs::canonicalize(&home).map_err(|error| error.to_string())?;
        if !resolved_home.starts_with(&root) {
            return Err("project home escapes the project folder".into());
        }
        Ok((root, resolved_home))
    } else {
        Ok((root, home))
    }
}

fn ensure_directory(path: &Path, home: &Path) -> Result<(), String> {
    let relative = path
        .strip_prefix(home)
        .map_err(|_| "project home path escapes .flashwork".to_string())?;
    let mut current = home.to_path_buf();

    for component in relative.components() {
        current.push(component);
        match path_metadata(&current)? {
            Some(metadata) => {
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("project home path escapes .flashwork".into());
                }
            }
            None => {
                fs::create_dir(&current).map_err(|error| error.to_string())?;
                let metadata = fs::symlink_metadata(&current).map_err(|error| error.to_string())?;
                if metadata.file_type().is_symlink() || !metadata.is_dir() {
                    return Err("project home path escapes .flashwork".into());
                }
            }
        }
    }

    Ok(())
}

fn write_if_missing(path: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(metadata) = path_metadata(path)? {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("project home file is not a regular file".into());
        }
        return Ok(());
    }
    fs::write(path, content).map_err(|error| error.to_string())
}

fn write_project_file(home: &Path, project_id: &str) -> Result<(), String> {
    let metadata = ProjectHomeMeta {
        id: project_id.to_owned(),
        created_at: Utc::now().to_rfc3339(),
        schema_version: 1,
    };
    let content = serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?;
    let project_file = home.join("project.json");
    if let Some(metadata) = path_metadata(&project_file)? {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("project home file is not a regular file".into());
        }
        return Err("project home project.json already exists".into());
    }
    let tmp = project_file.with_extension("json.tmp");
    if path_metadata(&tmp)?.is_some() {
        return Err("project home temporary file already exists".into());
    }
    fs::write(&tmp, content).map_err(|error| error.to_string())?;
    fs::rename(&tmp, &project_file).map_err(|error| error.to_string())
}

fn fill_project_home(home: &Path, project_id: &str, write_metadata: bool) -> Result<(), String> {
    for directory in [
        home.join("harness"),
        home.join("rag"),
        home.join("history/tasks"),
        home.join("history/flows"),
        home.join("history/runs"),
    ] {
        ensure_directory(&directory, home)?;
    }

    write_if_missing(&home.join("harness/AGENTS.md"), HARNESS_GUIDE.as_bytes())?;
    write_if_missing(&home.join("harness/tools.default.json"), b"{}\n")?;
    write_if_missing(&home.join("rag/.gitkeep"), b"")?;
    write_if_missing(
        &home.join("rag/graphify.json"),
        b"{\n  \"root\": \"..\"\n}\n",
    )?;

    if write_metadata {
        write_project_file(home, project_id)?;
    }
    Ok(())
}

struct StagingHome {
    path: PathBuf,
    published: bool,
}

impl Drop for StagingHome {
    fn drop(&mut self) {
        if !self.published {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn read_project_meta(home: &Path) -> Result<ProjectHomeMeta, String> {
    let home_metadata =
        path_metadata(home)?.ok_or_else(|| "project home is missing".to_string())?;
    if home_metadata.file_type().is_symlink() || !home_metadata.is_dir() {
        return Err("project home is not a regular directory".into());
    }

    let project_file = home.join("project.json");
    let file_metadata = path_metadata(&project_file)?
        .ok_or_else(|| "project home project.json is missing".to_string())?;
    if file_metadata.file_type().is_symlink() || !file_metadata.is_file() {
        return Err("project home project.json is not a regular file".into());
    }

    let content = fs::read_to_string(&project_file)
        .map_err(|error| format!("project home project.json is unreadable: {error}"))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("project home project.json is invalid: {error}"))
}

fn use_published_home(home: &Path, project_id: &str) -> Result<PathBuf, String> {
    let published = read_project_meta(home).map_err(|error| {
        format!("project home appeared during bootstrap but could not be used: {error}")
    })?;
    if published.id == project_id {
        return Ok(home.to_path_buf());
    }
    Err(format!(
        "flashwork_exists: project home belongs to {}",
        published.id
    ))
}

fn with_staged_home<F>(
    root: &Path,
    home: &Path,
    project_id: &str,
    populate: F,
) -> Result<PathBuf, String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let staging_path = root.join(format!(".flashwork.tmp-{}", nanoid!()));
    fs::create_dir(&staging_path).map_err(|error| error.to_string())?;
    let mut staging = StagingHome {
        path: staging_path,
        published: false,
    };

    populate(&staging.path)?;
    if path_metadata(home)?.is_some() {
        return use_published_home(home, project_id);
    }
    if let Err(rename_error) = fs::rename(&staging.path, home) {
        if path_metadata(home)?.is_some() {
            return use_published_home(home, project_id);
        }
        return Err(format!("project home publish failed: {rename_error}"));
    }
    staging.published = true;
    Ok(home.to_path_buf())
}

pub fn detect(folder: &str) -> Option<ProjectHomeMeta> {
    let (_, home) = resolved_project_home(folder).ok()?;
    read_project_meta(&home).ok()
}

pub fn bootstrap(folder: &str, project_id: &str) -> Result<PathBuf, String> {
    let (root, home) = resolved_project_home(folder)?;
    if path_metadata(&home)?.is_none() {
        return with_staged_home(&root, &home, project_id, |staging| {
            fill_project_home(staging, project_id, true)
        });
    }

    let project_file = home.join("project.json");
    match path_metadata(&project_file)? {
        Some(file_metadata) => {
            if file_metadata.file_type().is_symlink() || !file_metadata.is_file() {
                return Err("project home file is not a regular file".into());
            }
            let content = fs::read_to_string(&project_file).map_err(|error| error.to_string())?;
            let existing: ProjectHomeMeta =
                serde_json::from_str(&content).map_err(|error| error.to_string())?;
            if existing.id != project_id {
                return Err(format!(
                    "flashwork_exists: project home belongs to {}",
                    existing.id
                ));
            }
            fill_project_home(&home, project_id, false)?;
        }
        None => {
            return Err(
                "flashwork_incomplete: project home exists without a regular project.json".into(),
            );
        }
    }

    Ok(home)
}

fn write_atomic_regular_file(path: &Path, content: &[u8]) -> Result<(), String> {
    if let Some(metadata) = path_metadata(path)? {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("rag STATUS.json is not a regular file".into());
        }
    }

    let tmp = path.with_extension("json.tmp");
    if let Some(metadata) = path_metadata(&tmp)? {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err("rag STATUS.json temporary file is not a regular file".into());
        }
        fs::remove_file(&tmp).map_err(|error| error.to_string())?;
    }

    fs::write(&tmp, content).map_err(|error| error.to_string())?;
    #[cfg(windows)]
    if path_metadata(path)?.is_some() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(error.to_string());
    }
    Ok(())
}

pub fn write_rag_status(folder: &str, status: &RagStatus) -> Result<PathBuf, String> {
    let (_, home) = resolved_project_home(folder)?;
    let home_metadata =
        path_metadata(&home)?.ok_or_else(|| "project home is missing".to_string())?;
    if home_metadata.file_type().is_symlink() || !home_metadata.is_dir() {
        return Err("project home is not a regular directory".into());
    }

    let rag = home.join("rag");
    ensure_directory(&rag, &home)?;

    let status_file = rag.join("STATUS.json");
    let content = serde_json::to_vec_pretty(status).map_err(|error| error.to_string())?;
    write_atomic_regular_file(&status_file, &content)?;
    Ok(status_file)
}

#[tauri::command]
pub fn project_bootstrap(folder: String, project_id: String) -> Result<PathBuf, String> {
    bootstrap(&folder, &project_id)
}

#[tauri::command]
pub fn project_detect(folder: String) -> Option<ProjectHomeMeta> {
    detect(&folder)
}

#[tauri::command]
pub fn project_write_rag_status(folder: String, status: RagStatus) -> Result<PathBuf, String> {
    write_rag_status(&folder, &status)
}

#[cfg(test)]
mod tests {
    use std::fs;

    #[test]
    fn bootstrap_creates_flashwork_tree() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let home = crate::project_home::bootstrap(&folder, "proj_test").unwrap();
        assert!(home.join("project.json").is_file());
        assert!(home.join("harness").is_dir());
        assert!(home.join("rag").is_dir());
        assert!(home.join("history/tasks").is_dir());
        assert!(!home.join("rag/STATUS.json").exists());
    }

    #[test]
    fn write_rag_status_writes_regular_json_under_rag() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let home = crate::project_home::bootstrap(&folder, "proj_test").unwrap();
        let path = crate::project_home::write_rag_status(
            &folder,
            &crate::project_home::RagStatus {
                graphify: crate::project_home::RagGraphifyStatus::Unavailable,
                ai_memory: false,
                updated_at: "2026-09-19T05:00:00Z".into(),
            },
        )
        .unwrap();

        assert_eq!(path, home.join("rag/STATUS.json"));
        assert!(path.is_file());
        assert!(!path.symlink_metadata().unwrap().file_type().is_symlink());

        let value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(value["graphify"], "unavailable");
        assert_eq!(value["aiMemory"], false);
        assert_eq!(value["updatedAt"], "2026-09-19T05:00:00Z");
        assert_eq!(value.as_object().unwrap().len(), 3);
    }

    #[test]
    fn bootstrap_refuses_when_foreign_project_id_exists() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        crate::project_home::bootstrap(&folder, "aaa").unwrap();
        let err = crate::project_home::bootstrap(&folder, "bbb").unwrap_err();
        assert!(err.contains("flashwork_exists"));
    }

    #[test]
    fn bootstrap_is_idempotent_for_same_id() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        crate::project_home::bootstrap(&folder, "aaa").unwrap();
        crate::project_home::bootstrap(&folder, "aaa").unwrap();
    }

    #[test]
    fn bootstrap_refuses_incomplete_existing_project_home() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let home = dir.path().join(".flashwork");
        fs::create_dir(&home).unwrap();

        let error = crate::project_home::bootstrap(&folder, "aaa").unwrap_err();

        assert!(error.contains("flashwork_incomplete"));
        assert!(!home.join("project.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn bootstrap_does_not_follow_history_symlink_outside_project_home() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let home = crate::project_home::bootstrap(&folder, "aaa").unwrap();
        fs::remove_dir_all(home.join("history")).unwrap();
        symlink(outside.path(), home.join("history")).unwrap();

        let error = crate::project_home::bootstrap(&folder, "aaa").unwrap_err();

        assert!(error.contains("escapes .flashwork"));
        assert!(!outside.path().join("tasks").exists());
        assert!(!outside.path().join("flows").exists());
        assert!(!outside.path().join("runs").exists());
    }

    #[test]
    fn failed_staging_is_not_published_as_project_home() {
        let dir = tempfile::tempdir().unwrap();
        let root = fs::canonicalize(dir.path()).unwrap();
        let home = root.join(".flashwork");

        let result = super::with_staged_home(&root, &home, "aaa", |staging| {
            fs::write(staging.join("partial"), b"partial").unwrap();
            Err("injected failure".into())
        });

        assert_eq!(result.unwrap_err(), "injected failure");
        assert!(!home.exists());
        assert!(fs::read_dir(&root).unwrap().next().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn detect_refuses_symlinked_project_file() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let home = crate::project_home::bootstrap(&folder, "aaa").unwrap();
        let outside_file = outside.path().join("project.json");
        fs::write(
            &outside_file,
            br#"{"id":"outside","createdAt":"secret","schemaVersion":1}"#,
        )
        .unwrap();
        fs::remove_file(home.join("project.json")).unwrap();
        symlink(&outside_file, home.join("project.json")).unwrap();

        assert_eq!(crate::project_home::detect(&folder), None);
    }

    #[test]
    fn bootstrap_rejects_directory_where_default_file_is_expected() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let home = crate::project_home::bootstrap(&folder, "aaa").unwrap();
        fs::remove_file(home.join("harness/AGENTS.md")).unwrap();
        fs::create_dir(home.join("harness/AGENTS.md")).unwrap();

        let error = crate::project_home::bootstrap(&folder, "aaa").unwrap_err();

        assert!(error.contains("not a regular file"));
    }
}
