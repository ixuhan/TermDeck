# 发布指南

三种出包方式，按你的网络环境选。

| 方式 | 产物 | 需要联网到 github.com | 适用场景 |
| --- | --- | --- | --- |
| A. 便携版 zip | `TermDeck-x.y.z-portable.zip` | ❌ 不需要 | 自己用、发给别人、离线环境 |
| B. NSIS 安装包 | `TermDeck_x.y.z_x64-setup.exe` | ✅ 需要（首次） | 想要「下一步下一步」的安装体验 |
| C. GitHub Actions | 安装包 + 便携版 | ✅ 在 CI 里跑 | 正式发版、给仓库打 Release |

---

## A. 便携版（推荐，本机一条命令）

```bat
scripts\release.bat
```

它会依次做三件事：

1. `npx tauri build --no-bundle` 构建 release exe
2. 组装 `release\TermDeck-<版本>-portable\`：exe + 说明 + README + LICENSE
3. 打包成 `release\TermDeck-<版本>-portable.zip`

产物约 **8 MB**，解压双击即用，不需要安装、不写注册表。

**数据是跟着文件夹走的。** 首次运行会在 exe 同级生成 `data\` 目录，历史、配置、日志全在里面。
换机器整个文件夹拷走即可；删掉 `data\` 就是恢复出厂设置。

---

## B. NSIS 安装包（本机，需要 GitHub 可达）

```bat
scripts\release.bat --installer
```

在便携版基础上，额外跑一次完整的 `npx tauri build`，产出
`src-tauri\target\release\bundle\nsis\TermDeck_<版本>_x64-setup.exe`。

### 这一步为什么可能失败

Tauri 打 NSIS 安装包时，`tauri-bundler` 会**在运行时**去 `github.com` 下载 NSIS 工具链
（`nsis-3.13.zip` 等）到 `%LOCALAPPDATA%\tauri\NSIS\`。如果本机访问不了 github.com：

```
Downloading https://github.com/tauri-apps/binary-releases/releases/download/nsis-3.13/nsis-3.13.zip
failed to bundle project: `CONNECT proxy failed: proxy server responded 502/502`
```

**这不是配置错误。** exe 已经构建成功了，只是安装器外壳打不出来。

### 三种解法

1. **用便携版**（最省事，功能完全一样）。
2. **给 `tauri build` 挂一个能到 GitHub 的代理**，再重跑 `scripts\release.bat --installer`。
3. **手动预置 NSIS**：把 `nsis-3.13.zip` 解压到 `%LOCALAPPDATA%\tauri\NSIS\nsis-3.13\`，
   让 bundler 跳过下载。注意它还会拉 NSIS 插件（`nsis_tauri_utils.dll`），不一定一次就能凑齐。

---

## C. GitHub Actions（正式发版用这个）

仓库里已经配好 `.github/workflows/release.yml`，在 CI 里打包，网络不受本机限制。

### 用法

```bat
git tag v0.2.0
git push origin v0.2.0
```

推 tag 后自动触发：构建 → 跑 Rust 单元测试 → 打包 NSIS 安装包 → 生成**草稿 Release** →
再补一个便携版 zip 传上去。到仓库的 Releases 页面检查无误后点 Publish 即可。

也可以在 Actions 页面手动 `Run workflow` 触发（不会创建 Release，只验证构建）。

### workflow 做了哪些事

```yaml
windows-latest 上：
  checkout → Node 20 + npm 缓存 → Rust stable + cargo target 缓存
  → npm ci → cargo test
  → tauri-action（建 Release、传安装包）
  → 组装便携版 zip 并上传到同一个 Release
```

Release 说明里带了 CHANGELOG 链接，草稿状态是为了让你先验收再发布。

---

## 版本号改哪里

三个文件必须一致，否则 Tauri 构建会报版本不匹配：

| 文件 | 字段 |
| --- | --- |
| `package.json` | `"version"` |
| `src-tauri/tauri.conf.json` | `"version"` |
| `src-tauri/Cargo.toml` | `version` |

改完记得同步 lockfile：

```bat
npm install --package-lock-only
```

`src-tauri/Cargo.lock` 会在下次 `cargo build` 时自动更新。

---

## 产物一览

```
release/
├── TermDeck-0.2.0-portable/         解压即用的目录
│   ├── TermDeck.exe
│   ├── README-portable.txt
│   ├── README.md
│   └── LICENSE
└── TermDeck-0.2.0-portable.zip      分发用压缩包（~8 MB）

src-tauri/target/release/
├── termdeck.exe                     原始构建产物
└── bundle/nsis/*.exe                仅当安装包构建成功时存在
```

---

## 用户机器需要什么

- Windows 10 1809+ / Windows 11（x64）
- **WebView2 运行时**：Windows 11 自带；Windows 10 若缺失，装一次
  [Microsoft Edge WebView2 Evergreen Runtime](https://developer.microsoft.com/microsoft-edge/webview2/)。
  NSIS 安装包会把这一步做进安装流程，便携版需要用户自己确认。

---

## 排错

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `CONNECT proxy failed: 502` | GitHub 不可达 | 用方式 A 或 C |
| `error: unexpected argument '--bundle'` | Tauri CLI 参数是 `--bundles` | 用 `scripts\release.bat`，别直接敲 |
| 便携版双击没反应 | 系统缺 WebView2 | 装 Evergreen Runtime |
| 安装包体积异常大 | 没走 release profile | 确认用的是 `tauri build` 而不是 `cargo build --release` |
| zip 里没有 `data/` 目录 | 正常，首次运行才生成 | — |
