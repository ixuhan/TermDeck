# 变更记录

## v0.2 — 首轮验收反馈修复

验收提出的 12 项问题全部处理，并补齐了自动化断言（`scripts/regress.mjs`）。

| # | 问题 | 根因 | 处理 |
| --- | --- | --- | --- |
| 1 | 点 `+` 新建会话菜单显示异常 | 菜单 `right:0` 定位、宽 272px，而侧栏仅 240px，整块被挤出窗口左边缘 | 改左对齐 + 独立层叠上下文 + 超长可滚动 |
| 2 | 点关闭按钮软件退不掉 | `win.destroy()` 缺 `core:window:allow-destroy` 权限，静默失败 | 补权限 + 保存后强制 destroy，失败回退 close |
| 3 | 重启后命令历史消失 | 每次启动生成新 PTY id，历史按它索引 → 全部孤儿 | 拆成「稳定 `key`」+「临时 `ptyId`」 |
| 4 | 输入框左侧缺历史入口 | — | 新增历史按钮，点开历史浮层 |
| 5 | 载入模板后像所有会话都变了 | 实际只改当前会话，但下拉框不重置，切换会话仍显示模板名 | 切换会话时重置下拉 |
| 6 | 补全采纳按键不可配 | 硬编码 Tab / → | 设置里可勾选 Tab / → / Ctrl+→ / ↑，多选 |
| 7 | 预设导出导入走剪贴板 | — | 改为「导出/导入指令集」，写入 `<data>/exports/*.json`，导入带文件列表 |
| 8 | 切换会话后手动锁定失效 | `activate()` 无条件把 mode 重置为 input | 锁定时保持 passthrough |
| 9 | 锁定状态下点「填入」无反应 | 内容写进了被折叠的输入框 | 填入时自动退出直通并解除锁定 |
| 10 | 切换目录后重启回到默认目录 | `profile.cwd` 从不更新 | OSC 7 + `cd` 追踪双通道，实时写回并持久化 |
| 11 | 数据散落在系统盘 | 使用 `app_data_dir()` | 改为 `<exe 目录>/data`，状态栏显示路径并可打开 |
| 12 | 常驻内存偏高 | 所有会话无条件起 PTY | 恢复时按需启动、回滚行数可调、WebGL 可关 |

### 顺手修掉的 3 个内部缺陷

- **toast 永久悬浮挡住点击**：`.quick-notice` 没有 CSS animation，`onAnimationEnd` 永不触发，状态永不清理。补 fade 动画 + `pointer-events:none`。
- **受控输入字符错序**：`pendingCaret` 在值未变化时不被消费，残留条目会把后续输入的插入位置拉回旧光标（输入 `git` 变成 `itg`）。改为 `{text,pos}` 且仅在渲染值匹配时消费。
- **Vite 首次模块转换 33 秒**：`watch.ignored` 未排除 `.toolchain`（1.5 GB）与 `target`（2 GB），补上后 0.61 秒。

### 实测数据（2 会话 Idle）

| 项 | 数值 |
| --- | --- |
| termdeck.exe（Rust 宿主） | 66.6 MB |
| WebView2（6 进程） | ~439 MB |
| conhost + shell | ~88 MB |
| **合计** | **~593 MB** |
| 空闲 CPU（10s 采样） | **0%** |
| 关闭 WebGL 后 | 577 MB（省约 16 MB） |

WebView2 运行时本身即 400 MB 量级，SRS 中 150 MB 的目标在该技术栈上不可达。可用杠杆是「会话按需启动」与「减少同时打开的会话数」。

---

## v0.1 — 首个可运行版本

- 打通 Tauri v2 + ConPTY + xterm 的端到端链路。
- 实现会话管理、Command Bar、Ghost Text、TUI 直通、历史浮层、快捷指令、SQLite 隔离历史、工作区还原。
- 建立自动化验收：`scripts/shot.mjs`（15 项）、`scripts/app-e2e.mjs`（真实应用）、`scripts/restore-test.mjs`（重启还原）。

### 首版验证记录

真实桌面应用日志：

```
workspace_load -> miss
create_session -> PowerShell 7 (pwsh.exe)
session sess_f42e... spawned (pid=16872)
workspace_save ok (2330 bytes)
```

| 项 | 结果 |
| --- | --- |
| 真实 PowerShell 提示符与命令输出 | ✅ |
| Ghost Text 走真实 SQLite 历史 | ✅ `REAL_GHOST=[mdeck-real-pty-ok]` |
| Tab 采纳 | ✅ `REAL_ADOPTED=[echo termdeck-real-pty-ok]` |
| 重启还原（重命名 + 会话树 + 快捷指令） | ✅ |
| Rust 单测 | ✅ 3 / 3 |
| 浏览器 Mock 套件 | ✅ 15 / 15 |
