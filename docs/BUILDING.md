# 构建指南

从一台干净的 Windows 机器到跑起来，以及会踩到的坑。

所有命令可直接粘进 PowerShell。需要管理员的步骤会标注。

> 下文用 `D:\Projects\TermDeck` 作为仓库路径示例，换成你自己的实际路径即可。

---

## 前置要求

| 组件 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20 | 前端构建 |
| Rust | ≥ 1.77 | 后端，需 MSVC 工具链 |
| VS 2022 生成工具 | C++ 工作负载 | 提供 `link.exe` 与 Windows SDK |
| WebView2 运行时 | — | Win11 自带；Win10 可能需手动装 |

---

## 1. 拉代码并装依赖

```powershell
git clone https://github.com/ixuhan/TermDeck.git
cd TermDeck
npm install
```

仓库自带 `.npmrc`，已指向国内镜像（`registry.npmmirror.com`）。官方源在国内实测 8 分钟装 0 个包，不要改回去。

---

## 2. 安装 Rust（装进仓库目录，不碰用户目录）

> ⚠️ **坑 1**：`static.rust-lang.org` 的二进制下载在国内常被中断（curl 直接 SIGTERM，无任何报错）。必须走镜像。

```powershell
$env:RUSTUP_DIST_SERVER = "https://rsproxy.cn"
$env:RUSTUP_UPDATE_ROOT  = "https://rsproxy.cn/rustup"

# 先把两个 HOME 指到仓库内，rustup 就装在这里
$env:CARGO_HOME  = "D:\Projects\TermDeck\.toolchain\cargo"
$env:RUSTUP_HOME = "D:\Projects\TermDeck\.toolchain\rustup"
New-Item -ItemType Directory -Force -Path "D:\Projects\TermDeck\.toolchain" | Out-Null

Invoke-WebRequest -Uri "https://rsproxy.cn/rustup/dist/x86_64-pc-windows-msvc/rustup-init.exe" `
  -OutFile "$env:TEMP\rustup-init.exe"

& "$env:TEMP\rustup-init.exe" -y --default-host x86_64-pc-windows-msvc --profile default --no-modify-path
```

`--no-modify-path` 是有意的：不往系统 PATH 塞东西，由 `scripts\_env.bat` 临时注入。

**验证**（必须带环境变量，否则找不到工具链）：

```powershell
$env:CARGO_HOME="D:\Projects\TermDeck\.toolchain\cargo"
$env:RUSTUP_HOME="D:\Projects\TermDeck\.toolchain\rustup"
& "D:\Projects\TermDeck\.toolchain\cargo\bin\cargo.exe" --version
```

若报 `no default is configured`，补一句：

```powershell
& "D:\Projects\TermDeck\.toolchain\cargo\bin\rustup.exe" default stable-x86_64-pc-windows-msvc
```

---

## 3. 配置 crates 源

新建 `<仓库>\.toolchain\cargo\config.toml`：

```toml
[source.crates-io]
replace-with = "rsproxy-sparse"

[source.rsproxy-sparse]
registry = "sparse+https://rsproxy.cn/index/"

[net]
git-fetch-with-cli = true
```

没有这一步，拉依赖会非常慢甚至超时。

---

## 4. 安装 VS 2022 生成工具（需要管理员）

> ⚠️ **坑 2**：Rust 的 MSVC 目标必须有 `link.exe` 和 Windows SDK 的 `.lib`。
> 想用 GNU 工具链（mingw）绕开是行不通的 —— Tauri 依赖的 `webview2-com-sys`
> 链接的是 MSVC 格式静态库，mingw 的 `ld` 链不了。

```powershell
winget install --id Microsoft.VisualStudio.2022.BuildTools -e `
  --accept-package-agreements --accept-source-agreements `
  --override "--quiet --wait --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

- 约 3.6 GB，10–25 分钟
- 会弹一次 UAC，**必须点「是」**，否则静默失败
- 安装器不支持自定义路径，只能落在系统盘

**验证**：

```powershell
& "C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe" -latest -products * `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath

Get-ChildItem "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\VC\Tools\MSVC"
Get-ChildItem "C:\Program Files (x86)\Windows Kits\10\Lib"
```

两个目录都要有输出。

---

## 5. 构建与运行

```powershell
cd D:\Projects\TermDeck
scripts\build.bat          # 生产构建（exe）
scripts\build.bat --bundle # 生产构建 + NSIS 安装包
scripts\run.bat            # 启动已构建的 exe
scripts\release.bat        # 直接产出便携 zip
```

构建相关辅助脚本：

```powershell
scripts\kill-build.bat     # 清理中断构建残留的进程，释放 target 锁
scripts\clean.bat          # 清增量缓存（保留依赖）
scripts\clean.bat --full   # 清整个 target
```

开发模式（前端热更新）：

```powershell
scripts\dev.bat
```

只跑前端、不装 Rust 也能看界面 —— 浏览器下会走内置的模拟 Shell：

```powershell
npm run dev              # http://localhost:1420
```

---

## 脚本做了什么

`scripts\_env.bat` 手工拼装 MSVC 环境，**不调用 `vcvars64.bat`**：

> ⚠️ **坑 3**：`vcvars64.bat` 内部会调用 `reg.exe` 查注册表。在启用了「命令安全 / 程序黑名单」
> 的机器上，`reg.exe` 被拦截，导致 `LIB` / `INCLUDE` 没被设置，链接时报
> `LNK1181: 无法打开输入文件 kernel32.lib`。
> `_env.bat` 直接用目录扫描定位 MSVC 与 SDK 版本，绕开注册表。

它做四件事：

1. 扫 `VC\Tools\MSVC\14.*` 得到 MSVC 版本，扫 `Windows Kits\10\Lib\10.*` 得到 SDK 版本
2. 设置 `PATH`（cl.exe / link.exe / rc.exe）、`INCLUDE`、`LIB`
3. 设置 `CARGO_HOME` / `RUSTUP_HOME` 指向 `<仓库>\.toolchain`
4. 设置 `NPM_CONFIG_CACHE` 指向 `<仓库>\.cache\npm`

> 如果你的机器没有安全策略限制，用官方「x64 Native Tools Command Prompt」也完全可行，
> 效果等价。

---

## 验证环境

```powershell
# 1) 工具链就绪
cmd /c "scripts\_env.bat && cargo --version && rustc --version"

# 2) Rust 单测
scripts\test.bat

# 3) 前端构建（含类型检查）
npm run build

# 4) UI 自动化（需另开窗口跑 npm run dev）
node scripts\shot.mjs
```

`shot.mjs` 全部通过会打印 `==== 15 passed, 0 failed ====`。

---

## 常见问题

| # | 现象 | 原因 | 处理 |
| --- | --- | --- | --- |
| 1 | `curl` 下载 rustup-init 无输出直接中断 | 官方源被阻断 | 走 `rsproxy.cn` |
| 2 | `npm install` 长时间无进展 | 官方 registry 不可达 | `.npmrc` 已指 npmmirror |
| 3 | `LNK1181: 无法打开输入文件 kernel32.lib` | `vcvars64.bat` 依赖 `reg.exe`，被安全策略拦截 | 用 `scripts\_env.bat` |
| 4 | `rustup could not choose a version of rustc` | 没设 `CARGO_HOME`/`RUSTUP_HOME`，或没设默认工具链 | 见第 2 节验证段 |
| 5 | 编译超过 20 分钟没结束 | release 全量 LTO + `codegen-units=1` | 已改为 thin LTO + 16 单元，正常 8–15 分钟 |
| 6 | 窗口全白，进程却在跑 | 用 `cargo build` 代替 `tauri build`，缺 `custom-protocol` feature，二进制仍指向 devUrl | 一律用 `scripts\build.bat` |
| 7 | 窗口白屏且日志只有 `app starting` | Win10 缺 WebView2 运行时 | 装 [WebView2 Evergreen](https://developer.microsoft.com/microsoft-edge/webview2/) |
| 8 | `.bat` 报「不是内部或外部命令」且引号错乱 | 用 UTF-8 中文写了 `.bat` 注释，cmd 按 OEM 代码页解析 | `.bat` 保持纯 ASCII |
| 9 | `error: cached cgu ... should have an object file, but doesn't` | 增量编译缓存损坏，常见于杀毒扫描或进程被强杀 | 删掉 `src-tauri\target\release\incremental` 后重试；频繁出现可设 `CARGO_INCREMENTAL=0` |

---

## 构建为什么慢，怎么变快

如果一次改动要等 3-8 分钟，通常是下面三件事之一。

### 1. `Blocking waiting for file lock on build directory`

不是卡死，是**排队**。cargo 对 `target\.cargo-lock` 加独占锁，第二个构建不会失败，
只会一直打印这一行，直到第一个构建结束。真实来源通常是：

- 上一个构建还没跑完（或被中断后进程没退干净）
- 同时开了两个终端各跑一次
- 编辑器插件在后台跑 `cargo check`，持有同一把锁

```powershell
scripts\kill-build.bat    # 清掉残留的 cargo / rustc，释放锁
```

`scripts\build.bat` 现在会在启动前检测已有 cargo 进程并直接退出，不会再干等。

### 2. 每次都要重编整个 `termdeck(bin)`

原来 release profile 开了 `lto = "thin"`。thin LTO 每次构建都要把所有依赖的
codegen unit 重新过一遍，于是改一行前端代码也要重编 400 多个单元。
终端应用的瓶颈在 PTY I/O 和渲染，不在指令数，所以现在默认 `lto = false`：

```toml
[profile.release]
lto = false
codegen-units = 16
```

需要极致体积时单次覆盖即可，不用改文件 —— 在 PowerShell 里设环境变量
`CARGO_PROFILE_RELEASE_LTO=thin` 再跑 `scripts\build.bat`。

### 3. 用错了构建方式

日常改 UI **不要**跑 release 构建。`scripts\dev.bat`（`tauri dev`）带热更新，
前端改动秒级生效，只有 Rust 侧改动才需要重编。

真正需要出包时再跑 `scripts\build.bat`。

### 关于增量缓存

release 构建默认开启增量编译，重建只需十几秒。这个缓存对文件锁敏感，
偶发 `os error 5` 或 `cached cgu ... should have an object file`。此时：

```powershell
scripts\clean.bat          # 只清 incremental，保留已编译依赖
scripts\clean.bat --full   # 清整个 target，下次全量重编
```

> **不要删 `target\release\deps\termdeck.*`。** 删掉会强制整个 app crate 全量重编，
> 那正是「每次都要等好几分钟」的元凶之一。

---

## 磁盘与耗时

| 项 | 体积 | 首次耗时 |
| --- | --- | --- |
| Rust 工具链 | 1.5 GB | 3–6 min |
| crates 缓存 | ~0.6 GB | 随编译增长 |
| `src-tauri/target` | ~2 GB | — |
| VS Build Tools | 3.6 GB | 10–25 min |
| `node_modules` | ~250 MB | 1–2 min |
| **合计** | **约 8 GB** | **约 25–45 min** |

全部工具链与缓存都留在仓库目录内（`.toolchain\`、`.cache\`），卸载时连同目录一起删即可。
唯一例外是 VS 生成工具，只能装在系统盘。
