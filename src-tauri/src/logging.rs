use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::OnceLock;

static LOG_PATH: OnceLock<PathBuf> = OnceLock::new();

pub fn init(dir: &std::path::Path) {
    let _ = LOG_PATH.set(dir.join("termdeck.log"));
}

pub fn write(level: &str, msg: impl AsRef<str>) {
    let Some(path) = LOG_PATH.get() else {
        return;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(f, "{now} [{level}] {}", msg.as_ref());
    }
}

pub fn info(msg: impl AsRef<str>) {
    write("info", msg);
}

pub fn warn(msg: impl AsRef<str>) {
    write("warn", msg);
}
