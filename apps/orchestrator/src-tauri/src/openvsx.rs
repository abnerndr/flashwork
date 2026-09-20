use std::collections::BTreeMap;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use zip::ZipArchive;

const OPEN_VSX_API: &str = "https://open-vsx.org/api";
const SEARCH_TIMEOUT: Duration = Duration::from_secs(8);
const DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_CACHED_QUERIES: usize = 20;
const MAX_EXTRACT_UNCOMPRESSED_BYTES: u64 = 32 * 1024 * 1024;
const PATH_ESCAPE: &str = "path_escape";
const EXTENSION_INCOMPATIBLE: &str = "extension_incompatible";
const OPENVSX_MALFORMED: &str = "openvsx_malformed";
const OPENVSX_TOO_LARGE: &str = "openvsx_too_large";
const FORBIDDEN_CONTRIBUTES: &[&str] = &[
    "debuggers",
    "views",
    "viewsContainers",
    "customEditors",
    "terminal",
    "walkthroughs",
    "notebooks",
];
const ALLOWED_CONTRIBUTES: &[&str] = &[
    "themes",
    "grammars",
    "languages",
    "languageServer",
    "language-server",
    "semanticTokenScopes",
];

static SEARCH_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
static DOWNLOAD_CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

fn search_client() -> &'static reqwest::Client {
    SEARCH_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(SEARCH_TIMEOUT)
            .user_agent(concat!("Flashwork/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

fn download_client() -> &'static reqwest::Client {
    DOWNLOAD_CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .timeout(DOWNLOAD_TIMEOUT)
            .user_agent(concat!("Flashwork/", env!("CARGO_PKG_VERSION")))
            .build()
            .unwrap_or_default()
    })
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenVsxHit {
    pub namespace: String,
    pub name: String,
    pub display_name: String,
    pub description: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OpenVsxPage {
    pub extensions: Vec<OpenVsxHit>,
    /// Set when the network failed and this page came from the on-disk copy.
    pub stale_since: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledExtension {
    pub id: String,
    pub namespace: String,
    pub name: String,
    pub display_name: String,
    pub version: String,
    pub description: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedPage {
    fetched_at: u64,
    page: OpenVsxPage,
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchCache {
    #[serde(default)]
    queries: BTreeMap<String, CachedPage>,
}

fn cache_file(dir: &Path) -> PathBuf {
    dir.join("openvsx").join("search-cache.json")
}

fn read_search_cache(dir: &Path) -> SearchCache {
    fs::read_to_string(cache_file(dir))
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn write_search_cache(dir: &Path, cache: &SearchCache) {
    let path = cache_file(dir);
    if let Some(parent) = path.parent() {
        if fs::create_dir_all(parent).is_err() {
            return;
        }
    }
    if let Ok(raw) = serde_json::to_string(cache) {
        let _ = fs::write(path, raw);
    }
}

fn remember_query(cache: &mut SearchCache, key: String, page: OpenVsxPage, fetched_at: u64) {
    cache.queries.insert(
        key,
        CachedPage {
            fetched_at,
            page: OpenVsxPage {
                stale_since: None,
                ..page
            },
        },
    );
    while cache.queries.len() > MAX_CACHED_QUERIES {
        if let Some(oldest) = cache
            .queries
            .iter()
            .min_by_key(|(_, entry)| entry.fetched_at)
            .map(|(name, _)| name.clone())
        {
            cache.queries.remove(&oldest);
        } else {
            break;
        }
    }
}

fn stale_page(cache: &SearchCache, key: &str) -> Option<OpenVsxPage> {
    cache.queries.get(key).map(|entry| OpenVsxPage {
        stale_since: Some(entry.fetched_at),
        ..entry.page.clone()
    })
}

fn contributes_present(contributes: &Value, key: &str) -> bool {
    match contributes.get(key) {
        Some(Value::Array(items)) => !items.is_empty(),
        Some(Value::Object(map)) => !map.is_empty(),
        Some(Value::Bool(true)) => true,
        Some(Value::String(text)) => !text.trim().is_empty(),
        _ => false,
    }
}

fn extension_kind_only_ui(pkg: &Value) -> bool {
    match pkg.get("extensionKind") {
        Some(Value::String(kind)) => kind == "ui",
        Some(Value::Array(items)) => {
            !items.is_empty() && items.iter().all(|item| item.as_str() == Some("ui"))
        }
        _ => false,
    }
}

fn has_main_without_browser(pkg: &Value) -> bool {
    let main = pkg
        .get("main")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let browser = pkg
        .get("browser")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    main.is_some() && browser.is_none()
}

fn classify_package(pkg: &Value) -> Result<(), String> {
    let contributes = pkg.get("contributes").cloned().unwrap_or(Value::Null);
    if FORBIDDEN_CONTRIBUTES
        .iter()
        .any(|key| contributes_present(&contributes, key))
    {
        return Err(EXTENSION_INCOMPATIBLE.into());
    }
    if extension_kind_only_ui(pkg) {
        return Err(EXTENSION_INCOMPATIBLE.into());
    }
    let allowed = ALLOWED_CONTRIBUTES
        .iter()
        .any(|key| contributes_present(&contributes, key));
    if allowed {
        return Ok(());
    }
    if has_main_without_browser(pkg) {
        return Err(EXTENSION_INCOMPATIBLE.into());
    }
    Err(EXTENSION_INCOMPATIBLE.into())
}

fn is_safe_segment(segment: &str) -> bool {
    let trimmed = segment.trim();
    if trimmed.is_empty() || trimmed == "." || trimmed == ".." {
        return false;
    }
    if trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
    {
        return false;
    }
    if Path::new(trimmed).is_absolute() {
        return false;
    }
    trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-')
}

fn extension_id(namespace: &str, name: &str) -> Result<String, String> {
    if !is_safe_segment(namespace) || !is_safe_segment(name) {
        return Err(PATH_ESCAPE.into());
    }
    Ok(format!("{}.{}", namespace.trim(), name.trim()))
}

fn parse_extension_id(id: &str) -> Result<(String, String), String> {
    let trimmed = id.trim();
    let (namespace, name) = trimmed
        .split_once('.')
        .ok_or_else(|| PATH_ESCAPE.to_string())?;
    let id = extension_id(namespace, name)?;
    let (namespace, name) = id.split_once('.').ok_or_else(|| PATH_ESCAPE.to_string())?;
    Ok((namespace.to_string(), name.to_string()))
}

fn ensure_confined_dir(root: &str, rel: &str) -> Result<PathBuf, String> {
    let target = crate::workspace_fs::confined_target(root, rel)?;
    match fs::create_dir(&target) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    let target = crate::workspace_fs::confined_target(root, rel)?;
    if !target.is_dir() {
        return Err(PATH_ESCAPE.into());
    }
    Ok(target)
}

fn confine_extensions_tree(root: &str) -> Result<PathBuf, String> {
    ensure_confined_dir(root, ".flashwork")?;
    ensure_confined_dir(root, ".flashwork/extensions")
}

fn extensions_root(root: &str) -> Result<PathBuf, String> {
    let _flashwork = crate::workspace_fs::confined_target(root, ".flashwork")?;
    crate::workspace_fs::confined_target(root, ".flashwork/extensions")
}

fn install_dir(root: &str, namespace: &str, name: &str) -> Result<PathBuf, String> {
    let id = extension_id(namespace, name)?;
    let flashwork = crate::workspace_fs::confined_target(root, ".flashwork")?;
    let rel = format!(".flashwork/extensions/{id}");
    match crate::workspace_fs::confined_target(root, &rel) {
        Ok(path) => Ok(path),
        Err(err) if err == "parent directory not found" => {
            Ok(flashwork.join("extensions").join(id))
        }
        Err(err) => Err(err),
    }
}

fn package_from_dir(dir: &Path) -> Option<Value> {
    let candidates = [
        dir.join("extension").join("package.json"),
        dir.join("package.json"),
    ];
    for path in candidates {
        if let Ok(raw) = fs::read_to_string(path) {
            if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                return Some(value);
            }
        }
    }
    None
}

fn installed_from_dir(dir: &Path) -> Option<InstalledExtension> {
    let pkg = package_from_dir(dir)?;
    let folder = dir.file_name()?.to_str()?.to_string();
    let (namespace, name) = parse_extension_id(&folder).ok().or_else(|| {
        let publisher = pkg
            .get("publisher")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let ext_name = pkg.get("name").and_then(Value::as_str).unwrap_or_default();
        Some((publisher.to_string(), ext_name.to_string()))
    })?;
    let id = extension_id(&namespace, &name).ok()?;
    Some(InstalledExtension {
        display_name: pkg
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(&name)
            .to_string(),
        version: pkg
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        description: pkg
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        path: dir.to_string_lossy().replace('\\', "/"),
        id,
        namespace,
        name,
    })
}

fn hit_from(value: &Value) -> Option<OpenVsxHit> {
    let namespace = value.get("namespace")?.as_str()?.trim().to_string();
    let name = value.get("name")?.as_str()?.trim().to_string();
    if namespace.is_empty() || name.is_empty() {
        return None;
    }
    Some(OpenVsxHit {
        display_name: value
            .get("displayName")
            .and_then(Value::as_str)
            .unwrap_or(&name)
            .to_string(),
        description: value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        version: value
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        namespace,
        name,
    })
}

fn page_from(body: &Value) -> OpenVsxPage {
    let extensions = body
        .get("extensions")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(hit_from).collect())
        .unwrap_or_default();
    OpenVsxPage {
        extensions,
        stale_since: None,
    }
}

async fn fetch_search(query: &str) -> Result<OpenVsxPage, String> {
    let response = search_client()
        .get(format!("{OPEN_VSX_API}/-/search"))
        .query(&[("query", query), ("size", "20"), ("offset", "0")])
        .send()
        .await
        .map_err(|_| "openvsx_offline".to_string())?;
    if !response.status().is_success() {
        return Err(format!("openvsx_status:{}", response.status().as_u16()));
    }
    let body: Value = response
        .json()
        .await
        .map_err(|_| OPENVSX_MALFORMED.to_string())?;
    Ok(page_from(&body))
}

fn package_json_from_zip<R: Read + io::Seek>(archive: &mut ZipArchive<R>) -> Result<Value, String> {
    let mut chosen: Option<usize> = None;
    for index in 0..archive.len() {
        let name = archive
            .by_index(index)
            .map_err(|error| error.to_string())?
            .name()
            .replace('\\', "/");
        if name == "extension/package.json" {
            chosen = Some(index);
            break;
        }
        if name.ends_with("/package.json") && chosen.is_none() {
            chosen = Some(index);
        }
        if name == "package.json" && chosen.is_none() {
            chosen = Some(index);
        }
    }
    let index = chosen.ok_or_else(|| OPENVSX_MALFORMED.to_string())?;
    let mut file = archive.by_index(index).map_err(|error| error.to_string())?;
    let mut raw = String::new();
    file.read_to_string(&mut raw)
        .map_err(|error| error.to_string())?;
    serde_json::from_str(&raw).map_err(|_| OPENVSX_MALFORMED.to_string())
}

fn extract_zip_into(dest: &Path, vsix: &Path, max_uncompressed: u64) -> Result<(), String> {
    let file = fs::File::open(vsix).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
    let mut total: u64 = 0;
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let Some(enclosed) = entry.enclosed_name() else {
            continue;
        };
        let out = dest.join(enclosed);
        if !out.starts_with(dest) {
            return Err(PATH_ESCAPE.into());
        }
        if entry.is_dir() {
            fs::create_dir_all(&out).map_err(|error| error.to_string())?;
            continue;
        }
        if total >= max_uncompressed || entry.size() > max_uncompressed.saturating_sub(total) {
            return Err(OPENVSX_TOO_LARGE.into());
        }
        if let Some(parent) = out.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut target = fs::File::create(&out).map_err(|error| error.to_string())?;
        let budget = max_uncompressed.saturating_sub(total);
        let mut limited = Read::take(&mut entry, budget.saturating_add(1));
        let copied = io::copy(&mut limited, &mut target).map_err(|error| error.to_string())?;
        total = total.saturating_add(copied);
        if total > max_uncompressed {
            return Err(OPENVSX_TOO_LARGE.into());
        }
    }
    Ok(())
}

fn confine_rel_prefixes(root: &str, rel: &str) -> Result<PathBuf, String> {
    let mut acc = String::new();
    let mut last = None;
    for part in rel.split(['/', '\\']).filter(|part| !part.is_empty()) {
        if acc.is_empty() {
            acc.push_str(part);
        } else {
            acc.push('/');
            acc.push_str(part);
        }
        last = Some(crate::workspace_fs::confined_target(root, &acc)?);
    }
    last.ok_or_else(|| PATH_ESCAPE.to_string())
}

fn extract_zip(root: &str, dest_rel: &str, vsix: &Path) -> Result<(), String> {
    let dest = confine_rel_prefixes(root, dest_rel)?;
    match fs::create_dir(&dest) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    let dest = crate::workspace_fs::confined_target(root, dest_rel)?;
    if !dest.is_dir() {
        return Err(PATH_ESCAPE.into());
    }
    let extracted = extract_zip_into(&dest, vsix, MAX_EXTRACT_UNCOMPRESSED_BYTES);
    if extracted.is_err() {
        remove_dir_if_exists(&dest);
    }
    extracted
}

fn replace_dir_atomic(dest: &Path, staging: &Path) -> Result<(), String> {
    let backup = dest.with_file_name(format!(
        ".{}.old",
        dest.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("extension")
    ));
    if backup.exists() {
        fs::remove_dir_all(&backup).map_err(|error| error.to_string())?;
    }
    let had_dest = dest.exists();
    if had_dest {
        fs::rename(dest, &backup).map_err(|error| error.to_string())?;
    }
    if let Err(error) = fs::rename(staging, dest) {
        if had_dest {
            let _ = fs::rename(&backup, dest);
        }
        return Err(error.to_string());
    }
    if had_dest {
        let _ = fs::remove_dir_all(&backup);
    }
    Ok(())
}

fn remove_dir_if_exists(path: &Path) {
    if path.exists() {
        let _ = fs::remove_dir_all(path);
    }
}

async fn download_vsix(namespace: &str, name: &str, dest: &Path) -> Result<(), String> {
    let meta_url = format!(
        "{OPEN_VSX_API}/{}/{}/latest",
        urlencoding::encode(namespace),
        urlencoding::encode(name)
    );
    let meta: Value = download_client()
        .get(&meta_url)
        .send()
        .await
        .map_err(|_| "openvsx_offline".to_string())?
        .error_for_status()
        .map_err(|error| {
            if error.is_status() {
                format!(
                    "openvsx_status:{}",
                    error.status().map(|status| status.as_u16()).unwrap_or(0)
                )
            } else {
                "openvsx_offline".to_string()
            }
        })?
        .json()
        .await
        .map_err(|_| OPENVSX_MALFORMED.to_string())?;

    let download = meta
        .get("files")
        .and_then(|files| files.get("download"))
        .and_then(Value::as_str)
        .filter(|url| url.starts_with("https://open-vsx.org/"))
        .ok_or_else(|| "openvsx_no_download".to_string())?;

    let bytes = download_client()
        .get(download)
        .send()
        .await
        .map_err(|_| "openvsx_offline".to_string())?
        .error_for_status()
        .map_err(|_| "openvsx_offline".to_string())?
        .bytes()
        .await
        .map_err(|_| "openvsx_offline".to_string())?;

    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(dest, bytes).map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn openvsx_search(app: tauri::AppHandle, query: String) -> Result<OpenVsxPage, String> {
    let key = query.trim().to_ascii_lowercase();
    match fetch_search(query.trim()).await {
        Ok(page) => {
            let handle = app.clone();
            let cached = page.clone();
            let key = key.clone();
            let _ = tokio::task::spawn_blocking(move || {
                let Ok(dir) = crate::paths::profile_data_dir(&handle) else {
                    return;
                };
                let mut cache = read_search_cache(&dir);
                remember_query(&mut cache, key, cached, crate::provider_common::now_ms());
                write_search_cache(&dir, &cache);
            })
            .await;
            Ok(page)
        }
        Err(error) => {
            let handle = app.clone();
            let cached = tokio::task::spawn_blocking(move || {
                crate::paths::profile_data_dir(&handle)
                    .ok()
                    .and_then(|dir| stale_page(&read_search_cache(&dir), &key))
            })
            .await
            .map_err(|_| error.clone())?;
            match cached {
                Some(page) => Ok(page),
                None => Err(error),
            }
        }
    }
}

#[tauri::command]
pub fn extensions_list(root: String) -> Result<Vec<InstalledExtension>, String> {
    let dir = match extensions_root(&root) {
        Ok(path) => path,
        Err(_) => return Ok(Vec::new()),
    };
    if !dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut installed = Vec::new();
    let entries = fs::read_dir(&dir).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') {
            continue;
        }
        if let Some(item) = installed_from_dir(&path) {
            installed.push(item);
        }
    }
    installed.sort_by(|left, right| left.id.cmp(&right.id));
    Ok(installed)
}

#[tauri::command]
pub async fn extensions_install(
    root: String,
    namespace: String,
    name: String,
) -> Result<InstalledExtension, String> {
    let id = extension_id(&namespace, &name)?;
    confine_extensions_tree(&root)?;
    let dest_rel = format!(".flashwork/extensions/{id}");
    let staging_rel = format!(".flashwork/extensions/.{id}.staging");
    let dest = crate::workspace_fs::confined_target(&root, &dest_rel)?;
    let staging = crate::workspace_fs::confined_target(&root, &staging_rel)?;
    let vsix = std::env::temp_dir().join(format!("flashwork-{id}.vsix"));
    download_vsix(namespace.trim(), name.trim(), &vsix).await?;

    let vsix_for_task = vsix.clone();
    let staging_for_task = staging.clone();
    let dest_for_task = dest.clone();
    let root_for_task = root.clone();
    let staging_rel_for_task = staging_rel.clone();
    let result = tokio::task::spawn_blocking(move || {
        remove_dir_if_exists(&staging_for_task);
        let file = fs::File::open(&vsix_for_task).map_err(|error| error.to_string())?;
        let mut archive = ZipArchive::new(file).map_err(|error| error.to_string())?;
        let pkg = package_json_from_zip(&mut archive)?;
        classify_package(&pkg)?;
        drop(archive);
        extract_zip(&root_for_task, &staging_rel_for_task, &vsix_for_task)?;
        if let Err(error) =
            classify_package(&package_from_dir(&staging_for_task).unwrap_or(Value::Null))
        {
            remove_dir_if_exists(&staging_for_task);
            return Err(error);
        }
        replace_dir_atomic(&dest_for_task, &staging_for_task)?;
        remove_dir_if_exists(&staging_for_task);
        installed_from_dir(&dest_for_task).ok_or_else(|| OPENVSX_MALFORMED.to_string())
    })
    .await
    .map_err(|error| error.to_string());

    let _ = fs::remove_file(&vsix);
    match result {
        Ok(Ok(installed)) => Ok(installed),
        Ok(Err(error)) => {
            remove_dir_if_exists(&staging);
            Err(error)
        }
        Err(error) => {
            remove_dir_if_exists(&staging);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn extensions_uninstall(root: String, id: String) -> Result<(), String> {
    let (namespace, name) = parse_extension_id(&id)?;
    let dest = install_dir(&root, &namespace, &name)?;
    if dest.exists() {
        fs::remove_dir_all(&dest).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn classifies_theme_extension_as_compatible() {
        let pkg = json!({
            "name": "theme",
            "contributes": {
                "themes": [{ "label": "Dark", "uiTheme": "vs-dark", "path": "./theme.json" }]
            }
        });
        assert!(classify_package(&pkg).is_ok());
    }

    #[test]
    fn classifies_debugger_extension_as_incompatible() {
        let pkg = json!({
            "name": "debug",
            "contributes": {
                "debuggers": [{ "type": "node" }]
            }
        });
        let err = classify_package(&pkg).expect_err("debugger must be refused");
        assert!(
            err.contains(EXTENSION_INCOMPATIBLE),
            "expected extension_incompatible, got {err}"
        );
    }

    #[test]
    fn install_path_stays_under_root() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let root = tmp.path();
        let dest = install_dir(root.to_str().unwrap(), "redhat", "vscode-yaml").expect("dest");
        assert!(dest.starts_with(root.join(".flashwork").join("extensions")));
        assert_eq!(
            dest.file_name().and_then(|name| name.to_str()),
            Some("redhat.vscode-yaml")
        );

        let escaped = install_dir(root.to_str().unwrap(), "..", "evil");
        assert!(
            escaped
                .as_ref()
                .err()
                .map(|err| err.contains(PATH_ESCAPE))
                .unwrap_or(false),
            "expected path_escape for `..` namespace, got {escaped:?}"
        );

        let nested = install_dir(root.to_str().unwrap(), "foo/bar", "ext");
        assert!(
            nested
                .as_ref()
                .err()
                .map(|err| err.contains(PATH_ESCAPE))
                .unwrap_or(false),
            "expected path_escape for slash in namespace, got {nested:?}"
        );

        let dotted = install_dir(root.to_str().unwrap(), "a..b", "ext");
        assert!(
            dotted
                .as_ref()
                .err()
                .map(|err| err.contains(PATH_ESCAPE))
                .unwrap_or(false),
            "expected path_escape for `..` inside namespace, got {dotted:?}"
        );
    }

    #[test]
    fn search_cache_round_trips_in_a_temp_dir() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let mut cache = SearchCache::default();
        let page = OpenVsxPage {
            extensions: vec![OpenVsxHit {
                namespace: "pkief".into(),
                name: "material-icon-theme".into(),
                display_name: "Material Icon Theme".into(),
                description: "icons".into(),
                version: "5.0.0".into(),
            }],
            stale_since: None,
        };
        remember_query(&mut cache, "theme".into(), page.clone(), 100);
        write_search_cache(tmp.path(), &cache);

        let loaded = read_search_cache(tmp.path());
        assert_eq!(loaded.queries.len(), 1);
        let stale = stale_page(&loaded, "theme").expect("cached");
        assert_eq!(stale.stale_since, Some(100));
        assert_eq!(stale.extensions, page.extensions);

        for index in 0..MAX_CACHED_QUERIES {
            remember_query(
                &mut cache,
                format!("q{index}"),
                OpenVsxPage {
                    extensions: Vec::new(),
                    stale_since: None,
                },
                200 + index as u64,
            );
        }
        assert_eq!(cache.queries.len(), MAX_CACHED_QUERIES);
        assert!(!cache.queries.contains_key("theme"));
    }

    #[test]
    fn theme_with_main_stays_compatible() {
        let pkg = json!({
            "main": "./out/extension.js",
            "contributes": { "themes": [{ "label": "Dark" }] }
        });
        assert!(classify_package(&pkg).is_ok());
    }

    #[test]
    fn ui_only_extension_kind_is_incompatible() {
        let pkg = json!({
            "extensionKind": ["ui"],
            "contributes": { "themes": [{ "label": "Dark" }] }
        });
        // Forbidden kind wins even if a theme is present? Spec: refuse if extensionKind is only "ui".
        let err = classify_package(&pkg).expect_err("ui-only");
        assert!(err.contains(EXTENSION_INCOMPATIBLE));
    }

    fn write_zip(path: &Path, files: &[(&str, &[u8])]) {
        use std::io::Write;
        use zip::write::FileOptions;
        use zip::{CompressionMethod, ZipWriter};

        let file = fs::File::create(path).expect("zip file");
        let mut zip = ZipWriter::new(file);
        let opts = FileOptions::default().compression_method(CompressionMethod::Deflated);
        for (name, bytes) in files {
            zip.start_file(*name, opts).expect("start zip entry");
            zip.write_all(bytes).expect("write zip entry");
        }
        zip.finish().expect("finish zip");
    }

    #[test]
    fn missing_package_json_is_malformed() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let vsix = tmp.path().join("empty.vsix");
        write_zip(&vsix, &[("extension/readme.md", b"no package json")]);
        let file = fs::File::open(&vsix).expect("open vsix");
        let mut archive = ZipArchive::new(file).expect("zip");
        let err = package_json_from_zip(&mut archive).expect_err("missing package.json");
        assert!(
            err.contains(OPENVSX_MALFORMED),
            "expected openvsx_malformed, got {err}"
        );
        assert!(
            !err.contains(EXTENSION_INCOMPATIBLE),
            "missing package.json must not toast as Electron-only, got {err}"
        );
    }

    #[test]
    fn extract_refuses_when_uncompressed_exceeds_cap() {
        assert_eq!(MAX_EXTRACT_UNCOMPRESSED_BYTES, 32 * 1024 * 1024);
        let tmp = tempfile::tempdir().expect("tempdir");
        let vsix = tmp.path().join("huge.vsix");
        let payload = vec![0u8; 128];
        write_zip(&vsix, &[("extension/blob.bin", &payload)]);
        let dest = tmp.path().join("out");
        fs::create_dir(&dest).expect("dest");
        let err = extract_zip_into(&dest, &vsix, 64).expect_err("over cap");
        assert!(
            err.contains(OPENVSX_TOO_LARGE),
            "expected openvsx_too_large, got {err}"
        );
        assert!(
            !dest.join("extension").join("blob.bin").exists()
                || fs::metadata(dest.join("extension").join("blob.bin"))
                    .map(|meta| meta.len() <= 65)
                    .unwrap_or(true),
            "extract must stop streaming once the uncompressed cap is exceeded"
        );
    }

    #[cfg(unix)]
    #[test]
    fn install_refuses_flashwork_symlink_outside_root() {
        let root_dir = tempfile::tempdir().expect("root");
        let outside = tempfile::tempdir().expect("outside");
        let root = root_dir.path();
        std::os::unix::fs::symlink(outside.path(), root.join(".flashwork")).expect("symlink");
        let marker = outside.path().join("pwned.txt");
        let vsix = root.join("theme.vsix");
        write_zip(
            &vsix,
            &[(
                "extension/package.json",
                br#"{"name":"theme","contributes":{"themes":[{}]}}"#,
            )],
        );

        let root_s = root.to_str().expect("utf8 root");
        let tree_err = confine_extensions_tree(root_s).expect_err("tree");
        assert!(
            tree_err.contains(PATH_ESCAPE),
            "expected path_escape from confine_extensions_tree, got {tree_err}"
        );

        let dest_err = install_dir(root_s, "ns", "ext").expect_err("install_dir");
        assert!(
            dest_err.contains(PATH_ESCAPE),
            "expected path_escape from install_dir, got {dest_err}"
        );

        let extract_err = extract_zip(root_s, ".flashwork/extensions/ns.ext", &vsix)
            .expect_err("extract");
        assert!(
            extract_err.contains(PATH_ESCAPE),
            "expected path_escape from extract, got {extract_err}"
        );

        assert!(
            !marker.exists(),
            "install must not create files outside the project"
        );
        assert!(
            !outside.path().join("extensions").exists(),
            "a planted .flashwork symlink must not receive extracted files"
        );
    }
}
