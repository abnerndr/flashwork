use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

const HARNESS_GUIDE: &str = "This folder is a Flashwork project. Use `rag/` for project knowledge and `history/` for task, flow, and run history.\n";

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProjectHomeMeta {
    pub id: String,
    pub created_at: String,
    pub schema_version: u32,
}

fn resolved_project_home(folder: &str) -> Result<(PathBuf, PathBuf), String> {
    let root = fs::canonicalize(folder).map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("project folder is not a directory".into());
    }

    let home = root.join(".flashwork");
    if home.exists() {
        let metadata = fs::symlink_metadata(&home).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("project home escapes the project folder".into());
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
    if path.exists() {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("project home path escapes .flashwork".into());
        }
    }
    fs::create_dir_all(path).map_err(|error| error.to_string())?;
    let resolved = fs::canonicalize(path).map_err(|error| error.to_string())?;
    if !resolved.starts_with(home) {
        return Err("project home path escapes .flashwork".into());
    }
    Ok(())
}

fn write_if_missing(path: &Path, content: &[u8]) -> Result<(), String> {
    if path.exists() {
        let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
        if metadata.file_type().is_symlink() {
            return Err("project home file escapes .flashwork".into());
        }
        return Ok(());
    }
    fs::write(path, content).map_err(|error| error.to_string())
}

pub fn detect(folder: &str) -> Option<ProjectHomeMeta> {
    let (_, home) = resolved_project_home(folder).ok()?;
    let content = fs::read_to_string(home.join("project.json")).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn bootstrap(folder: &str, project_id: &str) -> Result<PathBuf, String> {
    let (root, home) = resolved_project_home(folder)?;
    fs::create_dir_all(&home).map_err(|error| error.to_string())?;
    let home = fs::canonicalize(&home).map_err(|error| error.to_string())?;
    if !home.starts_with(&root) {
        return Err("project home escapes the project folder".into());
    }

    let project_file = home.join("project.json");
    if project_file.exists() {
        let file_metadata =
            fs::symlink_metadata(&project_file).map_err(|error| error.to_string())?;
        if file_metadata.file_type().is_symlink() {
            return Err("project home file escapes .flashwork".into());
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
    } else {
        let metadata = ProjectHomeMeta {
            id: project_id.to_owned(),
            created_at: Utc::now().to_rfc3339(),
            schema_version: 1,
        };
        let content = serde_json::to_vec_pretty(&metadata).map_err(|error| error.to_string())?;
        let tmp = project_file.with_extension("json.tmp");
        if tmp.exists() {
            let tmp_metadata = fs::symlink_metadata(&tmp).map_err(|error| error.to_string())?;
            if tmp_metadata.file_type().is_symlink() {
                return Err("project home file escapes .flashwork".into());
            }
        }
        fs::write(&tmp, content).map_err(|error| error.to_string())?;
        fs::rename(&tmp, &project_file).map_err(|error| error.to_string())?;
    }

    for directory in [
        home.join("harness"),
        home.join("rag"),
        home.join("history/tasks"),
        home.join("history/flows"),
        home.join("history/runs"),
    ] {
        ensure_directory(&directory, &home)?;
    }

    write_if_missing(&home.join("harness/AGENTS.md"), HARNESS_GUIDE.as_bytes())?;
    write_if_missing(&home.join("harness/tools.default.json"), b"{}\n")?;
    write_if_missing(&home.join("rag/.gitkeep"), b"")?;
    write_if_missing(
        &home.join("rag/graphify.json"),
        b"{\n  \"root\": \"..\"\n}\n",
    )?;

    Ok(home)
}

#[tauri::command]
pub fn project_bootstrap(folder: String, project_id: String) -> Result<PathBuf, String> {
    bootstrap(&folder, &project_id)
}

#[tauri::command]
pub fn project_detect(folder: String) -> Option<ProjectHomeMeta> {
    detect(&folder)
}

#[cfg(test)]
mod tests {
    #[test]
    fn bootstrap_creates_flashwork_tree() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().to_string_lossy().to_string();
        let home = crate::project_home::bootstrap(&folder, "proj_test").unwrap();
        assert!(home.join("project.json").is_file());
        assert!(home.join("harness").is_dir());
        assert!(home.join("rag").is_dir());
        assert!(home.join("history/tasks").is_dir());
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
}
