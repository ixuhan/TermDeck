//! Read-only directory listing for the file panel.
//!
//! Deliberately stateless and watcher-free: the UI asks for a directory when
//! the user navigates, refreshes, or the terminal reports a new CWD. No
//! filesystem notifications are registered, so an idle panel costs nothing.

use serde::Serialize;
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 3000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirEntryInfo {
    pub name: String,
    pub is_dir: bool,
    pub size: u64,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirListing {
    pub path: String,
    pub parent: Option<String>,
    pub entries: Vec<DirEntryInfo>,
    pub truncated: bool,
    /// True when the requested path was not a readable directory and we fell
    /// back to the nearest existing ancestor (e.g. after `cd` into a typo).
    pub corrected: bool,
}

fn parent_of(path: &Path) -> Option<String> {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .map(|p| p.to_string_lossy().to_string())
}

/// Walk up until an existing directory is found. Keeps the panel usable when
/// the tracked CWD no longer exists (deleted folder, failed `cd`).
fn nearest_existing_dir(start: &Path) -> Option<PathBuf> {
    let mut cur = start.to_path_buf();
    for _ in 0..64 {
        if cur.is_dir() {
            return Some(cur);
        }
        match cur.parent() {
            Some(p) if !p.as_os_str().is_empty() => cur = p.to_path_buf(),
            _ => break,
        }
    }
    None
}

pub fn list_dir(requested: &str) -> Result<DirListing, String> {
    let raw = requested.trim();
    // An unknown starting directory (fresh session with no reported CWD) falls
    // back to the process working directory rather than showing an error.
    let fallback_to_cwd = raw.is_empty() || raw == ".";
    let want = if fallback_to_cwd {
        std::env::current_dir().map_err(|e| format!("无法获取当前目录：{e}"))?
    } else {
        PathBuf::from(raw)
    };
    let (dir, corrected) = if want.is_dir() {
        (want, false)
    } else {
        match nearest_existing_dir(&want) {
            Some(d) => (d, true),
            None => return Err(format!("无法访问：{raw}")),
        }
    };

    let read = std::fs::read_dir(&dir).map_err(|e| format!("读取目录失败：{e}"))?;

    let mut entries: Vec<DirEntryInfo> = Vec::new();
    let mut truncated = false;
    for item in read.flatten() {
        if entries.len() >= MAX_ENTRIES {
            truncated = true;
            break;
        }
        let name = item.file_name().to_string_lossy().to_string();
        let is_dir = item.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let size = item.metadata().map(|m| m.len()).unwrap_or(0);
        entries.push(DirEntryInfo {
            name,
            is_dir,
            size,
            path: item.path().to_string_lossy().to_string(),
        });
    }

    // Folders first, then case-insensitive by name — matches Explorer habits.
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });

    Ok(DirListing {
        path: dir.to_string_lossy().to_string(),
        parent: parent_of(&dir),
        entries,
        truncated,
        corrected,
    })
}

/// Opens a file or folder with the Windows default handler.
pub fn open_with_default(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        std::process::Command::new("cmd")
            .args(["/C", "start", "", path])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("打开失败：{e}"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = p;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_path_falls_back_to_process_cwd() {
        let listing = list_dir("   ").expect("should fall back to cwd");
        assert!(Path::new(&listing.path).is_dir());
    }

    #[test]
    fn missing_path_falls_back_to_ancestor() {
        let base = std::env::temp_dir();
        let ghost = base.join("termdeck-not-a-real-dir-xyz").join("deeper");
        let listing = list_dir(&ghost.to_string_lossy()).expect("should fall back");
        assert!(listing.corrected);
        assert!(Path::new(&listing.path).is_dir());
    }

    #[test]
    fn sorts_dirs_before_files() {
        let base = std::env::temp_dir().join("termdeck-dirlist-test");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(base.join("zdir")).unwrap();
        std::fs::write(base.join("afile.txt"), b"x").unwrap();

        let listing = list_dir(&base.to_string_lossy()).unwrap();
        assert!(listing.entries[0].is_dir);
        assert_eq!(listing.entries[0].name, "zdir");
        assert!(!listing.entries[1].is_dir);
        let _ = std::fs::remove_dir_all(&base);
    }
}
