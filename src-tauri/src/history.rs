use anyhow::{Context, Result};
use parking_lot::Mutex;
use rusqlite::{params, Connection};
use std::path::Path;

use crate::models::HistoryEntry;

const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS session_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT    NOT NULL,
    command         TEXT    NOT NULL,
    executed_at     INTEGER NOT NULL,
    cwd             TEXT,
    execution_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE (session_id, command)
);
CREATE INDEX IF NOT EXISTS idx_session_command ON session_history (session_id, command);
CREATE INDEX IF NOT EXISTS idx_session_time    ON session_history (session_id, executed_at DESC);
"#;

pub struct HistoryStore {
    conn: Mutex<Connection>,
}

impl HistoryStore {
    pub fn open(path: &Path) -> Result<Self> {
        let conn = Connection::open(path).context("open history db failed")?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        conn.execute_batch(SCHEMA)?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    /// Insert-or-increment, then FIFO-trim the session to `max_entries`.
    /// `mask` scrubs likely secrets before they are persisted (FR-HIST-04);
    /// the terminal echo still shows the real value.
    pub fn add(
        &self,
        session_id: &str,
        command: &str,
        cwd: Option<&str>,
        now_ms: i64,
        max_entries: usize,
        mask: bool,
    ) -> Result<()> {
        let trimmed = command.trim_end_matches(['\r', '\n']);
        if trimmed.trim().is_empty() {
            return Ok(());
        }
        let stored = if mask {
            mask_secrets(trimmed)
        } else {
            trimmed.to_string()
        };
        let conn = self.conn.lock();
        conn.execute(
            "INSERT INTO session_history (session_id, command, executed_at, cwd)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(session_id, command) DO UPDATE SET
                 execution_count = execution_count + 1,
                 executed_at     = excluded.executed_at,
                 cwd             = excluded.cwd",
            params![session_id, stored, now_ms, cwd],
        )?;
        conn.execute(
            "DELETE FROM session_history
             WHERE session_id = ?1 AND id NOT IN (
                 SELECT id FROM session_history
                 WHERE session_id = ?1
                 ORDER BY executed_at DESC
                 LIMIT ?2
             )",
            params![session_id, max_entries as i64],
        )?;
        Ok(())
    }

    /// Highest-frequency command starting with `prefix`, used for ghost text.
    pub fn prefix(&self, session_id: &str, prefix: &str) -> Result<Option<String>> {
        if prefix.trim().is_empty() {
            return Ok(None);
        }
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT command FROM session_history
             WHERE session_id = ?1
               AND command LIKE ?2 ESCAPE '\\'
               AND command <> ?3
             ORDER BY execution_count DESC, executed_at DESC
             LIMIT 1",
        )?;
        let pattern = format!("{}%", escape_like(prefix));
        let mut rows = stmt.query(params![session_id, pattern, prefix])?;
        match rows.next()? {
            Some(row) => Ok(Some(row.get(0)?)),
            None => Ok(None),
        }
    }

    pub fn search(&self, session_id: &str, query: &str, limit: usize) -> Result<Vec<HistoryEntry>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT command, executed_at, execution_count, cwd
             FROM session_history WHERE session_id = ?1",
        )?;
        let mut rows = stmt.query(params![session_id])?;

        let mut scored: Vec<HistoryEntry> = Vec::new();
        while let Some(row) = rows.next()? {
            let command: String = row.get(0)?;
            let executed_at: i64 = row.get(1)?;
            let execution_count: i64 = row.get(2)?;
            let cwd: Option<String> = row.get(3)?;

            let score = if query.trim().is_empty() {
                // Empty query: surface the most used commands first.
                (execution_count as i32) * 4 + (executed_at / 1_000_000_000) as i32
            } else {
                match fuzzy_score(query, &command) {
                    Some(s) => s,
                    None => continue,
                }
            };

            scored.push(HistoryEntry {
                command,
                executed_at,
                execution_count,
                cwd,
                score,
            });
        }

        scored.sort_by(|a, b| {
            b.score
                .cmp(&a.score)
                .then(b.executed_at.cmp(&a.executed_at))
        });
        scored.truncate(limit);
        Ok(scored)
    }

    pub fn clear(&self, session_id: &str) -> Result<()> {
        let conn = self.conn.lock();
        conn.execute(
            "DELETE FROM session_history WHERE session_id = ?1",
            params![session_id],
        )?;
        Ok(())
    }

    /// Only used to initialise a warm in-memory index on the frontend.
    pub fn all_commands(&self, session_id: &str) -> Result<Vec<String>> {
        let conn = self.conn.lock();
        let mut stmt = conn.prepare(
            "SELECT command FROM session_history WHERE session_id = ?1
             ORDER BY execution_count DESC, executed_at DESC LIMIT 500",
        )?;
        let mut rows = stmt.query(params![session_id])?;
        let mut out = Vec::new();
        while let Some(row) = rows.next()? {
            out.push(row.get(0)?);
        }
        Ok(out)
    }
}

fn escape_like(input: &str) -> String {
    input
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

/// Scrubs likely credentials out of a command before it is persisted.
/// Deliberately conservative: it only touches `--flag=value`, `--flag value`
/// and `SOMETHING_KEY=value` shapes, leaving ordinary commands untouched.
pub fn mask_secrets(command: &str) -> String {
    const VALUE_FLAGS: [&str; 6] = [
        "--password",
        "--passwd",
        "--token",
        "--secret",
        "--api-key",
        "--apikey",
    ];
    const KEY_HINTS: [&str; 5] = ["PASSWORD", "PASSWD", "TOKEN", "SECRET", "API_KEY"];

    let tokens: Vec<&str> = command.split(' ').collect();
    let mut out: Vec<String> = Vec::with_capacity(tokens.len());
    let mut i = 0usize;

    while i < tokens.len() {
        let tok = tokens[i];
        let lower = tok.to_lowercase();

        if let Some(eq) = tok.find('=') {
            let (key, _) = tok.split_at(eq);
            let key_upper = key.to_uppercase();
            let is_flag = VALUE_FLAGS.iter().any(|f| key.to_lowercase() == *f);
            let is_env_key = KEY_HINTS.iter().any(|h| key_upper.contains(h));
            if is_flag || is_env_key {
                out.push(format!("{key}=***"));
                i += 1;
                continue;
            }
        }

        if VALUE_FLAGS.iter().any(|f| lower == *f) && i + 1 < tokens.len() {
            out.push(tok.to_string());
            out.push("***".to_string());
            i += 2;
            continue;
        }

        out.push(tok.to_string());
        i += 1;
    }

    out.join(" ")
}

/// Subsequence match with a bonus for consecutive runs and for prefix matches.
/// Returns `None` when `query` is not a subsequence of `target`.
fn fuzzy_score(query: &str, target: &str) -> Option<i32> {
    let q: Vec<char> = query.to_lowercase().chars().collect();
    let t: Vec<char> = target.to_lowercase().chars().collect();
    if q.is_empty() {
        return Some(0);
    }
    if q.len() > t.len() {
        return None;
    }

    let mut qi = 0usize;
    let mut score = 0i32;
    let mut last: Option<usize> = None;

    for (i, ch) in t.iter().enumerate() {
        if qi >= q.len() {
            break;
        }
        if *ch == q[qi] {
            score += 10;
            match last {
                Some(l) if i == l + 1 => score += 15,
                Some(l) => score -= (i - l - 1).min(20) as i32,
                None => score -= (i.min(20)) as i32,
            }
            last = Some(i);
            qi += 1;
        }
    }

    if qi < q.len() {
        return None;
    }

    let qs: String = q.iter().collect();
    let ts: String = t.iter().collect();
    if ts.starts_with(&qs) {
        score += 60;
    }
    // Shorter targets that fully contain the query rank above sprawling ones.
    score -= (t.len() as i32).min(80) / 4;
    Some(score)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fuzzy_prefers_prefix_and_contiguity() {
        assert!(fuzzy_score("git", "git status").unwrap() > fuzzy_score("git", "nn git").unwrap());
        assert!(fuzzy_score("gs", "git status").is_some());
        assert!(fuzzy_score("zzz", "git status").is_none());
    }

    #[test]
    fn like_escaping() {
        assert_eq!(escape_like("50%_a\\b"), "50\\%\\_a\\\\b");
    }

    #[test]
    fn masks_credentials_only() {
        assert_eq!(mask_secrets("app --password=hunter2"), "app --password=***");
        assert_eq!(mask_secrets("app --token abc123"), "app --token ***");
        assert_eq!(
            mask_secrets("export GITHUB_TOKEN=ghp_xxx"),
            "export GITHUB_TOKEN=***"
        );
        assert_eq!(
            mask_secrets("curl -H x --api-key=sk-123 https://a.b"),
            "curl -H x --api-key=*** https://a.b"
        );
        // Ordinary commands must pass through untouched.
        assert_eq!(mask_secrets("git status -s"), "git status -s");
        assert_eq!(mask_secrets("echo a=b"), "echo a=b");
        assert_eq!(mask_secrets("make -j16"), "make -j16");
    }
}
