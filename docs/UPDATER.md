# 自动更新

安装版会自己检查并安装新版本；便携版不做自动更新（原因见下文）。

## 它怎么工作

```
启动 8 秒后（静默）
  └─ GET https://github.com/ixuhan/TermDeck/releases/latest/download/latest.json
       ├─ 版本比当前新 → 右下角提示，设置面板里出现「立即更新」
       └─ 否则 → 什么都不做，不打扰

点「立即更新」
  ├─ 下载安装包到临时目录
  ├─ 用编译进二进制的公钥验签（Ed25519）
  ├─ 验签通过 → 调起 NSIS 安装程序（passive 模式，显示进度条）
  └─ 安装完成自动重启，工作区原样恢复
```

关键点：**验签在客户端做**。即使有人劫持了下载链接塞进一个改过的安装包，没有私钥签不出有效签名，客户端会直接拒绝安装。

`latest.json` 和 `.sig` 由 CI 在发版时自动生成，不需要手动维护。

## 密钥

一对 Ed25519 密钥，两个角色完全分开：

| 位置 | 内容 | 说明 |
| --- | --- | --- |
| `src-tauri/tauri.conf.json` → `plugins.updater.pubkey` | **公钥** | 提交进仓库，无所谓泄露 |
| GitHub 仓库 Settings → Secrets → `TAURI_SIGNING_PRIVATE_KEY` | **私钥** | 只存在于 GitHub，CI 用它签名 |
| 本地 `.cache/updater/termdeck.key` | **私钥** | 已 gitignore，仅用于本机测试构建 |

> **私钥丢了会怎样：** 已经装出去的旧版本内嵌的是旧公钥，只有配套私钥签的包才会被接受。
> 私钥一旦丢失，所有已安装的副本就再也无法自动更新，只能让用户手动下载重装。
> 请把 `.cache/updater/termdeck.key` 复制到密码管理器或离线备份里。

私钥当前**没有设置密码**。如果要加密码，用
`npx tauri signer generate -w <新路径>` 重新生成一对（会换公钥，等于放弃旧版本的自动更新路径），
然后把密码存进 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`。

## 首次配置（只需要做一次）

本地密钥已经生成好了，你只需要把它放进 GitHub：

1. 打开 `https://github.com/ixuhan/TermDeck/settings/secrets/actions`
2. **New repository secret**
   - Name: `TAURI_SIGNING_PRIVATE_KEY`
   - Value: `.cache/updater/termdeck.key` 的**全部内容**（包括 `untrusted comment:` 那一行）
3. 再建一个 `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`，值留空（当前私钥无密码）

配好之后，推 tag 发版就会自动带上签名和 `latest.json`。

## 发版

```bash
# 1. 三个文件同步版本号
#    package.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml
npm install --package-lock-only

# 2. 提交并打 tag
git add -A && git commit -m "chore(release): v0.3.2"
git tag -a v0.3.2 -m "TermDeck v0.3.2"
git push origin main --tags
```

CI 会产出并上传到同一个 Release：

```
TermDeck_0.3.2_x64-setup.exe        安装包
TermDeck_0.3.2_x64-setup.exe.sig    签名
TermDeck-0.3.2-portable.zip         便携版
latest.json                          更新清单（客户端的检查入口）
```

用户下一轮启动就会看到更新提示。

## 为什么便携版不自动更新

便携版的约定是"整个文件夹拷走就能迁移，`data\` 跟着走"。自动更新的本质是运行 NSIS 安装程序，
它会装到 `%LOCALAPPDATA%\TermDeck`，结果是：程序在系统目录、数据还在原来的便携文件夹，
用户有了两份副本，且下次双击便携版那个 exe 又回到旧版本。

所以便携版在设置里只提示"请下载新包覆盖"，不发更新请求。

判定方式由后端 `install_kind` 命令给出：数据目录与 exe 同级 → 便携版。

## 排错

**设置面板显示"检查失败"**

`latest.json` 走 `github.com` 域名。如果本机访问不了 GitHub（企业网络、代理），检查会失败。
这不影响使用，自动检查是静默的，失败不提示。

**提示有新版本，但下载后没反应**

看 `%LOCALAPPDATA%\TermDeck\logs` 或应用数据目录里的 `termdeck.log`。
最常见原因是安装程序被 UAC 拦下，或目标目录的文件正被占用（先完全退出旧版本）。

**想手动验证清单**

```
https://github.com/ixuhan/TermDeck/releases/latest/download/latest.json
```

内容应该包含 `version`、`pub_date`、`platforms.windows-x86_64.signature` 和 `url`。
如果没有 `.sig` 或签名对不上，说明 CI 上的私钥 secret 没配好。

## 本地测试更新流程

本地构建默认不带签名（`scripts\build.bat` 走 `--no-bundle`）。
要完整走一遍安装流程：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .cache\updater\termdeck.key -Raw
scripts\build.bat --bundle
```

但 NSIS 工具链要从 `github.com` 下载，本机网络受限时会失败 —— 这种情况下用 CI 验证。
