use std::env;
use std::fs;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

/// Resolves `~/<segments>`: `USERPROFILE` first on Windows, `HOME` first
/// everywhere else. Under WSL, `WSLENV` may export the Windows `USERPROFILE`
/// into Linux, and preferring it there would read the Windows agents' data.
pub(crate) fn provider_home_dir(segments: &[&str]) -> Option<PathBuf> {
    let home = home_from(env::var_os("USERPROFILE"), env::var_os("HOME"), cfg!(windows))?;
    Some(segments.iter().fold(home, |acc, seg| acc.join(seg)))
}

fn home_from(
    user_profile: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
    windows: bool,
) -> Option<PathBuf> {
    let (first, second) = if windows { (user_profile, home) } else { (home, user_profile) };
    first
        .filter(|v| !v.is_empty())
        .or(second.filter(|v| !v.is_empty()))
        .map(PathBuf::from)
}

/// Provider data dir that holds the sessions of `cwd`, plus the cwd spelled the
/// way that provider recorded it. A project inside a WSL distro (Windows build)
/// is run by the distro's CLI, so its data lives in the distro user's home and
/// its cwd is the Linux path. Best effort: falls back to the Windows home.
pub(crate) fn provider_home_for_cwd(cwd: &str, segments: &[&str]) -> Option<(PathBuf, String)> {
    if let Some(target) = crate::wsl::wsl_target_for_cwd(Some(cwd)) {
        if let Some(dir) = crate::wsl::distro_home_dir(&target.distro, segments) {
            return Some((dir, target.linux_path));
        }
    }
    provider_home_dir(segments).map(|dir| (dir, cwd.to_string()))
}

pub(crate) fn file_modified_ms(metadata: &fs::Metadata) -> u128 {
    metadata
        .modified()
        .ok()
        .and_then(|m| m.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

pub(crate) fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub(crate) fn normalize_cwd(cwd: &str) -> String {
    let trimmed = cwd.trim().trim_end_matches(|c: char| c == '\\' || c == '/');
    if cfg!(windows) {
        trimmed.replace('/', "\\").to_ascii_lowercase()
    } else {
        trimmed.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn now_ms_is_nonzero() {
        assert!(now_ms() > 0);
    }

    #[test]
    fn home_prefers_userprofile_only_on_windows() {
        let up = Some(std::ffi::OsString::from("C:/Users/u"));
        let home = Some(std::ffi::OsString::from("/home/u"));
        assert_eq!(home_from(up.clone(), home.clone(), true), Some(PathBuf::from("C:/Users/u")));
        assert_eq!(home_from(up.clone(), home.clone(), false), Some(PathBuf::from("/home/u")));
        assert_eq!(home_from(up, None, false), Some(PathBuf::from("C:/Users/u")));
        assert_eq!(home_from(Some("".into()), home, true), Some(PathBuf::from("/home/u")));
    }

    #[test]
    fn normalize_cwd_trims_trailing_separators() {
        assert_eq!(normalize_cwd("C:/foo/bar/"), normalize_cwd("C:/foo/bar"));
    }
}
