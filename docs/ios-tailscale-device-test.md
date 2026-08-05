# iOS 真机验证：Termix + userspace Tailscale

本地没有 Xcode 时，用 GitHub Actions 出 IPA，装到 iPhone 上测。

## 0. 推送前（本机）

实现在分支：

- `worktree-research-tailscale-backend-access`（worktree 路径  
  `.claude/worktrees/research-tailscale-backend-access`）

建议推一个清晰远程分支名，例如 `research/tailscale-backend-access`：

```bash
cd .claude/worktrees/research-tailscale-backend-access

# 可选但推荐：先对齐上游 main，再推（当前 worktree 可能偏旧）
git fetch origin main
git rebase origin/main   # 有冲突再解

git push -u origin HEAD:research/tailscale-backend-access
```

**不要**直接推到你正在用的其它功能分支，避免串改。

## 1. CI 出 iOS 包

仓库已有：

| Workflow | 用途 |
|---|---|
| **Build and Push App** (`.github/workflows/app.yml`) | EAS local → 签名 IPA（preview adhoc / production） |
| **Build iPadOS App** (`.github/workflows/build-ipados.yml`) | 未签名 IPA（artifact） |

两者在 **prebuild / EAS 之前** 都会：

1. `actions/setup-go`  
2. `make -C modules/termix-tailscale/native ios` → `modules/termix-tailscale/ios/lib/libtermix_ts.a`  
3. 再 `npm ci` 之后的原有 iOS 构建  

若跳过 Go 步骤，IPA 只会链上 **stub**，UI 里 Tailscale 开关会提示 native 不可用或 `Up` 失败。

### 推荐：adhoc 真机（与现有一致）

1. GitHub → **Actions** → **Build and Push App** → **Run workflow**  
2. 选：  
   - **platform:** `apple`  
   - **action:** `file`（产物上传 artifact）  
3. 等 macOS job 结束，下载 **termix_ios_universal** artifact 里的 IPA。  
4. 用你们平时的方式装到手机（adhoc / 企业签 / 现有分发渠道）。  
   - `eas.json` preview iOS 为 `enterpriseProvisioning: adhoc`，需账号里已有对应证书与设备 UDID。

### 备选：未签名 IPA

**Build iPadOS App** → artifact `termix_ipados_*`。  
需自行重签 / 侧载工具，一般不如 EAS adhoc 省事。

## 2. Tailscale 侧准备（测之前）

1. [Admin console](https://login.tailscale.com/admin) 建 **auth key**  
   - 建议：one-off 或短过期、`preauthorized`、带 tag（如 `tag:termix-mobile`）  
   - **不要**用可复用长期 key 写进文档或截图外传  
2. Termix 后端可达路径二选一：  
   - **更好：** 后端主机装 Tailscale → 记下 `100.x.y.z` 或 MagicDNS  
   - **LAN IP（如 192.168.5.166）：** 同网有 **subnet router** 广播该网段，且路由已批准 + ACL 放行  
3. ACL 允许该 key/tag 访问 Termix 的 HTTP 端口。

## 3. 手机上点哪里

1. 打开刚装的 Termix。  
2. 进服务器配置（AuthFlow / Change server）。  
3. 打开 **Connect via Tailscale**。  
   - 若灰掉并提示 custom native build → IPA **没带上** `libtermix_ts.a`，查 CI 是否跑了 Go 步骤、pod 是否 vendored 到 archive。  
4. **Auth key** 粘贴 `tskey-auth-…`。  
5. **Server Address** 填例如：  
   - `http://100.x.y.z:8080`  
   - 或 `http://termix-host.tailnet-name.ts.net:8080`  
   - 或（有 subnet router 时）`http://192.168.5.166:8080`  
6. **Continue** → 应看到 “Joining Tailscale…”，然后进入登录。  
7. 密码登录成功后：开一个 SSH 终端，确认 WebSocket 正常。

Settings → Active Server 应显示你填的 **display** 地址，并带 *via Tailscale*；传输实际是 `127.0.0.1` 转发（界面不强制展示端口）。

## 4. 通过 / 失败对照

| 现象 | 可能原因 |
|---|---|
| 开关不可用 / “native module” | 装的是旧 IPA 或 CI 未编 Go lib |
| Join 超时 / auth 失败 | key 错、过期、需 approve、control 不可达 |
| Join 成功但 “Could not reach server” | 目标不是 100.x 且无 subnet route；ACL 拦了；端口错；后端只 HTTPS 而转发按 TCP 明文到该端口 |
| 登录可以终端不行 | 少见；确认 WS 也走同一 origin（应自动走 localhost forward） |
| 仅 HTTPS 后端证书报错 | 转发是 TCP 到远端端口，但 app 用 `http://127.0.0.1` 访问本地端；**私网请优先 HTTP** |

## 5. 安全提醒

- 测完可在 Admin 里 **revoke** 测试 key / 删测试节点。  
- Auth key 在设备 **SecureStore**，不要用可复用 god-key。  
- 测试 IPA 勿公开发布若内含调试能力即可；key 本身不在 IPA 里。

## 6. CI 失败时先看

1. Job 日志 **Build Termix Tailscale iOS archive** 是否绿。  
2. 是否有 `libtermix_ts.a` `ls -lh` 输出。  
3. EAS/xcodebuild 链接错误：缺 `-lresolv` / Security 等（podspec 已加，若仍失败贴日志）。  
4. Go 版本：workflow 使用 `1.24.x`，与 `go.mod` 对齐。
