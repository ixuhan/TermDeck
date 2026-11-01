use anyhow::{Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter};

use crate::models::{PtyDataPayload, PtyExitPayload, SessionInfo, ShellProfile};
use crate::utf8::Utf8Stream;

const BACKLOG_LIMIT: usize = 256 * 1024;

struct Session {
    /// Kept alive for the lifetime of the session: dropping the master closes the PTY.
    #[allow(dead_code)]
    master: Box<dyn MasterPty>,
    writer: Box<dyn Write + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    /// Output produced before the UI attached. Replayed on attach so the shell
    /// banner is never lost to the spawn/subscribe race.
    backlog: Arc<Mutex<String>>,
    attached: Arc<AtomicBool>,
}

pub struct PtyManager {
    sessions: Mutex<HashMap<String, Session>>,
}

impl PtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
        }
    }

    pub fn spawn(
        &self,
        app: AppHandle,
        id: String,
        profile: &ShellProfile,
        cols: u16,
        rows: u16,
    ) -> Result<SessionInfo> {
        let pty_system = native_pty_system();
        let size = PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        };
        let pair = pty_system.openpty(size).context("openpty failed")?;

        let mut cmd = CommandBuilder::new(&profile.executable);
        cmd.args(&profile.args);
        if let Some(cwd) = profile.cwd.as_ref() {
            let p = std::path::Path::new(cwd);
            if p.is_dir() {
                cmd.cwd(p);
            }
        }
        for (k, v) in &profile.env {
            cmd.env(k, v);
        }
        cmd.env("TERM", "xterm-256color");
        cmd.env("TERMDECK", "1");

        let mut child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| {
                crate::logging::warn(format!("spawn {} failed: {e}", profile.executable));
                anyhow::anyhow!("failed to spawn {}: {e}", profile.executable)
            })?;
        // The slave side must be dropped in the parent or the child never sees EOF.
        drop(pair.slave);

        let pid = child.process_id();
        let killer = child.clone_killer();
        let mut reader = pair.master.try_clone_reader().context("clone reader failed")?;
        let writer = pair.master.take_writer().context("take writer failed")?;

        let backlog = Arc::new(Mutex::new(String::new()));
        let attached = Arc::new(AtomicBool::new(false));

        let session = Session {
            master: pair.master,
            writer,
            killer,
            backlog: Arc::clone(&backlog),
            attached: Arc::clone(&attached),
        };

        // --- output pump -------------------------------------------------
        {
            let app = app.clone();
            let sid = id.clone();
            let backlog = Arc::clone(&backlog);
            let attached = Arc::clone(&attached);
            std::thread::Builder::new()
                .name(format!("pty-read-{sid}"))
                .spawn(move || {
                    let mut buf = vec![0u8; 65536];
                    let mut utf8 = Utf8Stream::new();
                    loop {
                        match reader.read(&mut buf) {
                            Ok(0) => break,
                            Ok(n) => {
                                let text = utf8.push(&buf[..n]);
                                if text.is_empty() {
                                    continue;
                                }
                                {
                                    let mut b = backlog.lock();
                                    b.push_str(&text);
                                    if b.len() > BACKLOG_LIMIT {
                                        let mut idx = b.len() - BACKLOG_LIMIT / 2;
                                        while !b.is_char_boundary(idx) {
                                            idx += 1;
                                        }
                                        b.drain(..idx);
                                    }
                                }
                                if attached.load(Ordering::Relaxed) {
                                    let pending = std::mem::take(&mut *backlog.lock());
                                    if !pending.is_empty() {
                                        let _ = app.emit(
                                            "pty:data",
                                            PtyDataPayload {
                                                session_id: sid.clone(),
                                                data: pending,
                                            },
                                        );
                                    }
                                }
                            }
                            Err(_) => break,
                        }
                    }
                })
                .ok();
        }

        // --- exit watcher ------------------------------------------------
        {
            let app = app.clone();
            let sid = id.clone();
            std::thread::Builder::new()
                .name(format!("pty-wait-{sid}"))
                .spawn(move || {
                    let code = match child.wait() {
                        Ok(status) => status.exit_code() as i32,
                        Err(_) => -1,
                    };
                    let _ = app.emit(
                        "pty:exit",
                        PtyExitPayload {
                            session_id: sid,
                            code,
                        },
                    );
                })
                .ok();
        }

        crate::logging::info(format!("session {id} spawned (pid={pid:?})"));
        self.sessions.lock().insert(id.clone(), session);

        Ok(SessionInfo { id, pid })
    }

    /// Hand over everything the shell printed before the UI was listening, then
    /// switch the session to live streaming.
    pub fn attach(&self, session_id: &str) -> String {
        let map = self.sessions.lock();
        match map.get(session_id) {
            Some(session) => {
                let mut buf = session.backlog.lock();
                let out = std::mem::take(&mut *buf);
                session.attached.store(true, Ordering::SeqCst);
                out
            }
            None => String::new(),
        }
    }

    pub fn write(&self, session_id: &str, data: &str) -> Result<()> {
        let mut map = self.sessions.lock();
        let session = map
            .get_mut(session_id)
            .context("session not found for write")?;
        session
            .writer
            .write_all(data.as_bytes())
            .context("pty write failed")?;
        session.writer.flush().ok();
        Ok(())
    }

    pub fn resize(&self, session_id: &str, cols: u16, rows: u16) -> Result<()> {
        let map = self.sessions.lock();
        if let Some(session) = map.get(session_id) {
            session
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .context("pty resize failed")?;
        }
        Ok(())
    }

    pub fn kill(&self, session_id: &str) -> Result<()> {
        let mut map = self.sessions.lock();
        if let Some(session) = map.remove(session_id) {
            let _ = session.killer.clone_killer().kill();
        }
        Ok(())
    }

    pub fn kill_all(&self) {
        let mut map = self.sessions.lock();
        for (_, session) in map.iter() {
            let _ = session.killer.clone_killer().kill();
        }
        map.clear();
    }

    pub fn has(&self, session_id: &str) -> bool {
        self.sessions.lock().contains_key(session_id)
    }
}
