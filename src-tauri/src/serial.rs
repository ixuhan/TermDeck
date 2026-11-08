//! Serial port sessions.
//!
//! A serial session is modelled as a byte stream shaped like a PTY session:
//! data arrives as `pty:data` events, `write_pty` sends bytes, the frontend
//! terminal renders it unchanged. Session list, tab switching and scrollback
//! restore therefore work without special cases.
//!
//! Pausing closes the port on purpose: it releases the COM port so vendor tools
//! can grab it, at the cost of losing whatever arrives while paused.

use std::fs::{File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::models::{PtyDataPayload, PtyExitPayload};

/// How much already-received data is kept for a terminal that attaches late.
const BACKLOG_LIMIT: usize = 256 * 1024;
/// Bytes per hex dump row.
const HEX_COLUMNS: usize = 16;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialConfig {
    pub port: String,
    pub baud: u32,
    pub data_bits: u8,
    pub stop_bits: u8,
    /// none | odd | even | mark | space
    pub parity: String,
    /// none | rtscts | xonxoff
    pub flow: String,
    /// Some boards reset when DTR is asserted; exposing it lets users opt out.
    pub dtr: bool,
    pub rts: bool,
}

impl Default for SerialConfig {
    fn default() -> Self {
        Self {
            port: String::new(),
            baud: 115200,
            data_bits: 8,
            stop_bits: 1,
            parity: "none".into(),
            flow: "none".into(),
            dtr: true,
            rts: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialView {
    /// Render incoming bytes as a hex dump instead of text.
    pub hex: bool,
    /// Treat a lone `\r` as a line break, and a lone `\n` as `\r\n`.
    pub cr_as_newline: bool,
    /// Echo what we send back to the screen.
    pub local_echo: bool,
}

impl Default for SerialView {
    fn default() -> Self {
        Self {
            hex: false,
            cr_as_newline: true,
            local_echo: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LogConfig {
    pub enabled: bool,
    /// Placeholders: %Y %M %D %h %m %s %Port %Baud %Date
    pub template: String,
    /// Store a hex dump instead of raw bytes.
    pub hex: bool,
}

impl Default for LogConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            template: "logs/%Port/%Y%M%D-%H%m%s.log".into(),
            hex: false,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialStatus {
    pub open: bool,
    pub paused: bool,
    pub alive: bool,
    pub log_path: Option<String>,
}

struct OpenPort {
    writer: Arc<Mutex<Box<dyn serialport::SerialPort>>>,
    reader: JoinHandle<()>,
    stop: Arc<AtomicBool>,
}

struct SerialSession {
    config: Mutex<SerialConfig>,
    view: Mutex<SerialView>,
    log: Mutex<LogConfig>,
    open: Mutex<Option<OpenPort>>,
    backlog: Mutex<Vec<u8>>,
    alive: AtomicBool,
    paused: AtomicBool,
    log_path: Mutex<Option<PathBuf>>,
}

pub struct SerialManager {
    sessions: Mutex<std::collections::HashMap<String, Arc<SerialSession>>>,
}

impl SerialManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(std::collections::HashMap::new()),
        }
    }

    pub fn has(&self, id: &str) -> bool {
        self.sessions
            .lock()
            .map(|m| m.contains_key(id))
            .unwrap_or(false)
    }

    /// Opens the port and starts the reader. Also used by `resume`.
    pub fn open(
        &self,
        app: AppHandle,
        id: String,
        config: SerialConfig,
        view: SerialView,
        log: LogConfig,
        data_dir: &Path,
    ) -> Result<(), String> {
        let parity = match config.parity.as_str() {
            "odd" => serialport::Parity::Odd,
            "even" => serialport::Parity::Even,
            // Windows drivers only offer none/odd/even; mark/space are dropped.
            "odd" => serialport::Parity::Odd,
            "even" => serialport::Parity::Even,
            _ => serialport::Parity::None,
        };
        let timeout = Duration::from_millis(50);

        let mut port = serialport::new(&config.port, config.baud)
            .data_bits(match config.data_bits {
                5 => serialport::DataBits::Five,
                6 => serialport::DataBits::Six,
                7 => serialport::DataBits::Seven,
                _ => serialport::DataBits::Eight,
            })
            .stop_bits(if config.stop_bits == 2 {
                serialport::StopBits::Two
            } else {
                serialport::StopBits::One
            })
            .parity(parity)
            .flow_control(match config.flow.as_str() {
                "rtscts" => serialport::FlowControl::Hardware,
                "xonxoff" => serialport::FlowControl::Software,
                _ => serialport::FlowControl::None,
            })
            // Short timeout keeps the reader responsive to stop requests.
            .timeout(timeout)
            .open()
            .map_err(|e| format_open_error(&config.port, e))?;

        // DTR/RTS are best-effort: some drivers refuse one or both.
        let _ = port.write_data_terminal_ready(config.dtr);
        let _ = port.write_request_to_send(config.rts);

        let reader_port = port
            .try_clone()
            .map_err(|e| format!("复制串口句柄失败: {e}"))?;

        let log_path = if log.enabled && !log.template.trim().is_empty() {
            Some(data_dir.join(render_template(
                &log.template,
                &config,
                &chrono::Local::now(),
            )))
        } else {
            None
        };

        let session = {
            let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
            sessions
                .entry(id.clone())
                .or_insert_with(|| {
                    Arc::new(SerialSession {
                        config: Mutex::new(SerialConfig::default()),
                        view: Mutex::new(SerialView::default()),
                        log: Mutex::new(LogConfig::default()),
                        open: Mutex::new(None),
                        backlog: Mutex::new(Vec::new()),
                        alive: AtomicBool::new(false),
                        paused: AtomicBool::new(false),
                        log_path: Mutex::new(None),
                    })
                })
                .clone()
        };

        // Port parameters are only changeable while closed, so refresh them here.
        *session.config.lock().unwrap() = config.clone();
        *session.view.lock().unwrap() = view.clone();
        *session.log.lock().unwrap() = log.clone();

        let mut log_file = match &log_path {
            Some(p) => Some(open_log(p)?),
            None => None,
        };
        if let (Some(f), Some(_)) = (log_file.as_mut(), &log_path) {
            // Mark reconnects so an appended log stays readable.
            if f.metadata().map(|m| m.len() > 0).unwrap_or(false) {
                let _ = writeln!(
                    f,
                    "\r\n--- 重新打开 {} ---",
                    chrono::Local::now().format("%Y-%m-%d %H:%M:%S")
                );
            }
        }
        *session.log_path.lock().unwrap() = log_path;

        let log_file = Arc::new(Mutex::new(log_file));
        let log_as_hex = log.hex;
        let stop = Arc::new(AtomicBool::new(false));
        let writer = Arc::new(Mutex::new(port));

        let app_for_reader = app.clone();
        let session_for_reader = session.clone();
        // Must match the frontend's `ptyId` (`serial:<key>`), otherwise the
        // terminal filters every event out as belonging to another session.
        let id_for_reader = format!("serial:{id}");
        let stop_for_reader = stop.clone();

        session.alive.store(true, Ordering::SeqCst);
        session.paused.store(false, Ordering::SeqCst);

        let reader = thread::Builder::new()
            .name(format!("serial-{id}"))
            .spawn(move || {
                let mut formatter = Formatter::new();
                let mut port = reader_port;
                let mut buf = [0u8; 4096];

                loop {
                    if stop_for_reader.load(Ordering::SeqCst) {
                        break;
                    }
                    match port.read(&mut buf) {
                        Ok(0) => continue,
                        Ok(n) => {
                            let chunk = &buf[..n];

                            if let Ok(mut guard) = log_file.lock() {
                                if let Some(file) = guard.as_mut() {
                                    let _ = if log_as_hex {
                                        file.write_all(hex_line(chunk).as_bytes())
                                    } else {
                                        file.write_all(chunk)
                                    };
                                    // 115200 baud is ~11 KB/s: flushing per chunk is
                                    // cheap and keeps a crash from losing the tail.
                                    let _ = file.flush();
                                }
                            }

                            let hex = session_for_reader
                                .view
                                .lock()
                                .map(|v| v.hex)
                                .unwrap_or(false);
                            let cr_mode = session_for_reader
                                .view
                                .lock()
                                .map(|v| v.cr_as_newline)
                                .unwrap_or(true);
                            let text = formatter.render(chunk, hex, cr_mode);

                            if !text.is_empty() {
                                if let Ok(mut backlog) = session_for_reader.backlog.lock() {
                                    backlog.extend_from_slice(text.as_bytes());
                                    if backlog.len() > BACKLOG_LIMIT {
                                        let cut = backlog.len() - BACKLOG_LIMIT;
                                        backlog.drain(..cut);
                                    }
                                }
                                let _ = app_for_reader.emit(
                                    "pty:data",
                                    PtyDataPayload {
                                        session_id: id_for_reader.clone(),
                                        data: text,
                                    },
                                );
                            }
                        }
                        Err(e) if e.kind() == std::io::ErrorKind::TimedOut => continue,
                        Err(e) => {
                            session_for_reader.alive.store(false, Ordering::SeqCst);
                            let _ = app_for_reader.emit(
                                "pty:exit",
                                PtyExitPayload {
                                    session_id: id_for_reader.clone(),
                                    code: -1,
                                },
                            );
                            crate::logging::warn(format!(
                                "serial {id_for_reader} read failed: {e}"
                            ));
                            break;
                        }
                    }
                }
            })
            .map_err(|e| format!("启动串口读取线程失败: {e}"))?;

        *session.open.lock().unwrap() = Some(OpenPort {
            writer,
            reader,
            stop,
        });

        Ok(())
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), String> {
        let session = self.get(id)?;
        let guard = session.open.lock().map_err(|e| e.to_string())?;
        let Some(open) = guard.as_ref() else {
            return Err("串口已关闭（暂停中）".into());
        };
        let mut port = open.writer.lock().map_err(|e| e.to_string())?;
        port.write_all(data)
            .and_then(|_| port.flush())
            .map_err(|e| format!("写入串口失败: {e}"))
    }

    /// Drains the backlog; a terminal attaching late gets the output it missed.
    pub fn attach(&self, id: &str) -> String {
        let Ok(session) = self.get(id) else {
            return String::new();
        };
        let Ok(mut backlog) = session.backlog.lock() else {
            return String::new();
        };
        let text = String::from_utf8_lossy(&backlog).to_string();
        backlog.clear();
        text
    }

    /// Closes the port so other software can use it.
    pub fn pause(&self, id: &str) -> Result<(), String> {
        let session = self.get(id)?;
        session.paused.store(true, Ordering::SeqCst);
        self.close_port(&session);
        Ok(())
    }

    pub fn resume(&self, app: AppHandle, id: &str, data_dir: &Path) -> Result<(), String> {
        let session = self.get(id)?;
        if session.open.lock().map(|o| o.is_some()).unwrap_or(false) {
            return Ok(());
        }
        let config = session.config.lock().map_err(|e| e.to_string())?.clone();
        let view = session.view.lock().map_err(|e| e.to_string())?.clone();
        let log = session.log.lock().map_err(|e| e.to_string())?.clone();
        self.open(app, id.to_string(), config, view, log, data_dir)
    }

    /// Display/log changes take effect immediately; port settings need a
    /// pause/resume cycle, which the UI performs explicitly.
    pub fn update_settings(&self, id: &str, view: SerialView, log: LogConfig) -> Result<(), String> {
        let session = self.get(id)?;
        *session.view.lock().map_err(|e| e.to_string())? = view;
        *session.log.lock().map_err(|e| e.to_string())? = log;
        Ok(())
    }

    /// Replaces the port configuration. Caller must pause first.
    pub fn update_config(&self, id: &str, config: SerialConfig) -> Result<(), String> {
        let session = self.get(id)?;
        *session.config.lock().map_err(|e| e.to_string())? = config;
        Ok(())
    }

    pub fn status(&self, id: &str) -> SerialStatus {
        let Ok(session) = self.get(id) else {
            return SerialStatus {
                open: false,
                paused: false,
                alive: false,
                log_path: None,
            };
        };
        SerialStatus {
            open: session.open.lock().map(|o| o.is_some()).unwrap_or(false),
            paused: session.paused.load(Ordering::SeqCst),
            alive: session.alive.load(Ordering::SeqCst),
            log_path: session
                .log_path
                .lock()
                .ok()
                .and_then(|p| p.as_ref().map(|x| x.display().to_string())),
        }
    }

    pub fn close(&self, id: &str) {
        let Ok(session) = self.get(id) else { return };
        self.close_port(&session);
        if let Ok(mut m) = self.sessions.lock() {
            m.remove(id);
        }
    }

    pub fn close_all(&self) {
        let ids: Vec<String> = match self.sessions.lock() {
            Ok(m) => m.keys().cloned().collect(),
            Err(_) => return,
        };
        for id in ids {
            self.close(&id);
        }
    }

    fn get(&self, id: &str) -> Result<Arc<SerialSession>, String> {
        self.sessions
            .lock()
            .map_err(|e| e.to_string())?
            .get(id)
            .cloned()
            .ok_or_else(|| format!("串口会话不存在: {id}"))
    }

    fn close_port(&self, session: &Arc<SerialSession>) {
        let taken = session.open.lock().ok().and_then(|mut o| o.take());
        if let Some(open) = taken {
            open.stop.store(true, Ordering::SeqCst);
            // Reader wakes within the 50 ms read timeout.
            let _ = open.reader.join();
            session.alive.store(false, Ordering::SeqCst);
        }
    }
}

fn open_log(path: &Path) -> Result<File, String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
    }
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| format!("打开日志文件失败: {e}"))
}

/// One line of `XX XX ...` for hex logs. Row alignment across reads is not worth
/// the complexity here: logs are read by grep/scripts, not by eye.
fn hex_line(chunk: &[u8]) -> String {
    let mut s = String::with_capacity(chunk.len() * 3 + 2);
    for b in chunk {
        s.push_str(&format!("{b:02X} "));
    }
    s.push_str("\r\n");
    s
}

fn format_open_error(port: &str, e: serialport::Error) -> String {
    let text = e.to_string();
    let lower = text.to_lowercase();
    if lower.contains("access is denied") || lower.contains("permission") || lower.contains("拒绝访问")
    {
        // The single most common failure: another program already holds the port.
        format!("{port} 被其他程序占用（关闭厂商工具或另一个串口会话后重试）")
    } else if lower.contains("not found") || lower.contains("cannot find") || lower.contains("不存在")
    {
        format!("{port} 不存在或已被拔出")
    } else {
        format!("打开 {port} 失败：{text}")
    }
}

/// Expands `%Y %M %D %h %m %s %Port %Baud %Date` in a log file template.
pub fn render_template(
    tpl: &str,
    cfg: &SerialConfig,
    now: &chrono::DateTime<chrono::Local>,
) -> String {
    let mut out = String::with_capacity(tpl.len() + 16);
    let mut chars = tpl.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(c);
            continue;
        }
        let mut word = String::new();
        while let Some(&n) = chars.peek() {
            if n.is_ascii_alphabetic() {
                word.push(n);
                chars.next();
            } else {
                break;
            }
        }
        match word.as_str() {
            "Y" => out.push_str(&now.format("%Y").to_string()),
            "M" => out.push_str(&now.format("%m").to_string()),
            "D" => out.push_str(&now.format("%d").to_string()),
            "h" => out.push_str(&now.format("%H").to_string()),
            "m" => out.push_str(&now.format("%M").to_string()),
            "s" => out.push_str(&now.format("%S").to_string()),
            "Port" => out.push_str(&cfg.port),
            "Baud" => out.push_str(&cfg.baud.to_string()),
            // SecureCRT spells it %Data in some docs; accept both.
            "Date" | "Data" => out.push_str(&now.format("%Y%m%d-%H%M%S").to_string()),
            "" => out.push('%'),
            _ => {
                // Unknown placeholder stays verbatim so the typo shows up in the
                // resulting file name instead of vanishing.
                out.push('%');
                out.push_str(&word);
            }
        }
    }
    // Windows file names cannot contain a colon.
    out.replace(':', "-")
}

/// Turns the raw byte stream into what the terminal should display.
struct Formatter {
    /// Bytes of an incomplete hex row, kept across reads.
    pending: Vec<u8>,
    /// A trailing `\r` whose successor has not arrived yet.
    pending_cr: bool,
}

impl Formatter {
    fn new() -> Self {
        Self {
            pending: Vec::new(),
            pending_cr: false,
        }
    }

    fn render(&mut self, chunk: &[u8], hex: bool, cr_mode: bool) -> String {
        if hex {
            self.render_hex(chunk)
        } else {
            self.render_text(chunk, cr_mode)
        }
    }

    fn render_hex(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        let mut idx = 0;
        while idx + HEX_COLUMNS <= self.pending.len() {
            for (i, byte) in self.pending[idx..idx + HEX_COLUMNS].iter().enumerate() {
                if i > 0 {
                    out.push(' ');
                }
                out.push_str(&format!("{byte:02X}"));
            }
            out.push_str("\r\n");
            idx += HEX_COLUMNS;
        }
        self.pending.drain(..idx);
        out
    }

    /// Serial streams have no terminal driver normalising line endings, so both
    /// `\r` and `\n` need fixing up:
    ///   - a lone `\r` breaks the line (xterm would just return the carriage)
    ///   - a lone `\n` must be preceded by `\r`, otherwise output staircases
    fn render_text(&mut self, chunk: &[u8], cr_mode: bool) -> String {
        let text = String::from_utf8_lossy(chunk);
        let mut out = String::with_capacity(text.len() + 16);

        if !cr_mode {
            // Raw passthrough: only restore the missing carriage return.
            for ch in text.chars() {
                if ch == '\n' {
                    out.push_str("\r\n");
                } else {
                    out.push(ch);
                }
            }
            return out;
        }

        let mut chars = text.chars().peekable();

        // Resolve a `\r` left over from the previous read.
        if self.pending_cr {
            if chars.peek() == Some(&'\n') {
                out.push('\n');
                chars.next();
            } else {
                out.push('\n');
            }
            self.pending_cr = false;
        }

        let mut prev: Option<char> = None;
        while let Some(ch) = chars.next() {
            match ch {
                '\r' => {
                    out.push('\r');
                    match chars.peek() {
                        Some('\n') => {}                 // normal CRLF, keep as is
                        Some(_) => out.push('\n'),       // lone CR in the middle
                        None => self.pending_cr = true,  // decide next read
                    }
                }
                '\n' => {
                    if prev == Some('\r') {
                        out.push('\n');
                    } else {
                        // Lone LF would only move down; add the carriage return.
                        out.push_str("\r\n");
                    }
                }
                other => out.push(other),
            }
            prev = Some(ch);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn render(chunks: &[&[u8]]) -> String {
        let mut f = Formatter::new();
        let mut out = String::new();
        for c in chunks {
            out.push_str(&f.render(c, false, true));
        }
        out
    }

    #[test]
    fn lone_cr_breaks_the_line() {
        assert_eq!(render(&[b"a\rb"]), "a\r\nb");
    }

    #[test]
    fn crlf_is_left_alone() {
        assert_eq!(render(&[b"a\r\nb"]), "a\r\nb");
    }

    #[test]
    fn lone_lf_gets_a_carriage_return() {
        assert_eq!(render(&[b"a\nb"]), "a\r\nb");
    }

    #[test]
    fn split_crlf_across_reads_is_not_doubled() {
        // The `\r` arrives alone, the `\n` in the next read.
        assert_eq!(render(&[b"a\r", b"\nb"]), "a\r\nb");
    }

    #[test]
    fn split_cr_then_text_breaks_once() {
        assert_eq!(render(&[b"a\r", b"b"]), "a\r\nb");
    }

    #[test]
    fn hex_rows_are_aligned_across_reads() {
        let mut f = Formatter::new();
        let first = f.render(&[0u8; 10], true, true);
        assert!(first.is_empty(), "incomplete row must be buffered");
        let second = f.render(&[1u8; 22], true, true);
        // 32 bytes available -> two full rows of 16.
        assert_eq!(second.matches("\r\n").count(), 2);
    }

    #[test]
    fn template_expands_placeholders() {
        let cfg = SerialConfig {
            port: "COM7".into(),
            baud: 115200,
            ..Default::default()
        };
        let now = chrono::Local::now();
        let out = render_template("logs/%Port/%Y%M%D-%h%m%s.log", &cfg, &now);
        assert!(out.starts_with("logs/COM7/"));
        assert!(out.ends_with(".log"));
        assert_eq!(out.matches('-').count(), 1);
    }

    #[test]
    fn unknown_placeholder_is_preserved() {
        let cfg = SerialConfig::default();
        let out = render_template("%Nope.log", &cfg, &chrono::Local::now());
        assert_eq!(out, "%Nope.log");
    }
}
