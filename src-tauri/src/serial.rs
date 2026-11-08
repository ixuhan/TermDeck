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
    /// Needed to resolve relative log templates even while the port is closed.
    data_dir: PathBuf,
    /// Mirrors the global "每行开头显示时间" setting. Read by every reader
    /// thread, so toggling it takes effect on the very next chunk.
    timestamps: Arc<AtomicBool>,
}

impl SerialManager {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            sessions: Mutex::new(std::collections::HashMap::new()),
            data_dir,
            timestamps: Arc::new(AtomicBool::new(false)),
        }
    }

    /// The settings panel toggles this; log files then carry the same plain-text
    /// `[HH:MM:SS] ` prefix the terminal shows (minus the ANSI dimming).
    pub fn set_timestamps(&self, enabled: bool) {
        self.timestamps.store(enabled, Ordering::SeqCst);
    }

    /// Records a session without opening the port, so its log path is known
    /// before (and after) the port is opened.
    pub fn register(
        &self,
        id: &str,
        config: SerialConfig,
        view: SerialView,
        log: LogConfig,
    ) -> Result<(), String> {
        let mut sessions = self.sessions.lock().map_err(|e| e.to_string())?;
        let session = sessions.entry(id.to_string()).or_insert_with(|| {
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
        });
        *session.config.lock().map_err(|e| e.to_string())? = config;
        *session.view.lock().map_err(|e| e.to_string())? = view;
        *session.log.lock().map_err(|e| e.to_string())? = log;
        Ok(())
    }

    /// Path the current template resolves to, whether or not the port is open.
    pub fn log_path(&self, id: &str) -> Option<PathBuf> {
        let session = self.get(id).ok()?;
        let log = session.log.lock().ok()?.clone();
        if !log.enabled {
            return None;
        }
        let config = session.config.lock().ok()?.clone();
        resolve_log_path(&log.template, &config, &self.data_dir)
    }

    /// Directory to reveal for this session; created if it does not exist yet.
    pub fn log_dir(&self, id: &str) -> Result<PathBuf, String> {
        // Same reasoning as `status`: while a port is open the live handle's
        // parent is the directory being written to. Re-resolving a template
        // such as `logs/%Y%M%D/COM2.log` after midnight would otherwise open
        // tomorrow's empty folder instead of today's data.
        let live = self.get(id).ok().and_then(|s| {
            let open = s.open.lock().ok()?.is_some();
            if !open {
                return None;
            }
            s.log_path.lock().ok()?.clone()
        });
        let path = live
            .or_else(|| self.log_path(id))
            .ok_or_else(|| "该会话未开启日志记录".to_string())?;
        let dir = path
            .parent()
            .map(|p| p.to_path_buf())
            .filter(|p| !p.as_os_str().is_empty())
            .ok_or_else(|| "无法定位日志目录".to_string())?;
        std::fs::create_dir_all(&dir).map_err(|e| format!("创建日志目录失败: {e}"))?;
        Ok(dir)
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

        let log_path = if log.enabled {
            resolve_log_path(&log.template, &config, data_dir)
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
        // Global "每行开头显示时间" switch; read per chunk so it can be toggled
        // while the port is open.
        let stamps = self.timestamps.clone();
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
                let mut log_stamper = LogStamper::new();
                let mut last_log_date: Option<chrono::NaiveDate> = None;
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
                            let cr_mode = session_for_reader
                                .view
                                .lock()
                                .map(|v| v.cr_as_newline)
                                .unwrap_or(true);

                            if let Ok(mut guard) = log_file.lock() {
                                if let Some(file) = guard.as_mut() {
                                    let now = chrono::Local::now();
                                    // Plain text on purpose: no ANSI in log files.
                                    let stamp = if stamps.load(Ordering::SeqCst) {
                                        format!("[{}] ", now.format("%H:%M:%S")).into_bytes()
                                    } else {
                                        Vec::new()
                                    };
                                    let raw = if log_as_hex {
                                        hex_line(chunk).into_bytes()
                                    } else {
                                        chunk.to_vec()
                                    };
                                    // Always run the stamper (with an empty
                                    // stamp when off) so its line state stays
                                    // correct when the switch is flipped.
                                    let logged = log_chunk(
                                        &mut log_stamper,
                                        &mut last_log_date,
                                        &now,
                                        &raw,
                                        &stamp,
                                        cr_mode,
                                    );
                                    let _ = file.write_all(&logged);
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
        // Logged so a "port busy" later can be traced to who opened it when.
        crate::logging::info(format!(
            "serial open {} @ {} (session {id})",
            config.port, config.baud
        ));

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
        let open = session.open.lock().map(|o| o.is_some()).unwrap_or(false);
        let cached = session
            .log_path
            .lock()
            .ok()
            .and_then(|p| p.as_ref().map(|x| x.display().to_string()));
        let resolved = self.log_path(id).map(|p| p.display().to_string());
        // While open, the writer holds exactly one file handle: report that
        // path. Re-rendering a template containing %Y%M%D/%h%m%s on every
        // status call would otherwise produce a different (nonexistent) file
        // name every second, and point "open log folder" at tomorrow's empty
        // directory after midnight. When closed there is no handle, so keep
        // reflecting template edits immediately.
        let log_path = if open {
            cached.or(resolved)
        } else {
            resolved.or(cached)
        };

        SerialStatus {
            open,
            paused: session.paused.load(Ordering::SeqCst),
            alive: session.alive.load(Ordering::SeqCst),
            log_path,
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

/// Windows forbids `: < > " | ? *` in file names, but the drive-letter colon
/// must survive (`F://logs` is valid, `F-\logs` is a different folder).
fn sanitize_path(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for (i, ch) in input.chars().enumerate() {
        let keep_drive_colon = i == 1 && ch == ':' && input.as_bytes().first().is_some_and(u8::is_ascii_alphabetic);
        if keep_drive_colon {
            out.push(':');
        } else if matches!(ch, ':' | '<' | '>' | '"' | '|' | '?' | '*') {
            out.push('-');
        } else {
            out.push(ch);
        }
    }
    out
}

/// Resolves a log template to a concrete path.
///
/// An absolute template (e.g. `D://serial//%Port//%Y%M%D.log`) is used as-is;
/// anything relative is resolved against the app data directory.
pub fn resolve_log_path(template: &str, cfg: &SerialConfig, data_dir: &Path) -> Option<PathBuf> {
    let trimmed = template.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Templates are written with forward slashes; Windows paths that mix `\` and
    // `/` confuse `start` and Explorer, which read `/x` as a switch.
    let normalized = if cfg!(windows) {
        trimmed.replace('/', "\\")
    } else {
        trimmed.to_string()
    };
    let rendered = render_template(&normalized, cfg, &chrono::Local::now());
    let path = Path::new(&rendered);
    Some(if path.is_absolute() {
        path.to_path_buf()
    } else {
        data_dir.join(path)
    })
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
    sanitize_path(&out)
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

// ----------------------------------------------------------------- log stamps

/// Escape-sequence state, so a line made only of control sequences is not
/// mistaken for real output. Mirrors the frontend's `LineStamper`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EscapeState {
    None,
    Esc,
    Csi,
    Osc,
    OscEsc,
}

/// Inserts a plain-text `[HH:MM:SS] ` at the start of every line written to a
/// serial log file.
///
/// Deliberately plain text rather than ANSI: logs are opened in editors and
/// piped through grep, where `\x1b[2m` would just be noise. Other than the
/// inserted prefixes, the byte stream is passed through untouched, so binary
/// payloads stay byte-accurate.
///
/// State lives across reads: a device can split a line (or `\r\n`) between
/// chunks, and a stamp must not be duplicated or dropped at the boundary.
struct LogStamper {
    /// No non-whitespace byte on this line yet: a stamp may still be owed.
    owed: bool,
    at_line_start: bool,
    /// Bytes held back while `owed` is true (whitespace and controls).
    pending: Vec<u8>,
    /// Last byte was a lone `\r`; the line ends only when we see what follows,
    /// so `\r\n` counts as one break rather than two.
    pending_cr: bool,
    escape: EscapeState,
}

impl LogStamper {
    fn new() -> Self {
        Self {
            owed: true,
            at_line_start: true,
            pending: Vec::new(),
            pending_cr: false,
            escape: EscapeState::None,
        }
    }

    fn emit(&mut self, out: &mut Vec<u8>, b: u8) {
        if self.owed {
            self.pending.push(b);
        } else {
            out.push(b);
        }
    }

    /// Ends the line without a stamp (blank line or redraw).
    fn end_line(&mut self, out: &mut Vec<u8>) {
        if self.owed {
            out.append(&mut self.pending);
        }
        self.owed = true;
        self.at_line_start = true;
    }

    /// First real content: put the stamp at column 0, before any indentation.
    fn commit(&mut self, out: &mut Vec<u8>, stamp: &[u8]) {
        if self.owed {
            out.extend_from_slice(stamp);
            out.append(&mut self.pending);
            self.owed = false;
        }
        self.at_line_start = false;
    }

    /// A bare `\r` before any content repaints the current line; never stamp it.
    fn abandon(&mut self, out: &mut Vec<u8>) {
        if self.owed {
            out.append(&mut self.pending);
            self.owed = false;
        }
        self.at_line_start = false;
    }

    fn step_escape(&mut self, b: u8) {
        self.escape = match self.escape {
            EscapeState::Esc => match b {
                b'[' => EscapeState::Csi,
                b']' => EscapeState::Osc,
                _ => EscapeState::None,
            },
            // CSI ends on a final byte 0x40..=0x7E.
            EscapeState::Csi if (0x40..=0x7E).contains(&b) => EscapeState::None,
            EscapeState::Csi => EscapeState::Csi,
            EscapeState::Osc if b == 0x07 => EscapeState::None,
            EscapeState::Osc if b == 0x1b => EscapeState::OscEsc,
            EscapeState::Osc => EscapeState::Osc,
            EscapeState::OscEsc if b == b'\\' => EscapeState::None,
            EscapeState::OscEsc => EscapeState::Osc,
            EscapeState::None => EscapeState::None,
        };
    }

    /// @param stamp empty to disable stamping while still tracking line state
    /// @param cr_breaks_line whether a lone `\r` starts a new line (the
    ///        frontend's `crAsNewline` view option)
    fn process(&mut self, chunk: &[u8], stamp: &[u8], cr_breaks_line: bool) -> Vec<u8> {
        let mut out = Vec::with_capacity(chunk.len());
        for &b in chunk {
            if self.escape != EscapeState::None {
                self.emit(&mut out, b);
                self.step_escape(b);
                continue;
            }

            match b {
                0x1b => {
                    self.resolve_pending_cr(&mut out, cr_breaks_line);
                    self.emit(&mut out, b);
                    self.escape = EscapeState::Esc;
                    continue;
                }
                b'\n' => {
                    self.emit(&mut out, b);
                    self.end_line(&mut out);
                    self.pending_cr = false;
                    continue;
                }
                b'\r' if cr_breaks_line => {
                    // If a previous lone CR is still waiting, it was a real
                    // line break; close it before starting another one.
                    self.resolve_pending_cr(&mut out, cr_breaks_line);
                    self.emit(&mut out, b);
                    self.pending_cr = true;
                    continue;
                }
                b'\r' => {
                    // Raw mode: a redraw, not a new line in the file.
                    if self.at_line_start && self.owed {
                        self.abandon(&mut out);
                    }
                    self.emit(&mut out, b);
                    continue;
                }
                _ => {}
            }

            self.resolve_pending_cr(&mut out, cr_breaks_line);

            // Other controls and whitespace do not make a line "real".
            if b < 0x20 || b == 0x7f || b == b' ' || b == b'\t' {
                self.emit(&mut out, b);
                continue;
            }
            self.commit(&mut out, stamp);
            out.push(b);
        }
        out
    }

    /// A lone `\r` becomes a line break once a non-`\n` byte follows it.
    fn resolve_pending_cr(&mut self, out: &mut Vec<u8>, cr_breaks_line: bool) {
        if cr_breaks_line && self.pending_cr {
            self.pending_cr = false;
            self.end_line(out);
        }
    }

    /// Flushes an unfinished line without a stamp and returns to a fresh line.
    /// Used before writing a date marker, which is metadata rather than data.
    fn finish_line(&mut self) -> Vec<u8> {
        let mut out = Vec::new();
        out.append(&mut self.pending);
        *self = Self::new();
        out
    }
}

/// A `--- 日期变更 ---` marker when the local date rolls over during one
/// connection. Row timestamps are `[HH:MM:SS]`, so without this a log that
/// spans midnight looks like time ran backwards, and a connection running over
/// 24 hours produces duplicate timestamps with no way to tell the days apart.
///
/// `None` on the first chunk: the file name (or the reconnect marker) already
/// records when the session started.
fn date_anchor(
    prev: Option<chrono::NaiveDate>,
    now: chrono::NaiveDate,
) -> Option<String> {
    match prev {
        Some(p) if p != now => Some(format!(
            "\r\n--- 日期变更 {} ---\r\n",
            now.format("%Y-%m-%d")
        )),
        _ => None,
    }
}

/// Formats one received chunk for the log file, including the date marker on a
/// midnight rollover. The clock is a parameter so this can be tested without
/// touching the system time. `stamp` is empty when timestamps are disabled.
fn log_chunk(
    stamper: &mut LogStamper,
    last_date: &mut Option<chrono::NaiveDate>,
    now: &chrono::DateTime<chrono::Local>,
    raw: &[u8],
    stamp: &[u8],
    cr_breaks_line: bool,
) -> Vec<u8> {
    let today = now.date_naive();
    let prev = *last_date;
    *last_date = Some(today);

    let mut out = Vec::with_capacity(raw.len());
    if !stamp.is_empty() {
        if let Some(marker) = date_anchor(prev, today) {
            // `finish_line` also resets the stamper, so the new day's first
            // data line gets a fresh stamp at column 0.
            out.extend_from_slice(&stamper.finish_line());
            out.extend_from_slice(marker.as_bytes());
        }
    }
    out.extend_from_slice(&stamper.process(raw, stamp, cr_breaks_line));
    out
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

    // ---- log timestamps ---------------------------------------------------
    fn stamped(chunks: &[&[u8]], stamp: &[u8], cr: bool) -> String {
        let mut s = LogStamper::new();
        let mut out = Vec::new();
        for c in chunks {
            out.extend_from_slice(&s.process(c, stamp, cr));
        }
        String::from_utf8(out).unwrap()
    }

    const T: &[u8] = b"<T> ";

    #[test]
    fn log_stamp_first_line_and_after_newline() {
        assert_eq!(stamped(&[b"a\nb\nc"], T, true), "<T> a\n<T> b\n<T> c");
    }

    #[test]
    fn log_crlf_is_one_break() {
        assert_eq!(stamped(&[b"a\r\nb"], T, true), "<T> a\r\n<T> b");
    }

    #[test]
    fn log_crlf_split_across_reads() {
        assert_eq!(stamped(&[b"a\r", b"\nb"], T, true), "<T> a\r\n<T> b");
    }

    #[test]
    fn log_lone_cr_breaks_when_enabled() {
        assert_eq!(stamped(&[b"a\rb"], T, true), "<T> a\r<T> b");
    }

    #[test]
    fn log_lone_cr_is_a_redraw_in_raw_mode() {
        assert_eq!(stamped(&[b"\rprogress"], T, false), "\rprogress");
    }

    #[test]
    fn log_blank_and_whitespace_lines_are_not_stamped() {
        assert_eq!(stamped(&[b"a\n\n   \nb"], T, true), "<T> a\n\n   \n<T> b");
    }

    #[test]
    fn log_indent_keeps_stamp_at_column_zero() {
        assert_eq!(stamped(&[b"  indented"], T, true), "<T>   indented");
    }

    #[test]
    fn log_escape_only_line_is_not_stamped() {
        assert_eq!(
            stamped(&[b"\x1b[2K\x1b[0m\nreal"], T, true),
            "\x1b[2K\x1b[0m\n<T> real"
        );
    }

    #[test]
    fn log_line_split_across_reads_is_stamped_once() {
        assert_eq!(stamped(&[b"ab", b"cd\nef"], T, true), "<T> abcd\n<T> ef");
    }

    #[test]
    fn log_disabled_leaves_bytes_untouched_but_tracks_state() {
        let mut s = LogStamper::new();
        let mut out = s.process(b"abc", &[], true);
        out.extend_from_slice(&s.process(b"def", &[], true));
        out.extend_from_slice(&s.process(b"\nx", T, true));
        assert_eq!(String::from_utf8(out).unwrap(), "abcdef\n<T> x");
    }

    #[test]
    fn log_hex_rows_each_get_a_stamp() {
        // hex_line() emits one CRLF-terminated row per chunk.
        let row1 = hex_line(&[0x41, 0x42]);
        let row2 = hex_line(&[0x43]);
        assert_eq!(
            stamped(&[row1.as_bytes(), row2.as_bytes()], T, true),
            format!("<T> {row1}<T> {row2}")
        );
    }

    #[test]
    fn finish_line_flushes_held_bytes_and_resets() {
        let mut s = LogStamper::new();
        assert!(s.process(b"  ", T, true).is_empty());
        assert_eq!(s.finish_line(), b"  ".to_vec());
        assert_eq!(
            String::from_utf8(s.process(b"x\r\n", T, true)).unwrap(),
            "<T> x\r\n"
        );
    }

    #[test]
    fn date_anchor_only_appears_on_rollover() {
        let d1 = chrono::NaiveDate::from_ymd_opt(2026, 11, 8).unwrap();
        let d2 = chrono::NaiveDate::from_ymd_opt(2026, 11, 9).unwrap();
        assert_eq!(date_anchor(None, d1), None, "first chunk needs no marker");
        assert_eq!(date_anchor(Some(d1), d1), None, "same day needs no marker");
        let marker = date_anchor(Some(d1), d2).unwrap();
        assert!(marker.contains("2026-11-09"), "{marker}");
        assert!(marker.starts_with("\r\n--- 日期变更"), "{marker}");
        assert!(marker.ends_with("\r\n"), "{marker}");
    }

    /// Simulated clock: proves the whole path (marker + stamper reset) without
    /// changing the machine's system time.
    fn at(day: u32, h: u32, m: u32, s: u32) -> chrono::DateTime<chrono::Local> {
        use chrono::TimeZone;
        chrono::Local
            .with_ymd_and_hms(2026, 11, day, h, m, s)
            .unwrap()
    }

    fn feed_log(days: &[(u32, u32, u32, u32, &[u8])], stamp: &[u8]) -> String {
        let mut st = LogStamper::new();
        let mut last = None;
        let mut out = Vec::new();
        for (day, h, m, s, raw) in days {
            let now = at(*day, *h, *m, *s);
            out.extend_from_slice(&log_chunk(&mut st, &mut last, &now, raw, stamp, true));
        }
        String::from_utf8(out).unwrap()
    }

    #[test]
    fn log_marks_midnight_and_keeps_stamping_the_new_day() {
        let text = feed_log(
            &[
                (8, 23, 59, 58, b"before\r\n"),
                (8, 23, 59, 59, b"last\r\n"),
                (9, 0, 0, 1, b"after\r\n"),
                (9, 0, 0, 2, b"more\r\n"),
            ],
            T,
        );
        assert_eq!(
            text,
            "<T> before\r\n<T> last\r\n\r\n--- 日期变更 2026-11-09 ---\r\n<T> after\r\n<T> more\r\n",
            "{text}"
        );
    }

    #[test]
    fn log_marker_closes_an_unfinished_line() {
        let text = feed_log(
            &[(8, 23, 59, 59, b"half"), (9, 0, 0, 1, b"next\r\n")],
            T,
        );
        assert_eq!(
            text,
            "<T> half\r\n--- 日期变更 2026-11-09 ---\r\n<T> next\r\n",
            "{text}"
        );
    }

    #[test]
    fn log_no_marker_when_timestamps_are_off() {
        let text = feed_log(
            &[(8, 23, 59, 59, b"a\r\n"), (9, 0, 0, 1, b"b\r\n")],
            &[],
        );
        assert_eq!(text, "a\r\nb\r\n", "{text}");
        assert!(!text.contains("日期变更"));
    }
}
