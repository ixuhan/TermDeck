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
scripts\build.bat        # 生产构建
scripts\run.bat          # 启动
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
