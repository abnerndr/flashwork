//! Read-only view of a repository's `.planning/` directory (status.md, task.md, plan.md).
//!
//! Used by the scheduler to load roadmap items and detect completion.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlanningStatus {
    pub has_planning: bool,
    pub reported_complete: bool,
    pub progress: Option<u8>,
    pub roadmap_pending_count: Option<usize>,
    pub roadmap_total_count: Option<usize>,

    /// (`flashwork-gsd-state.ts`) com o plano passo a passo, incluindo o

    /// exibir (ex.: dividir em linhas pro checklist do Briefing de Testes).
    pub notes: Option<String>,
}

/// Parse de `status.md`: linhas `Status: <valor>` / `Progress: <pct>%`.

/// (`Status: In Progress` + `Progress: 100%` esquecido) seja lido como
/// completo por engano.
fn parse_status_md(content: &str) -> (Option<String>, Option<u8>) {
    let mut status = None;
    let mut progress = None;
    for line in content.lines() {
        let Some((key, val)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_lowercase();
        let val = val.trim().trim_matches('"').trim_matches('\'');
        match key.as_str() {
            "status" => status = Some(val.to_lowercase()),
            "progress" => progress = val.trim_end_matches('%').trim().parse::<u8>().ok(),
            _ => {}
        }
    }
    (status, progress)
}

fn is_complete_status(status: &str) -> bool {
    matches!(status, "completed" | "complete" | "done")
}

/// Um item de checklist markdown (`- [ ] texto`/`- [x] texto`), com o texto

pub(crate) struct RoadmapItem {
    pub checked: bool,
    pub text: String,
}

pub(crate) fn parse_roadmap_items(content: &str) -> Vec<RoadmapItem> {
    let mut items = Vec::new();
    for line in content.lines() {
        let trimmed = line
            .trim_start()
            .trim_start_matches('-')
            .trim_start_matches('*')
            .trim();
        if let Some(rest) = trimmed.strip_prefix('[') {
            if let Some(mark) = rest.chars().next() {
                if rest.as_bytes().get(1) == Some(&b']') {
                    let text = rest[2..].trim().to_string();
                    items.push(RoadmapItem {
                        checked: mark != ' ',
                        text,
                    });
                }
            }
        }
    }
    items
}

/// Conta checkboxes markdown — wrapper fino sobre `parse_roadmap_items`.
fn count_roadmap_checkboxes(content: &str) -> (usize, usize) {
    let items = parse_roadmap_items(content);
    let total = items.len();
    let pending = items.iter().filter(|item| !item.checked).count();
    (pending, total)
}

pub(crate) fn compute_planning_status(worktree_root: &Path) -> PlanningStatus {
    let planning_dir = worktree_root.join(".planning");
    if !planning_dir.is_dir() {
        return PlanningStatus::default();
    }

    let status_content = std::fs::read_to_string(planning_dir.join("status.md")).ok();
    let task_content = std::fs::read_to_string(planning_dir.join("task.md")).ok();
    let plan_content = std::fs::read_to_string(planning_dir.join("plan.md")).ok();

    let (roadmap_pending_count, roadmap_total_count) = match &task_content {
        Some(content) if !content.trim().is_empty() => {
            let (pending, total) = count_roadmap_checkboxes(content);
            (Some(pending), Some(total))
        }
        _ => (None, None),
    };

    let notes = plan_content
        .map(|c| c.trim().to_string())
        .filter(|c| !c.is_empty());

    let Some(status_content) = status_content.filter(|c| !c.trim().is_empty()) else {
        let reported_complete =
            roadmap_total_count.unwrap_or(0) > 0 && roadmap_pending_count == Some(0);
        return PlanningStatus {
            has_planning: true,
            reported_complete,
            progress: None,
            roadmap_pending_count,
            roadmap_total_count,
            notes,
        };
    };

    let (status, progress) = parse_status_md(&status_content);
    let reported_complete = match status {
        Some(s) => is_complete_status(&s),
        None => progress == Some(100),
    };

    PlanningStatus {
        has_planning: true,
        reported_complete,
        progress,
        roadmap_pending_count,
        roadmap_total_count,
        notes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("flashwork-planning-gate-{label}-{suffix}"));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn no_planning_dir_means_not_started() {
        let root = temp_dir("no-planning");
        let status = compute_planning_status(&root);
        assert!(!status.has_planning);
        assert!(!status.reported_complete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn planning_dir_without_status_or_task_is_incomplete() {
        let root = temp_dir("empty-planning");
        fs::create_dir_all(root.join(".planning")).unwrap();
        let status = compute_planning_status(&root);
        assert!(status.has_planning);
        assert!(!status.reported_complete);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn status_md_complete_status_wins() {
        let root = temp_dir("status-complete");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("status.md"),
            "Status: Completed\nProgress: 100%\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(status.reported_complete);
        assert_eq!(status.progress, Some(100));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn status_md_status_overrides_conflicting_progress() {
        let root = temp_dir("status-conflict");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("status.md"),
            "Status: In Progress\nProgress: 100%\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(
            !status.reported_complete,
            "status desatualizado não pode vencer sobre progress esquecido em 100"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn task_fallback_when_status_md_missing() {
        let root = temp_dir("task-fallback");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("task.md"),
            "- [x] task 1\n- [x] task 2\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(status.reported_complete);
        assert_eq!(status.roadmap_pending_count, Some(0));
        assert_eq!(status.roadmap_total_count, Some(2));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn task_with_pending_items_is_reported_and_not_complete() {
        let root = temp_dir("task-pending");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("task.md"),
            "- [x] done 1\n- [ ] pending 1\n- [x] done 2\n- [ ] pending 2\n- [x] done 3\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(!status.reported_complete);
        assert_eq!(status.roadmap_pending_count, Some(2));
        assert_eq!(status.roadmap_total_count, Some(5));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notes_extracted_from_plan_md() {
        let root = temp_dir("plan-notes");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("plan.md"),
            "1. Criar o arquivo.\n2. Validar sua existência.\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        let notes = status.notes.expect("notes deveria estar presente");
        assert!(notes.contains("Criar o arquivo"));
        assert!(notes.contains("Validar sua existência"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn notes_is_none_when_plan_md_missing_or_empty() {
        let root = temp_dir("plan-no-notes");
        fs::create_dir_all(root.join(".planning")).unwrap();
        fs::write(
            root.join(".planning").join("status.md"),
            "Status: Completed\n",
        )
        .unwrap();
        let status = compute_planning_status(&root);
        assert!(status.notes.is_none());
        fs::remove_dir_all(root).unwrap();
    }
}
