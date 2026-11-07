import { useEffect, useState } from "react";
import { ipc } from "../ipc";
import type { InstallKind, UpdateInfo } from "../types";

type Phase =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "current" }
  | { kind: "available"; info: UpdateInfo }
  | { kind: "downloading"; info: UpdateInfo; done: number; total: number }
  | { kind: "error"; message: string };

const pct = (done: number, total: number) =>
  total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;

export function UpdateSection() {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [installKind, setInstallKind] = useState<InstallKind>("installed");

  useEffect(() => {
    void ipc
      .installKind()
      .then(setInstallKind)
      .catch(() => setInstallKind("installed"));
  }, []);

  const check = async () => {
    setPhase({ kind: "checking" });
    try {
      const info = await ipc.checkUpdate();
      setPhase(info ? { kind: "available", info } : { kind: "current" });
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  const install = async (info: UpdateInfo) => {
    setPhase({ kind: "downloading", info, done: 0, total: 0 });
    try {
      // relaunch happens inside; this call only returns if it failed.
      await ipc.installUpdate((done, total) =>
        setPhase({ kind: "downloading", info, done, total }),
      );
    } catch (e) {
      setPhase({ kind: "error", message: String(e) });
    }
  };

  const busy = phase.kind === "checking" || phase.kind === "downloading";
  const portable = installKind === "portable";

  return (
    <>
      <div className="set-group-title">关于与更新</div>

      <div className="set-row">
        <div className="set-text">
          <span className="set-label">TermDeck v{__APP_VERSION__}</span>
          <span className="set-hint">
            {portable ? "便携版：更新请下载新包覆盖" : "从 GitHub Releases 检查更新"}
          </span>
        </div>
        <button className="mini-btn is-ghost" disabled={busy} onClick={() => void check()}>
          {phase.kind === "checking" ? "检查中…" : "检查更新"}
        </button>
      </div>

      {phase.kind === "current" && (
        <div className="update-note is-ok">已是最新版本</div>
      )}

      {phase.kind === "error" && (
        <div className="update-note is-error">检查失败：{phase.message}</div>
      )}

      {phase.kind === "available" && (
        <div className="update-card">
          <div className="update-head">
            <span className="update-version">发现新版本 v{phase.info.version}</span>
            {portable ? (
              <span className="update-tag">便携版</span>
            ) : (
              <button className="mini-btn" onClick={() => void install(phase.info)}>
                立即更新
              </button>
            )}
          </div>
          {phase.info.notes && <pre className="update-notes">{phase.info.notes}</pre>}
          {portable && (
            <div className="update-hint-line">
              便携版数据跟着文件夹走，自动更新会把程序装到系统目录、留下两份副本。
              请到 Releases 下载新包解压覆盖，`data\` 目录不会被影响。
            </div>
          )}
        </div>
      )}

      {phase.kind === "downloading" && (
        <div className="update-card">
          <div className="update-head">
            <span className="update-version">正在下载 v{phase.info.version}</span>
            <span className="update-pct">
              {phase.total > 0 ? `${pct(phase.done, phase.total)}%` : "…"}
            </span>
          </div>
          <div className="update-bar">
            <div
              className="update-bar-fill"
              style={{ width: `${pct(phase.done, phase.total)}%` }}
            />
          </div>
          <div className="update-hint-line">下载完成后会自动关闭并重启，会话与历史会原样恢复。</div>
        </div>
      )}
    </>
  );
}
