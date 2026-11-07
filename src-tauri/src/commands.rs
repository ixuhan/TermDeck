use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};
use uuid::Uuid;

use crate::models::{DetectedShell, HistoryEntry, SessionInfo, ShellProfile};
use crate::workspace::{read_with_backup, write_atomic};
use crate::AppState;

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- sessions

#[tauri::command]
pub fn create_session(
    app: AppHandle,
    app_state: State<'_, AppState>,
    profile: ShellProfile,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<SessionInfo, String> {
    let id = format!("sess_{}", Uuid::new_v4().simple());
    crate::logging::info(format!(
        "create_session -> {} ({})",
        profile.name, profile.executable
    ));
    app_state
        .pty
        .spawn(app, id, &profile, cols.unwrap_or(120), rows.unwrap_or(30))
        .map_err(|e| {
            crate::logging::warn(format!("create_session error: {e}"));
            e.to_string()
        })
}

#[tauri::command]
pub fn write_pty(
    app_state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    app_state
        .pty
        .write(&session_id, &data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn resize_pty(
    app_state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    app_state
        .pty
        .resize(&session_id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn kill_session(app_state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    app_state.pty.kill(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn session_alive(app_state: State<'_, AppState>, session_id: String) -> bool {
    app_state.pty.has(&session_id)
}

/// Replays output the shell produced before the UI was listening (FR-STATE /
/// spawn race), then flips the session to live streaming.
#[tauri::command]
pub fn pty_attach(app_state: State<'_, AppState>, session_id: String) -> String {
    app_state.pty.attach(&session_id)
}

// ----------------------------------------------------------------- history

#[tauri::command]
pub fn history_add(
    app_state: State<'_, AppState>,
    session_id: String,
    command: String,
    cwd: Option<String>,
    max_entries: Option<usize>,
    mask: Option<bool>,
) -> Result<(), String> {
    app_state
        .history
        .add(
            &session_id,
            &command,
            cwd.as_deref(),
            now_ms(),
            max_entries.unwrap_or(5000),
            mask.unwrap_or(true),
        )
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_prefix(
    app_state: State<'_, AppState>,
    session_id: String,
    prefix: String,
) -> Result<Option<String>, String> {
    app_state
        .history
        .prefix(&session_id, &prefix)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_search(
    app_state: State<'_, AppState>,
    session_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<HistoryEntry>, String> {
    app_state
        .history
        .search(&session_id, &query, limit.unwrap_or(50))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_clear(app_state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    app_state
        .history
        .clear(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_recent(
    app_state: State<'_, AppState>,
    session_id: String,
    limit: Option<usize>,
) -> Result<Vec<String>, String> {
    app_state
        .history
        .recent(&session_id, limit.unwrap_or(100))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_commands(
    app_state: State<'_, AppState>,
    session_id: String,
) -> Result<Vec<String>, String> {
    app_state
        .history
        .all_commands(&session_id)
        .map_err(|e| e.to_string())
}

// --------------------------------------------------------------- workspace

#[tauri::command]
pub fn workspace_load(app_state: State<'_, AppState>) -> Option<String> {
    let found = read_with_backup(&app_state.paths.state());
    crate::logging::info(format!(
        "workspace_load -> {}",
        if found.is_some() { "hit" } else { "miss" }
    ));
    found
}

#[tauri::command]
pub fn workspace_save(app_state: State<'_, AppState>, json: String) -> Result<(), String> {
    match write_atomic(&app_state.paths.state(), &json) {
        Ok(()) => {
            crate::logging::info(format!("workspace_save ok ({} bytes)", json.len()));
            Ok(())
        }
        Err(e) => {
            crate::logging::warn(format!("workspace_save failed: {e}"));
            Err(e.to_string())
        }
    }
}

#[tauri::command]
pub fn presets_load(app_state: State<'_, AppState>) -> Option<String> {
    read_with_backup(&app_state.paths.presets())
}

#[tauri::command]
pub fn presets_save(app_state: State<'_, AppState>, json: String) -> Result<(), String> {
    write_atomic(&app_state.paths.presets(), &json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn settings_load(app_state: State<'_, AppState>) -> Option<String> {
    read_with_backup(&app_state.paths.settings())
}

#[tauri::command]
pub fn settings_save(app_state: State<'_, AppState>, json: String) -> Result<(), String> {
    write_atomic(&app_state.paths.settings(), &json).map_err(|e| e.to_string())
}

/// Distinguishes a normal install from the portable folder layout.
///
/// The updater must not run in a portable copy: it would install into
/// `%LOCALAPPDATA%` and leave the user with two copies, one of them stale.
// ------------------------------------------------------------------ scrollback
//
// Screen contents are stored as the ANSI-serialized xterm buffer. Replaying it
// restores colours and layout; the data is display-only and never interpreted
// as input.

/// Keeps the newest output: the tail is what the user was looking at.
const MAX_SCROLLBACK_BYTES: usize = 1024 * 1024;

fn scrollback_path(app_state: &AppState, session_key: &str) -> Option<std::path::PathBuf> {
    // Session keys are UUIDs, but never trust one to be a safe file name.
    if session_key.is_empty()
        || !session_key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    {
        return None;
    }
    Some(app_state.paths.scrollbacks().join(format!("{session_key}.ansi")))
}

#[tauri::command]
pub fn scrollback_save(
    app_state: State<'_, AppState>,
    session_key: String,
    data: String,
) -> Result<(), String> {
    let Some(path) = scrollback_path(&app_state, &session_key) else {
        return Err("非法的会话标识".into());
    };
    if data.is_empty() {
        let _ = std::fs::remove_file(&path);
        return Ok(());
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }

    let payload: &str = if data.len() > MAX_SCROLLBACK_BYTES {
        let mut start = data.len() - MAX_SCROLLBACK_BYTES;
        while start < data.len() && !data.is_char_boundary(start) {
            start += 1;
        }
        // Dropping the head can leave a half-written escape sequence; reset the
        // attributes first so the replay starts from a known state.
        &data[start..]
    } else {
        &data
    };

    write_atomic(&path, payload).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn scrollback_load(app_state: State<'_, AppState>, session_key: String) -> Option<String> {
    let path = scrollback_path(&app_state, &session_key)?;
    std::fs::read_to_string(path).ok().filter(|s| !s.is_empty())
}

#[tauri::command]
pub fn scrollback_clear(
    app_state: State<'_, AppState>,
    session_key: String,
) -> Result<(), String> {
    let Some(path) = scrollback_path(&app_state, &session_key) else {
        return Ok(());
    };
    match std::fs::remove_file(path) {
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn install_kind() -> String {
    if crate::workspace::is_portable() {
        "portable".to_string()
    } else {
        "installed".to_string()
    }
}

#[tauri::command]
pub fn data_dir(app_state: State<'_, AppState>) -> String {
    app_state.paths.dir().to_string_lossy().to_string()
}

#[tauri::command]
pub fn open_data_dir(app_state: State<'_, AppState>) -> Result<(), String> {
    let dir = app_state.paths.dir().to_string_lossy().to_string();
    std::fs::create_dir_all(&dir).ok();
    #[cfg(windows)]
    {
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(not(windows))]
    {
        let _ = &dir;
    }
    crate::logging::info(format!("opened data dir: {dir}"));
    Ok(())
}

// -------------------------------------------------- quick-command transfer

#[tauri::command]
pub fn export_quick_commands(
    app_state: State<'_, AppState>,
    json: String,
) -> Result<String, String> {
    let dir = app_state.paths.exports();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let name = format!("quick-commands-{}.json", now_ms());
    let path = dir.join(&name);
    write_atomic(&path, &json).map_err(|e| e.to_string())?;
    crate::logging::info(format!("exported quick commands -> {}", path.display()));
    // Return the file name, not the absolute path: the UI shows this in a
    // narrow sidebar where a full path wraps into an unreadable block.
    Ok(name)
}

#[tauri::command]
pub fn list_quick_command_exports(app_state: State<'_, AppState>) -> Vec<String> {
    let dir = app_state.paths.exports();
    let mut names: Vec<(std::time::SystemTime, String)> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("json") {
                continue;
            }
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .unwrap_or(std::time::UNIX_EPOCH);
            if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                names.push((modified, name.to_string()));
            }
        }
    }
    names.sort_by(|a, b| b.0.cmp(&a.0));
    names.into_iter().map(|(_, n)| n).collect()
}

#[tauri::command]
pub fn import_quick_commands(app_state: State<'_, AppState>, name: String) -> Result<String, String> {
    if name.contains("..") || name.contains('/') || name.contains('\\') {
        return Err("非法的文件名".into());
    }
    let path = app_state.paths.exports().join(&name);
    let content = std::fs::read_to_string(&path).map_err(|e| format!("读取失败: {e}"))?;
    // Never execute anything from the imported file: parse-check only.
    serde_json::from_str::<serde_json::Value>(&content)
        .map_err(|e| format!("JSON 解析失败: {e}"))?;
    crate::logging::info(format!("imported quick commands <- {name}"));
    Ok(content)
}

// ------------------------------------------------------------- file browser

#[tauri::command]
pub fn read_directory(path: String) -> Result<crate::fsview::DirListing, String> {
    crate::fsview::list_dir(&path).map_err(|e| {
        crate::logging::warn(format!("read_directory({path}) failed: {e}"));
        e
    })
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    crate::logging::info(format!("open_path: {path}"));
    crate::fsview::open_with_default(&path)
}

// ---------------------------------------------------------- shell discovery

#[cfg(windows)]
fn run_hidden(program: &str, args: &[&str]) -> Option<Vec<u8>> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if out.status.success() {
        Some(out.stdout)
    } else {
        None
    }
}

#[cfg(not(windows))]
fn run_hidden(_program: &str, _args: &[&str]) -> Option<Vec<u8>> {
    None
}

fn exists(path: &str) -> bool {
    std::path::Path::new(path).is_file()
}

fn decode_console(bytes: &[u8]) -> String {
    let looks_utf16 = bytes.len() >= 2
        && bytes.len() % 2 == 0
        && bytes
            .chunks_exact(2)
            .filter(|c| c[0] != 0 && c[1] == 0)
            .count()
            * 3
            > bytes.len() / 2;
    if looks_utf16 {
        let units: Vec<u16> = bytes
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&units)
    } else {
        String::from_utf8_lossy(bytes).to_string()
    }
}

#[tauri::command]
pub fn detect_shells() -> Vec<DetectedShell> {
    let mut found: Vec<DetectedShell> = Vec::new();

    let candidates: [(&str, &str, Vec<&str>, &str); 4] = [
        (
            "PowerShell 7",
            r"C:\Program Files\PowerShell\7\pwsh.exe",
            vec!["-NoLogo"],
            "pwsh",
        ),
        (
            "Windows PowerShell",
            r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
            vec!["-NoLogo"],
            "powershell",
        ),
        ("命令提示符", r"C:\Windows\System32\cmd.exe", vec![], "cmd"),
        (
            "Git Bash",
            r"C:\Program Files\Git\bin\bash.exe",
            vec!["--login", "-i"],
            "gitbash",
        ),
    ];

    for (name, path, args, kind) in candidates {
        if exists(path) {
            found.push(DetectedShell {
                name: name.to_string(),
                executable: path.to_string(),
                args: args.into_iter().map(|s| s.to_string()).collect(),
                kind: kind.to_string(),
            });
        }
    }

    if let Some(raw) = run_hidden("where", &["pwsh"]) {
        let line = String::from_utf8_lossy(&raw)
            .lines()
            .next()
            .map(|s| s.trim().to_string());
        if let Some(p) = line {
            if !p.is_empty() && !found.iter().any(|d| d.executable.eq_ignore_ascii_case(&p)) {
                found.push(DetectedShell {
                    name: "PowerShell 7".into(),
                    executable: p,
                    args: vec!["-NoLogo".into()],
                    kind: "pwsh".into(),
                });
            }
        }
    }

    let wsl = r"C:\Windows\System32\wsl.exe";
    if exists(wsl) {
        if let Some(raw) = run_hidden(wsl, &["-l", "-q"]) {
            let text = decode_console(&raw);
            for distro in text.lines().map(|l| l.trim().trim_matches('\u{feff}')) {
                if distro.is_empty() {
                    continue;
                }
                found.push(DetectedShell {
                    name: format!("WSL {distro}"),
                    executable: wsl.to_string(),
                    args: vec!["-d".into(), distro.to_string()],
                    kind: "wsl".into(),
                });
            }
        }
    }

    found
}
