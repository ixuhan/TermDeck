use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// A shell launch profile, e.g. PowerShell 7 / WSL Ubuntu / Git Bash.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub name: String,
    pub executable: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// Result of spawning (or restarting) a PTY session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    pub pid: Option<u32>,
}

/// Row of the per-session command history.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryEntry {
    pub command: String,
    pub executed_at: i64,
    pub execution_count: i64,
    pub cwd: Option<String>,
    pub score: i32,
}

/// A shell detected on this machine, offered as a quick-create option.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedShell {
    pub name: String,
    pub executable: String,
    pub args: Vec<String>,
    pub kind: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyDataPayload {
    pub session_id: String,
    pub data: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyExitPayload {
    pub session_id: String,
    pub code: i32,
}
