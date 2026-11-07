use anyhow::{Context, Result};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

pub struct AppPaths {
    dir: PathBuf,
}

impl AppPaths {
    pub fn new(dir: PathBuf) -> Self {
        Self { dir }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    pub fn state(&self) -> PathBuf {
        self.dir.join("workspace_state.json")
    }

    pub fn presets(&self) -> PathBuf {
        self.dir.join("presets.json")
    }

    pub fn settings(&self) -> PathBuf {
        self.dir.join("settings.json")
    }

    pub fn db(&self) -> PathBuf {
        self.dir.join("termdeck.db")
    }

    pub fn exports(&self) -> PathBuf {
        self.dir.join("exports")
    }

    /// One serialized screen snapshot per session, used to repaint the terminal
    /// after a restart.
    pub fn scrollbacks(&self) -> PathBuf {
        self.dir.join("scrollback")
    }
}

/// The workspace-local data directory: `<exe dir>/data`. Falls back to the
/// roaming app-data dir when the install location is read-only.
pub fn resolve_data_dir(app_data_fallback: PathBuf) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            let candidate = parent.join("data");
            if fs::create_dir_all(&candidate).is_ok() && is_writable(&candidate) {
                return candidate;
            }
        }
    }
    let _ = fs::create_dir_all(&app_data_fallback);
    app_data_fallback
}

/// True when the binary is running from a folder the user extracted by hand
/// rather than from an installer-created location.
///
/// This deliberately does NOT look at the `data` directory: that directory is
/// always created beside the exe when the location is writable, so it cannot
/// tell the two cases apart. What actually differs is where the exe lives -
/// installers put it under LOCALAPPDATA or Program Files.
pub fn is_portable() -> bool {
    let Ok(exe) = std::env::current_exe() else {
        return false;
    };
    let Some(dir) = exe.parent() else {
        return false;
    };
    let dir = dir.to_string_lossy().to_lowercase();

    for var in ["LOCALAPPDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432"] {
        if let Ok(root) = std::env::var(var) {
            if !root.is_empty() && dir.starts_with(&root.to_lowercase()) {
                return false;
            }
        }
    }
    true
}

fn is_writable(dir: &Path) -> bool {
    let probe = dir.join(".write-probe");
    match fs::File::create(&probe) {
        Ok(_) => {
            let _ = fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// Write `content` to `path` atomically: temp file -> fsync -> rename, keeping
/// the previous revision as `.bak` so a corrupt write can always be recovered.
pub fn write_atomic(path: &Path, content: &str) -> Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).ok();
    }

    let tmp = path.with_extension("tmp");
    {
        let mut f = fs::File::create(&tmp).context("create temp file failed")?;
        f.write_all(content.as_bytes()).context("write temp failed")?;
        f.sync_all().context("fsync temp failed")?;
    }

    if path.exists() {
        let bak = path.with_extension("bak");
        let _ = fs::copy(path, bak);
    }

    fs::rename(&tmp, path).context("atomic rename failed")?;
    Ok(())
}

/// Read `path`, falling back to `.bak` when the primary file is missing or corrupt.
pub fn read_with_backup(path: &Path) -> Option<String> {
    if let Ok(s) = fs::read_to_string(path) {
        if serde_json::from_str::<serde_json::Value>(&s).is_ok() {
            return Some(s);
        }
    }
    let bak = path.with_extension("bak");
    if let Ok(s) = fs::read_to_string(&bak) {
        if serde_json::from_str::<serde_json::Value>(&s).is_ok() {
            return Some(s);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn portable_detection_does_not_panic() {
        // Runs from the cargo target dir in CI, so it must classify as portable
        // without touching the filesystem.
        let _ = is_portable();
    }
}
