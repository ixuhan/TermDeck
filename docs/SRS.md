# TermDeck 需求规格说明书（SRS）

| 项 | 内容 |
| --- | --- |
| 产品名称 | TermDeck（Windows 增强型定制终端） |
| 文档版本 | v1.0（需求基线） |
| 文档状态 | 待评审（Draft for Review） |
| 目标平台 | Windows 10 1809+ / Windows 11，x64 |
| 核心定位 | 具备工作流辅助、跨 Shell 统一现代输入、物理级会话隔离与冷启动无缝恢复的高性能桌面终端 |
| 编写日期 | 2026-11-01 |

### 修订记录

| 版本 | 日期 | 修订内容 | 状态 |
| --- | --- | --- | --- |
| v0.1 | 2026-11-01 | 原始需求草稿（用户提供） | 已归档 |
| v1.0 | 2026-11-01 | 结构化重构：补需求编号/优先级/验收标准、状态机、快捷键矩阵、边界场景、里程碑；修正历史表 DDL 与去重逻辑冲突；标注 3 项指标风险 | 待评审 |

---

## 0. 术语表

| 术语 | 定义 |
| --- | --- |
| Session（会话） | 一个绑定了具体 Shell 进程、独立历史库、独立快捷指令快照的运行单元，对应左侧一个 Tab |
| PTY | 伪终端。Windows 下由 ConPTY 提供，承载 Shell 子进程的标准输入输出 |
| Alternate Screen Buffer | 终端的备用屏幕缓冲区，TUI 程序（vim/htop/less/ssh）进入时启用，退出时还原 |
| Command Bar | 主区域底部的现代命令输入框，独立于 Shell 自身的行编辑器 |
| Ghost Text | 光标后方渲染的灰色半透明预测补全文本 |
| History Palette | `Ctrl + R` 呼出的历史检索浮层 |
| Pass-through（直通模式） | 键盘事件不经 Command Bar，直接投递给 PTY 原生处理的模式 |
| Preset（预设库） | 可跨会话复用的快捷指令模板集合，装载时深拷贝为会话私有副本 |
| Clone-on-Load | 预设装载采用深拷贝，装载后与原预设脱钩 |

---

## 1. 项目概述

### 1.1 背景

Windows 平台现有终端在多任务开发场景下存在三个结构性痛点：

1. **长指令复用成本高**：编译、烧录、部署类长命令反复手打或从文档复制，缺少会话级的预测补全与高效检索。
2. **跨 Shell 输入体验割裂**：PowerShell、CMD、WSL、Git Bash 的行编辑器（PSReadLine / readline / cmdline）行为不一致，补全能力与快捷键各不相同，用户需为每个 Shell 维护一套肌肉记忆。
3. **会话上下文易污染**：历史记录、快捷键配置、工作目录在多标签、多项目并行时互相串味，重启后工作区无法还原。

### 1.2 目标

构建一款 Windows 桌面终端应用，在以下三方面提供差异化能力：

- **输入统一**：由应用自身而非 Shell 提供命令输入、Ghost Text 预测与历史检索，跨 Shell 体验一致。
- **隔离彻底**：会话在进程、历史、快捷指令三个维度上物理隔离，互不污染。
- **状态无损**：窗口布局、会话树、CWD、快捷指令、历史索引在退出后可 100% 还原。

### 1.3 非目标（Non-Goals）

明确排除，避免范围蔓延：

- ❌ 不做 SSH / SFTP / 串口 / Telnet 等内建远程连接管理器（用户可自行在 Shell 内调用 `ssh`）。
- ❌ 不做多窗口 / 分屏（Split Pane） / 标签拖出为独立窗口（列入 v1.2 评估）。
- ❌ 不做云同步、账号体系、团队共享。
- ❌ 不做 Shell 语法级智能补全（不解析 AST、不认识命令参数），仅做历史前缀匹配与模糊检索。
- ❌ 不替代系统默认终端，不接管 `Terminal.app` 注册项。
- ❌ 不做 Linux / macOS 版本（架构须保留跨平台可能，但不投入验证）。

### 1.4 目标用户

| 用户画像 | 典型场景 | 核心诉求 |
| --- | --- | --- |
| 嵌入式 / 固件工程师（主） | 同一工程下反复「编译 → 烧录 → 串口调试」，命令长且固定 | 快捷指令面板 + 长命令预测补全 |
| 后端 / 全栈开发者 | 本地 PowerShell + WSL 双环境切换 | 跨 Shell 统一输入体验，各自的独立历史 |
| 运维 / DevOps | 多客户环境并行，每个环境一套命令习惯 | 会话隔离 + 预设库快速切换 |

### 1.5 核心设计原则

| 原则 | 含义 | 落地约束 |
| --- | --- | --- |
| **P1 物理隔离** | 每个 Session 拥有独立 PTY 进程、独立快捷指令快照、物理隔离的历史数据 | 任何数据读写必须携带 `session_id`；禁止全局「当前会话」隐式兜底 |
| **P2 输入解耦** | 命令输入、Ghost Text、历史检索由终端模拟器自身实现，不依赖 Shell 行编辑器 | 不走 stdin 逐字符注入的模拟输入路线，采用整行 `\r` 提交 |
| **P3 退让透明** | 底层进入 TUI 时输入层无缝退出，退出 TUI 后自动恢复 | 检测必须基于 ANSI 序列事实，不得依赖进程名白名单猜测 |
| **P4 状态零丢失** | 布局、会话树、CWD、快捷指令、历史索引原子化落盘 | 采用「写临时文件 + 原子 rename」；崩溃后可恢复到最近一致快照 |

---

## 2. 系统架构与技术选型

### 2.1 架构总览

```text
┌─────────────────────────────────────────────────────────────┐
│                    Frontend (WebView2)                      │
│  ┌───────────────┐  ┌────────────────────────────────────┐  │
│  │ Left Sidebar  │  │ Terminal Area                      │  │
│  │ (Session Tabs)│  │ ├─ @xterm/xterm + WebGL Renderer   │  │
│  └───────────────┘  │ └─ Custom Command Bar (Input+Ghost)│  │
│                     │    └─ History Palette (Ctrl+R)     │  │
│  ┌───────────────┐  └────────────────────────────────────┘  │
│  │ Right Sidebar │                                          │
│  │ (Quick Preset)│                                          │
│  └───────────────┘                                          │
└──────────────────────────────┬──────────────────────────────┘
                               │ IPC (Binary Stream / Tauri Events)
┌──────────────────────────────▼──────────────────────────────┐
│                    Backend Core (Rust)                      │
│  ┌────────────────────┐ ┌────────────────────────────────┐  │
│  │ ConPTY Manager     │ │ Local Storage Engine           │  │
│  │ (portable-pty)     │ │ (SQLite / rusqlite)            │  │
│  │ ├─ PTY I/O Loops   │ │ ├─ Session Historical Database │  │
│  │ └─ Alt-Buffer Hook │ │ └─ Workspace Layout & Presets  │  │
│  └────────────────────┘ └────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 组件职责与边界

| 层次 | 选型 | 职责 | 明确不负责 |
| --- | --- | --- | --- |
| 宿主框架 | **Tauri v2 (Rust)** | 原生窗口生命周期、文件 I/O、Windows API 交互、常驻进程控制 | 不承担终端字符渲染 |
| PTY 适配 | **portable-pty (ConPTY)** | 为每个 Session 创建/回收子进程（pwsh / cmd / wsl / git-bash / 自定义 exe），管理 stdin/stdout 管道与窗口尺寸 | 不解析 ANSI 内容 |
| 数据持久化 | **SQLite (rusqlite)** | 会话隔离的历史记录存储、FTS 模糊检索、去重计数 | 不存布局 JSON（布局走 workspace_state.json） |
| 前端框架 | **React 19 + TypeScript + Vite** | UI 构建、状态管理（Zustand）、键盘事件分发与仲裁 | 不直接触碰 PTY |
| 终端渲染 | **@xterm/xterm + @xterm/addon-webgl** | ANSI/VT 序列解析、GPU 加速字符网格、备用缓冲区状态上报 | 不做输入法/预测逻辑 |

### 2.3 关键实现约束（供技术方案参考，非需求）

- **CWD 追踪**：优先依赖 Shell 上报的 OSC 7 转义序列（`\e]7;file://host/path\e\\`）；若 Shell 未上报，退化为 Windows API 查询子进程当前目录（`NtQueryInformationProcess` + PEB）。WSL 场景需做 `\\wsl$\<distro>\...` 与 `/home/...` 的双向映射，并注意 `wsl.exe` 与真实 shell 进程的父子关系。
- **恢复时的工作目录**：PowerShell 用 `-WorkingDirectory` 或启动后 `Set-Location`；CMD 用 `/K cd /d "<path>"`；WSL 用 `--cd`；路径不存在时回退到用户主目录并提示。
- **Alt-Buffer 检测**：监听 xterm.js 的 buffer 切换事件（`buffer.active.type === 'alternate'`），不要解析屏幕内容做启发式判断。
- **背压（Backpressure）**：PTY reader → 前端 采用有界通道 + 帧内批量合并；当未消费字节超过阈值（如 1 MB）时暂停读取，待前端 ack 后恢复。

---

## 3. 功能需求

> 优先级定义：**P0** = MVP 必须，缺一不可上线；**P1** = 首个正式版应有；**P2** = 可延后。

### 3.1 会话管理模块（Left Sidebar）

#### FR-SESSION-01 终端 Profile 配置 · P0

系统须支持配置并启动多种 Shell 实例，至少覆盖：

| Profile | 可执行文件 | 默认参数 |
| --- | --- | --- |
| PowerShell 7+ | `pwsh.exe` | `-NoLogo` |
| Windows PowerShell | `powershell.exe` | `-NoLogo` |
| 命令提示符 | `cmd.exe` | — |
| WSL 发行版 | `wsl.exe` | `-d <Distro>` |
| Git Bash | `bash.exe`（Git for Windows） | `--login -i` |
| 自定义 | 用户指定可执行文件路径 | 用户指定 |

**验收标准**
1. 用户可从预置列表一键创建会话，也可手填可执行文件路径 + 参数 + 起始 CWD。
2. 参数含空格或中文路径时能正确传递，不出现截断或乱码。
3. 每个 Session 可独立设置额外的环境变量（键值对），互不影响。
4. 可执行文件不存在时，创建动作失败并给出明确错误，不产生「半个 Tab」。

#### FR-SESSION-02 标签页操作 · P0

- 新增、关闭、重命名（双击标题或右键菜单进入编辑态，`Enter` 确认 / `Esc` 取消）。
- 鼠标拖拽调整 Tab 顺序，顺序须持久化。
- Tab 标题区须同时呈现三项信息：**自定义标题**（主）、**当前前台进程名**（次）、**当前工作目录**（截断显示，悬停显示全路径）。
- 空间不足时优先保证自定义标题完整，次信息以省略号收缩。

**验收标准**：拖拽排序后重启应用，顺序与退出前一致。

#### FR-SESSION-03 进程状态监听与就地重启 · P0

- 实时监听每个 PTY 子进程的存活状态。
- 进程正常或异常退出时，Tab 上显示状态标识与退出码（`Exit Code: N`），异常退出用警示色区分。
- 提供「重启本会话 PTY」操作，复用原 Profile + 最后 CWD，**保留原有历史库与快捷指令快照**（即重启不等于新建会话）。
- 进程退出后终端画布保留最后输出内容（不清屏），快捷指令面板保持可用。

**验收标准**：在会话内执行 `exit` 或触发崩溃，宿主进程不退出、其他会话不受影响、可一键重启恢复。

#### FR-SESSION-04 会话删除的确认与数据策略 · P1

- 关闭 Tab 与删除会话须区分：**关闭 Tab** = 结束进程但保留会话与其历史；**删除会话** = 二次确认后清理配置、快照与历史数据（默认策略可在设置中改为「仅归档」）。

---

### 3.2 终端交互与现代命令输入引擎

主区域垂直分为两层：上部为终端输出画布（xterm），下部为解耦的 Command Bar。

#### FR-INPUT-01 Command Bar 基础交互 · P0

- **输入接管**：常规模式下所有可打印字符进入 Command Bar，不直接写入 PTY。
- **现代编辑能力**：鼠标点选光标、`Home/End`、`Shift + 方向键` 选区、`Ctrl + C/V` 走系统剪贴板、`Shift + Enter` 换行（多行编辑）。
- **提交**：`Enter` 将输入框完整内容 + `\r` 经 IPC 发送至当前 Session 的 PTY，随后清空输入框并滚动到底。
- **多行保护**：含换行符的多行内容提交时，须以整体方式一次性写入（避免 Shell 逐行执行产生中间态）。
- **CJK / 宽字符**：Ghost Text 与光标定位须按 wcwidth 计算列宽，中文、Emoji、组合字符不得错位。

**验收标准**：输入含中文、Emoji 的混合命令，光标与 Ghost Text 视觉位置正确；粘贴 10 行脚本后回车，Shell 收到完整内容。

#### FR-INPUT-02 Ghost Text 预测补全 · P0

**触发**：输入框内容变化后，以当前文本为前缀，异步检索**当前 Session 独立历史库**。

**查询语义**（参考）：
```sql
SELECT command FROM session_history
WHERE session_id = ?1 AND command LIKE ?2 || '%'
ORDER BY execution_count DESC, executed_at DESC
LIMIT 1;
```

**渲染**：命中的未输入部分以灰色半透明文本吸附在光标之后；光标不在文本末尾时不渲染。

**采纳行为**

| 操作 | 行为 |
| --- | --- |
| `Tab` | 完全采纳，填充整条命令，光标置于末尾 |
| `Right Arrow`（仅当光标在文本末尾） | 完全采纳（与 Tab 等价） |
| `Ctrl + Right Arrow` | 按词部分采纳一个词元，可连续按 |
| 输入不匹配字符 / `Esc` | 放弃当前预测，清除 Ghost Text |

**性能与竞态要求**
1. 查询须带防抖（建议 30–60 ms）且异步，**不得阻塞按键渲染**（对应 NFR 的 ≤16 ms）。
2. 须做**请求序号丢弃**：用户快速输入时，旧查询结果返回后若输入已变化，必须丢弃，不得闪现过时预测。
3. 预测内容与当前输入完全相同时不渲染。

**验收标准**：连续快速输入 20 个字符无卡顿、无 Ghost Text 闪烁错乱；Tab 采纳后再次按 Tab 不再重复填充。

> ⚠️ 原需求 `ORDER BY timestamp DESC LIMIT 1` 只取最近一条，可能在多条同前缀命令间来回跳。本稿改为 `execution_count DESC, executed_at DESC`（见 5.1 的 `execution_count` 字段），并在「待决问题」中列为可选项。

#### FR-INPUT-03 TUI 直通模式（自动切换） · P0

**进入条件**：检测到 PTY 输出使终端切入**备用屏幕缓冲区（Alternate Screen Buffer）**，典型触发应用：`vim` / `nvim` / `nano` / `less` / `more` / `htop` / `ssh` / 交互式 Python/Node REPL / `man` 等。

**进入时行为**
1. Command Bar 平滑折叠（建议 120–160 ms 动画），终端画布占满主区域。
2. 焦点自动移交终端画布容器。
3. 所有键盘输入（含 `Tab`、`Ctrl+C`、方向键、`Esc`）原生直通 PTY，不进行任何拦截或改写。

**退出条件**：检测到备用缓冲区关闭（TUI 程序退出返回命令行提示符）。

**退出时行为**
1. Command Bar 平滑恢复显示。
2. 焦点自动回到 Command Bar（可设置中关闭「自动抢焦点」）。
3. 恢复后 Ghost Text 基于最新 CWD 与历史重新计算。

**边界要求**：嵌套场景（如 `ssh` 进入远端后再启动 vim）须正确跟随备用缓冲区的进出，不得停留在错误模式。

#### FR-INPUT-04 手动兜底切换 · P1

- 全局快捷键 `Ctrl + Shift + P`（可在设置中改键）手动在「Command Bar 模式」与「原生直通模式」间强制切换。
- 状态栏须有常驻指示器，显示当前模式（`⌨ 输入框` / `⇥ 直通`）及是否处于「自动/手动锁定」状态。
- 手动锁定优先级高于自动检测：用户手动锁定直通后，即使退出 TUI 也不自动切回，直至再次手动切换。

#### FR-INPUT-05 历史搜索浮层 History Palette · P0

**呼出**：Command Bar 激活状态下按 `Ctrl + R`，在输入框正上方弹出悬浮面板（不遮挡输入框，不改变主区域布局）。

**作用域**：仅检索**当前 Session 物理隔离的历史记录**，绝不跨会话。

**检索与排序**
- 以输入框当前文本为关键词，支持大小写不敏感的子串 / 模糊匹配（Fuzzy）。
- 排序：匹配得分降序 → 得分相同按 `executed_at` 降序。
- 结果项展示：命令原文（高亮命中片段）、执行时间（相对时间如「3 天前」）、执行次数（若有计数）。

**交互规格**

| 按键 | 行为 |
| --- | --- |
| `Up` / `Down` | 在结果列表间移动高亮 |
| `Enter` | 选中项写入 Command Bar 并**立即提交执行**，浮层关闭 |
| `Tab` | 选中项写入 Command Bar 但**不执行**，浮层关闭，光标置末尾待编辑 |
| `Esc` | 关闭浮层，**恢复呼出前输入框中的原有文本** |
| 继续输入 | 实时过滤，高亮重置到首项 |

**验收标准**：5000 条历史的会话中，`Ctrl + R` 首屏结果 ≤10 ms 渲染；`Esc` 后原文完整还原；`Enter` 后命令在 PTY 中执行且计入历史。

#### FR-INPUT-06 输入焦点仲裁 · P0

- 同一时刻只能有一个输入接收方（Command Bar / 终端画布）。
- 点击终端画布区域：若当前非 TUI 状态，焦点保持在 Command Bar（点击仅用于选中/复制文本）；若为 TUI 状态，焦点交给画布。此规则须在设置中可调整（「点击终端即进入直通」开关，默认关）。
- 应用窗口失去焦点再切回时，焦点须恢复到失焦前的接收方。

---

### 3.3 快捷指令系统（Right Sidebar）

#### FR-QUICK-01 指令属性模型 · P0

每个快捷项严格包含：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string (UUID v4) | 全局唯一 |
| `label` | string | 按钮展示名，如「拉取最新主干」，≤ 40 字符 |
| `command` | string | 静态命令文本，**不支持占位符/模板变量** |
| `auto_execute` | boolean | 见下 |

**执行模式**
- `auto_execute = true`：点击后命令立即注入 PTY 并追加 `\r` 执行，**同时写入当前 Session 历史库**。
- `auto_execute = false`：点击后仅将命令文本写入 Command Bar，光标置于末尾，不执行、不入库，等待用户追加参数或回车。

#### FR-QUICK-02 面板内编辑 · P0

- 新增、编辑（label / command / auto_execute）、删除、拖拽重排序。
- 编辑态须能标注 `label` 为空、`command` 为空的校验失败，禁止保存空命令项。
- 所有操作**仅作用于当前 Session**，实时生效并落盘。

#### FR-QUICK-03 预设库管理（Clone-on-Load）· P1

- **装载预设**：面板顶部下拉选择预设（如「嵌入式构建套件」「通用运维」），系统执行**深拷贝**，将预设按钮全量注入当前 Session。
- **深拷贝要求**：注入后每个快捷项获得**新的 `id`**，后续在会话内编辑/删除/排序**绝不**反向污染预设模板，也不影响其他已装载该预设的会话。
- **装载冲突策略**：装载前若当前面板已有内容，须提示三选一 —— 追加 / 覆盖 / 取消（默认追加）。
- **保存为预设**：可将当前 Session 的快捷列表保存为新预设，或覆盖已有预设（覆盖需二次确认）。
- **导入/导出**：全局预设库支持导出为单个 JSON 文件、从 JSON 导入（须做 schema 校验，非法文件给出字段级错误提示且不落盘）。

#### FR-QUICK-04 执行上下文 · P1

- 快捷指令在 PTY **忙**（前台进程运行中 / TUI 中）时的行为须明确：默认**排队**至提示符就绪后执行需复杂实现，MVP 采用**直接写入**并在 UI 上给出「终端忙，已写入」的轻提示；用户可在设置中改为「阻止并提示」。

---

### 3.4 历史记录与物理隔离

#### FR-HIST-01 物理存储隔离 · P0

- 统一 SQLite 存储服务，历史表以 `session_id` 作为**第一隔离键**，所有查询必须显式带 `session_id`。
- 单 Session 历史上限默认 **5,000 条**（可配置范围 500–50,000），超限按 **FIFO** 修剪（删除最旧的、且优先删除 low-value 记录——见 FR-HIST-04）。

#### FR-HIST-02 数据捕获时机 · P0

仅在以下两种路径触发入库：

1. 用户通过 Command Bar 按 `Enter` 提交（含 Ghost Text 采纳后提交、History Palette 中 `Enter` 直接执行）。
2. 用户点击 `auto_execute = true` 的快捷指令。

**明确不入库**：`auto_execute = false` 的填充动作、用户在 TUI 直通模式下输入的按键、由 Shell 自身历史机制记录的命令。

**记录字段**：`session_id`、`command`、`executed_at`（Unix ms）、`cwd`。

#### FR-HIST-03 去重与计数 · P1

同一 Session 内命令文本完全相同时不新增行，而是 `execution_count += 1`、`executed_at` 更新为最新时间。此策略直接支撑 Ghost Text 的「高频优先」排序。

> ⚠️ 原需求 DDL 缺少 `UNIQUE(session_id, command)` 约束却定义了 `execution_count`，两者矛盾。本稿在 5.1 中补齐约束与 upsert 语句。

#### FR-HIST-04 敏感命令处理 · P1

- 命令中包含明显的密钥/令牌模式（如 `--password=`、`--token=`、`export XXX_KEY=`）时，入库前对值做掩码（`***`）存储，原文仅存在于终端回滚缓冲。
- 提供「清空当前 Session 历史」与「清空全部历史」入口（二次确认）。

---

### 3.5 工作区持久化与会话恢复

#### FR-STATE-01 持久化内容矩阵 · P0

| 恢复维度 | 恢复粒度与行为 |
| --- | --- |
| 窗口与布局 | 窗口尺寸、屏幕位置（多显示器下含显示器编号）、最大化状态、左右侧边栏宽度与折叠状态 |
| 会话树结构 | 全部 Tab 会话项、自定义标题、排列顺序、当前激活的 Tab |
| Shell 与环境 | 每个 Tab 的 Profile（可执行文件 + 参数 + 环境变量）、退出前最后生效的 CWD，重启时在该目录拉起 Shell |
| 快捷指令列表 | 各 Session 私有快照的全部快捷项（`id` / `label` / `command` / `auto_execute` / 顺序） |
| 历史索引关系 | 重新挂载各 Session 的历史索引，`Ctrl + R` 与 Ghost Text 依然严格指向对应数据 |

#### FR-STATE-02 落盘时机与原子性 · P0

- **触发点**：窗口关闭、应用退出、以及状态变更后的**防抖自动保存**（建议 2 s 防抖 + 最长 10 s 强制落盘）。
- **原子性**：写 `workspace_state.json.tmp` → `fsync` → 原子 rename 覆盖。进程被强杀时最坏丢失最近 ≤10 s 的变更，文件本身不得损坏。
- **崩溃恢复**：启动时若主文件解析失败，回退读取 `.bak` 上一版本；两者均失效时以空工作区启动并提示，不得白屏。

#### FR-STATE-03 恢复的降级策略 · P1

| 异常 | 降级行为 |
| --- | --- |
| Profile 可执行文件已不存在 | 该 Tab 显示「Shell 不可用」，提供「选择新路径」与「删除此会话」 |
| 记录的 CWD 已不存在 | 回退到用户主目录，在 Tab 上给出一次性提示 |
| WSL 发行版已卸载 | 该 Tab 标记不可用，其余 Tab 正常启动 |
| 会话数量过多 | 全部恢复但仅自动拉起当前激活会话的 PTY，其余 UI 呈现 Tab 并在点击时懒加载（避免冷启动爆炸） |

> 最后一条为性能必要约束，与 4.1 冷启动指标直接相关，需产品确认是否接受「非激活会话首次点击有 ~100 ms 延迟」。

#### FR-STATE-04 单实例与启动行为 · P1

- 应用为单实例；重复启动时聚焦已有窗口并新建一个 Tab（可配置为仅聚焦）。
- 提供「恢复上次工作区」与「以干净工作区启动」两个入口（后者从托盘右键菜单或命令行参数 `--fresh`）。

---

### 3.6 设置模块（补充需求）

#### FR-SET-01 全局设置项 · P1

| 分组 | 设置项 | 默认值 |
| --- | --- | --- |
| 输入 | Ghost Text 开关 / 防抖时长 | 开 / 40 ms |
| 输入 | 点击终端是否进入直通模式 | 关 |
| 输入 | 自动抢焦点（退出 TUI 后回到 Command Bar） | 开 |
| 快捷键 | 直通切换、历史浮层、新建/关闭 Tab 等全部可改键 | 见第 6 章 |
| 历史 | 单会话上限条数 | 5,000 |
| 历史 | 敏感命令掩码 | 开 |
| 快捷指令 | 终端忙时的行为（写入 / 阻止） | 写入 |
| 外观 | 主题（浅/深/跟随系统）、字体、字号、行高、光标样式 | 跟随系统 |
| 数据 | 打开数据目录、导出/导入预设库、清空历史 | — |

#### FR-SET-02 配置文件位置 · P1

统一存放在**可执行文件同级的 `data/` 目录**（便携、自包含，状态栏可点击打开）：
`workspace_state.json`、`termdeck.db`、`presets.json`、`settings.json`、`termdeck.log`、`exports\`。
若安装目录只读，回退到 `%APPDATA%\as.ixuhan.termdeck\`。

> v0.2 变更：原方案为 `%APPDATA%\TermDeck\`，按验收反馈改为随程序目录自包含。

---

## 4. 非功能需求（NFR）

### 4.1 性能指标

| 编号 | 指标 | 目标值 | 测量条件 |
| --- | --- | --- | --- |
| NFR-P1 | 冷启动耗时 | **≤ 600 ms**（目标）/ ≤ 1000 ms（底线） | 双击图标 → UI 可交互 **且**首个激活 Shell 提示符就绪；Win11 / SSD / 冷缓存 |
| NFR-P2 | 输入渲染延迟 | ≤ 16 ms（单帧内） | Command Bar 按键 → 字符 + Ghost Text 像素呈现，P95 |
| NFR-P3 | 内存基线 | ≤ 150 MB（目标）/ ≤ 220 MB（底线） | 3 个 Idle 会话（Private Working Set，含 WebView2 子进程） |
| NFR-P4 | 历史检索响应 | ≤ 10 ms（5000 条，首屏） | `Ctrl + R` 键入到结果列表渲染 |
| NFR-P5 | 大吞吐吞吐量 | ≥ 20 MB/s 不丢失 | `cat` 大文件 / `yes` 类持续输出，PTY 到渲染不丢字节 |
| NFR-P6 | 空闲 CPU | ≤ 1% | 3 个 Idle 会话，60 s 平均 |

> ⚠️ **指标风险提示**（详见第 11 章 R1/R2）：`NFR-P1 ≤600ms` 与 `NFR-P3 ≤150MB` 在同代 WebView2 基线下非常紧张，建议采用「底线值」作为验收门槛，目标值作为优化方向。若坚持 600 ms，需引入「托盘常驻 + 隐藏窗口预热」策略，但这会改变「完全退出」的产品语义，需产品决策。

### 4.2 稳定性与容错

| 编号 | 需求 |
| --- | --- |
| NFR-S1 | **进程崩溃隔离**：任一 Tab 子进程崩溃（Segfault / OOM）不得导致宿主退出；须显示退出码，Tab 视图与快捷栏保持可用 |
| NFR-S2 | **I/O 背压**：大量输出时前端渲染可降频，后端 PTY 管道必须施加反压，禁止 UI 线程无响应（>500 ms 无响应即视为失败） |
| NFR-S3 | **前端隔离**：单个 xterm 实例的 JS 异常不得污染其他会话渲染 |
| NFR-S4 | **数据库容错**：SQLite 启用 WAL；写操作失败不得阻塞命令执行链路（历史丢失可接受，命令执行不可丢） |
| NFR-S5 | **长时运行**：连续运行 72 h、累计执行 10,000 条命令后，内存增长 ≤ 20%，无句柄泄漏 |
| NFR-S6 | **窗口尺寸极端值**：宽 400 px / 高 300 px 下 UI 不破版，侧边栏自动折叠 |

### 4.3 兼容性

- Windows 10 1809 及以上（ConPTY 稳定版起始版本）/ Windows 11 全版本，x64（ARM64 列为 P2）。
- 高 DPI：100% / 125% / 150% / 200% 缩放下字符网格清晰、无模糊。
- 输入法：微软拼音、搜狗拼音下 Command Bar 中文输入正常上屏，不吞字、不重复提交（组成期间 `Enter` 不得触发提交）。
- 终端兼容：正确解析常见 ANSI/VT 序列、256 色 / TrueColor、中文宽字符对齐。

### 4.4 安全与隐私

- 全部数据本地存储，无任何网络上报。
- 历史数据库不加密（明文），但须支持敏感掩码（FR-HIST-04）且在设置中明示这一点。
- 导入的预设 JSON 须做严格 schema 校验，`command` 字段不得触发自动执行（导入过程本身绝不执行命令）。

### 4.5 可维护性

- 后端 Rust 模块化：`pty` / `storage` / `workspace` / `ipc` 独立 crate 或 module，IPC 契约有类型定义（specta / ts-rs 生成 TS 类型）。
- 关键路径（会话创建、历史入库、状态落盘）须有结构化日志，日志按 7 天滚动。

---

## 5. 数据模型

### 5.1 历史记录表（SQLite DDL，已修正）

```sql
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS session_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id      TEXT    NOT NULL,
    command         TEXT    NOT NULL,
    executed_at     INTEGER NOT NULL,           -- Unix epoch milliseconds
    cwd             TEXT,
    execution_count INTEGER NOT NULL DEFAULT 1,
    UNIQUE (session_id, command)                -- 支撑去重计数（FR-HIST-03）
);

CREATE INDEX IF NOT EXISTS idx_session_command ON session_history (session_id, command);
CREATE INDEX IF NOT EXISTS idx_session_time    ON session_history (session_id, executed_at DESC);

-- 入库（去重 + 计数 + 刷新时间）
INSERT INTO session_history (session_id, command, executed_at, cwd)
VALUES (?1, ?2, ?3, ?4)
ON CONFLICT(session_id, command) DO UPDATE SET
    execution_count = execution_count + 1,
    executed_at     = excluded.executed_at,
    cwd             = excluded.cwd;

-- FIFO 修剪（保留最新 N 条）
DELETE FROM session_history
WHERE session_id = ?1
  AND id NOT IN (
    SELECT id FROM session_history
    WHERE session_id = ?1
    ORDER BY executed_at DESC
    LIMIT ?2
  );
```

> 说明：原需求同时要求「5000 条 FIFO」与「execution_count 计数」，但缺少唯一约束会导致去重失效、计数无法累加。已补齐 `UNIQUE` 与 upsert 语义。若坚持「每次执行都留一行」，则需删除 `execution_count` 字段，二者择一，已在「待决问题」中列出。

### 5.2 工作区状态快照（`workspace_state.json`）

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "version": "1.0.0",
  "window": {
    "width": 1440,
    "height": 900,
    "x": 100,
    "y": 80,
    "is_maximized": false,
    "left_sidebar_width": 240,
    "right_sidebar_width": 280,
    "right_sidebar_collapsed": false
  },
  "active_session_id": "sess_01HZX8A9K1",
  "sessions": [
    {
      "id": "sess_01HZX8A9K1",
      "title": "Build & Flash",
      "shell_profile": {
        "name": "PowerShell 7",
        "executable": "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
        "args": ["-NoLogo"],
        "cwd": "D:\\Workspace\\Embedded\\ProjectA",
        "env": { "PYTHONIOENCODING": "utf-8" }
      },
      "quick_shortcuts": [
        {
          "id": "btn_c8f1a",
          "label": "全量编译",
          "command": "ninja -C build all",
          "auto_execute": true
        },
        {
          "id": "btn_c8f1b",
          "label": "固件烧录",
          "command": "pyocd flash -t stm32f407vg build/app.bin",
          "auto_execute": false
        }
      ]
    },
    {
      "id": "sess_01HZX8A9K2",
      "title": "Linux Kernel Env",
      "shell_profile": {
        "name": "WSL Ubuntu",
        "executable": "wsl.exe",
        "args": ["-d", "Ubuntu-24.04"],
        "cwd": "/home/developer/src",
        "env": {}
      },
      "quick_shortcuts": [
        {
          "id": "btn_e1a2c",
          "label": "Git Status",
          "command": "git status -s",
          "auto_execute": true
        }
      ]
    }
  ],
  "global_presets": {
    "embedded_arm": [
      {
        "label": "编译全部",
        "command": "make -j16",
        "auto_execute": true
      },
      {
        "label": "清理构建",
        "command": "make clean",
        "auto_execute": true
      }
    ]
  }
}
```

**相对原稿的调整**
1. 新增 `window.x` / `window.y`（原文要求恢复「屏幕定位」但 schema 缺失该字段）。
2. `shell_profile` 新增 `env` 字段（对应 FR-SESSION-01 的环境变量配置）。
3. 明确 `version` 用于未来 schema 迁移，读取时须做版本兼容判断。

### 5.3 预设库文件（`presets.json`）

```json
{
  "version": "1.0.0",
  "presets": {
    "embedded_arm": {
      "name": "嵌入式构建套件",
      "description": "ARM 固件编译与烧录常用命令",
      "items": [
        { "label": "编译全部", "command": "make -j16", "auto_execute": true }
      ]
    }
  }
}
```

---

## 6. 快捷键矩阵

> 原则：不使用与 Shell 原生高频冲突的组合（如单独 `Ctrl+R`、`Ctrl+C`、`Tab`）；直通模式下全部快捷键让位给 PTY。

| 作用域 | 快捷键 | 行为 |
| --- | --- | --- |
| 全局 | `Ctrl + Shift + P` | 手动切换「Command Bar 模式 / 原生直通模式」 |
| 全局 | `Ctrl + Shift + T` | 新建会话（沿用当前 Profile） |
| 全局 | `Ctrl + Shift + W` | 关闭当前会话（保留历史） |
| 全局 | `Ctrl + Tab` / `Ctrl + Shift + Tab` | 切换到下/上一个会话 |
| 全局 | `Ctrl + Shift + E` | 折叠/展开右侧快捷指令面板 |
| Command Bar | `Enter` | 提交命令至 PTY |
| Command Bar | `Shift + Enter` | 输入换行（多行编辑） |
| Command Bar | `Tab` | 采纳 Ghost Text（无预测时不做补全） |
| Command Bar | `Right Arrow`（末尾） | 采纳 Ghost Text |
| Command Bar | `Ctrl + Right Arrow` | 按词采纳 Ghost Text |
| Command Bar | `Ctrl + R` | 呼出 History Palette |
| Command Bar | `Esc` | 放弃 Ghost Text / 关闭浮层并还原原文 |
| History Palette | `Up` / `Down` / `Enter` / `Tab` / `Esc` | 见 FR-INPUT-05 |

> ⚠️ 冲突说明：`Ctrl+R` 在 PowerShell 中原为 PSReadLine 的反向搜索，`Tab` 原为 Shell 补全，`Ctrl+Shift+P` 在 VS Code 中是命令面板。因 Command Bar 不向 PTY 逐字符发送，这些按键在本应用内不冲突；但**直通模式下必须完全让位**。

---

## 7. 核心交互状态机

```text
                    ┌──────────────────────────────┐
                    │  S0: CommandBar 模式 (默认)   │
                    │  焦点 = 输入框                │
                    └───┬──────────────┬───────────┘
      Alt-Buffer 出现    │              │ Ctrl+R
                        ▼              ▼
        ┌───────────────────────┐   ┌────────────────────────┐
        │ S1: 直通模式 (自动)    │   │ S2: History Palette    │
        │ 焦点 = 终端画布        │   │ 焦点 = 浮层            │
        │ 输入直通 PTY          │   │ Esc → 还原原文回 S0    │
        └───────┬───────────────┘   │ Enter → 执行 → S0      │
   Alt-Buffer 关闭│                 │ Tab   → 填充 → S0      │
                ▼                   └────────────────────────┘
        ┌───────────────────────┐
        │ 回到 S0（自动抢焦点）  │
        └───────────────────────┘
                ▲
                │ Ctrl+Shift+P（手动）
                ▼
        ┌───────────────────────┐
        │ S3: 手动锁定直通       │  ← 优先级最高，忽略自动检测
        │ 需再次 Ctrl+Shift+P 解锁│
        └───────────────────────┘
```

**状态优先级**：S3（手动锁定） > S2（浮层） > S1（自动直通） > S0（默认）。

---

## 8. 核心业务流程时序

```text
[ 用户输入字符 / 按键 ]
         │
         ├─── 当前状态: TUI 备用屏直通 ──────> 直接投递原始按键至 PTY (xterm.js Canvas)
         │
         └─── 当前状态: 常规命令输入模式
                  │
                  ├── 输入可打印字符 ────> 写入 Command Bar
                  │                         │
                  │                         └── 异步匹配该 Session 独立历史 (LIMIT 1)
                  │                                  │
                  │                                  └── 渲染光标后方灰色 Ghost Text
                  │
                  ├── 按下 [Tab] / [->] ───> 采纳 Ghost Text 填满输入框
                  │
                  ├── 按下 [Ctrl + R] ────> 弹出 History Palette
                  │                         │
                  │                         ├── 键入过滤词模糊查询当前 Session 历史
                  │                         ├── [Enter] ──> 选定命令，直接写入 PTY 执行
                  │                         └── [Tab]   ──> 选定命令，仅写入输入框供修改
                  │
                  └── 按下 [Enter] ────────> 将 Command Bar 内容包装为 '\r' 注入 PTY
                                            │
                                            ├── 插入该 Session 的 SQLite 历史库
                                            └── 清空输入框，滚动屏幕
```

---

## 9. 边界与异常场景清单

| 编号 | 场景 | 期望行为 |
| --- | --- | --- |
| E01 | 输入法组合中按 `Enter` | 仅上屏，不提交命令 |
| E02 | 粘贴含 `\r\n` 的多行文本 | 统一归一化为 `\r`，一次写入；若行数 > 20 给出确认提示 |
| E03 | 命令框为空时按 `Enter` | 向 PTY 发送一个 `\r`（等价空回车），不入库 |
| E04 | 会话在历史查询返回前被关闭 | 丢弃结果，不抛异常、不串到其他会话 |
| E05 | Tab 快速连续切换（>10 次/秒） | 不重复创建 PTY，最终仅保留目标会话活跃 |
| E06 | ID 为空的快捷指令被导入 | 自动补齐 UUID，不拒绝 |
| E07 | CWD 路径含空格/中文 | 恢复时正确加引号传递，不撕裂路径 |
| E08 | 同一预设被装载到两个会话后各自修改 | 互不影响（深拷贝验证点） |
| E09 | 磁盘写满 | 状态保存失败但不影响终端使用，托盘提示 |
| E10 | 用户关闭最后一个 Tab | 允许，显示空工作区引导页（新建会话 / 恢复上次） |
| E11 | TUI 中用户按 `Ctrl+Shift+P` 强制回 Command Bar | 允许，但 Terminal 仍处备用屏，UI 提示「当前有 TUI 运行」 |
| E12 | 杀掉 Session 进程后立即重启 | 旧 PTY 句柄完全释放，无僵尸进程残留 |

---

## 10. 里程碑与范围分期

### M1 · MVP（v1.0，核心闭环）

对应 P0 需求：单/多会话创建与 Tab 管理、xterm 渲染、Command Bar 输入与提交、Ghost Text、TUI 自动直通、History Palette、快捷指令面板（含会话私有编辑与执行）、历史入库与隔离、工作区持久化与恢复。

**MVP 验收门槛**：在新机器上创建 3 个不同 Shell 的会话 → 各执行 5 条命令 → 使用 Ghost Text 与 `Ctrl+R` 复用 → 关闭并重启 → 布局、Tab、CWD、快捷指令、历史全部还原。

### M2 · v1.1（体验完善）

P1 需求：预设库装载/保存/导入导出、手动直通切换、敏感命令掩码、状态降级策略、单实例与 `--fresh`、设置面板、去重计数。

### M3 · v1.2（可选扩展）

分屏、Tab 拖出、主题包、命令别名、ARM64、Shell 集成脚本（OSC 7 上报兜底）。

---

## 11. 风险登记

| 编号 | 风险 | 影响 | 缓解措施 |
| --- | --- | --- | --- |
| R1 | **冷启动 ≤600 ms 可能与 WebView2 冷启冲突** | 达标失败 | 测量基线后决定：(a) 放宽至 1000 ms；(b) 托盘常驻预热（牺牲「完全退出」语义）；(c) 首屏先渲染框架后挂 xterm |
| R2 | **内存 ≤150 MB（3 会话）压力大** | 达标失败 | WebView2 基座 + xterm WebGL 通常 120–180 MB；建议底线设 220 MB，并提供「WebGL/Canvas 渲染切换」降级开关 |
| R3 | Alt-Buffer 检测在 `ssh` 嵌套场景漏判 | 输入模式错乱 | 以 xterm buffer 事件为唯一事实源，不叠加启发式；补充嵌套场景测试用例 |
| R4 | CWD 追踪依赖 Shell 上报，非所有 Shell 均支持 | 恢复目录不准 | 双通道：OSC 7 + PEB 查询兜底；WSL 单独适配 |
| R5 | SQLite 写与命令执行链路耦合 | 高并发下卡输入 | 历史写入改异步队列，与 PTY 投递解耦 |
| R6 | 中文宽字符 Ghost Text 错位 | 观感差 | 使用 wcwidth 库计算列宽，纳入 CI 视觉回归用例 |
| R7 | 与输入法/剪贴板工具的兼容性 | 丢字、重复提交 | 覆盖微软拼音 + 搜狗 + Windows Terminal 剪贴板行为测试矩阵 |

---

## 12. 待决问题（Open Questions）

| # | 问题 | 选项 | 建议 |
| --- | --- | --- | --- |
| Q1 | 历史记录是「每次执行留一行」还是「去重 + 计数」？ | A 去重计数（推荐，支撑高频优先预测） / B 全量流水 | 选 A，并在 Palette 中显示执行次数 |
| Q2 | Ghost Text 命中多条同前缀时选哪条？ | A 最近执行 / B 执行次数最多 / C 最长公共前缀 | 建议 B，并对 A 做 tie-break |
| Q3 | 冷启动 600 ms 是否可放宽至 1000 ms？ | 见 R1 | 待首批实测后决策 |
| Q4 | 退出应用时是否保留子进程（Shell 常驻）？ | A 全部终止（推荐） / B 保留并重连（实现极复杂） | 选 A |
| Q5 | 会话之间是否需要「共享剪贴板式命令库」？ | 与隔离原则有张力 | MVP 不做 |
| Q6 | 是否需要「命令模板变量」（如 `${branch}`）？ | 原文明确不支持 | 保持不支持，v1.2 再评估 |

---

## 13. 验收清单（摘要）

- [ ] 支持 5 类 Shell Profile 创建并正确启动，错误路径有明确提示（FR-SESSION-01）
- [ ] Tab 新增/关闭/重命名/拖拽/状态码展示齐全，顺序持久化（FR-SESSION-02/03）
- [ ] Command Bar 支持多行编辑、中文与 Emoji、粘贴、清空（FR-INPUT-01）
- [ ] Ghost Text 全采纳 / 按词采纳 / 放弃三种路径正确，快速输入无闪烁（FR-INPUT-02）
- [ ] 启动 `vim` / `htop` / `ssh` 自动进入直通，退出自动恢复，嵌套场景正确（FR-INPUT-03/04）
- [ ] `Ctrl + R` 浮层作用域严格、四种按键行为符合规格、`Esc` 还原原文（FR-INPUT-05）
- [ ] 快捷指令 auto_execute 两种模式行为正确，编辑不跨会话污染（FR-QUICK-01/02）
- [ ] 预设装载为深拷贝（改 A 会话不影响 B 会话与原预设）（FR-QUICK-03）
- [ ] 历史严格按 session_id 隔离，FIFO 修剪生效，计数正确（FR-HIST-01/03）
- [ ] 关闭重启后 5 个维度（布局/会话树/Shell 与 CWD/快捷指令/历史索引）100% 还原（FR-STATE-01）
- [ ] 强杀进程后工作区文件不损坏，可回退 `.bak`（FR-STATE-02）
- [ ] 3 会话 Idle 内存、冷启动耗时、输入延迟、检索延迟实测达标（NFR-P1~P4）
- [ ] `cat` 大文件不卡 UI，字节不丢失（NFR-P5）
- [ ] 子进程崩溃宿主存活（NFR-S1）
