# Research: In-app Tailscale → private Termix backend

**Branch:** `research/tailscale-backend-access` (worktree: `worktree-research-tailscale-backend-access`)  
**Date:** 2026-08-05  
**Goal:** Let a mobile user join a Tailscale tailnet (via key), then reach a Termix backend that is **not** exposed on the public internet — e.g. `http://192.168.5.166:PORT`.

---

## 1. Problem statement

Today Termix Mobile is a thin client of a self-hosted Termix server:

```
Phone → (must route to) → Termix HTTP/WS origin → proxies SSH/RDP/Docker/…
```

Server address is a single `serverUrl` (`http(s)://host:port`) entered in AuthFlow and stored in AsyncStorage. There is **no** VPN / Tailscale / tunnel code in the app.

Users on cellular / foreign Wi‑Fi cannot reach a LAN-only backend unless something bridges that path. Tailscale is the natural bridge.

---

## 2. Clarifications (important)

### 2.1 “TS API key” vs auth key

| Kind | Prefix (typical) | What it does |
|---|---|---|
| **Auth key** | `tskey-auth-…` | Joins a **device/node** into the tailnet without browser login. This is what you want for “connect phone into TS network”. |
| **API access token** | `tskey-api-…` | Calls Tailscale **control plane API** (list devices, create keys, ACLs). Does **not** put the phone on the wire. |

User intent almost certainly means **auth key** (optionally **generated** via API token on a backend you control).

Docs: [Auth keys](https://tailscale.com/kb/1085/auth-keys), [tailscale up](https://tailscale.com/kb/1241/tailscale-up).

### 2.2 `192.168.5.166` is a LAN address, not a Tailscale address

| Address class | Example | How a phone reaches it over TS |
|---|---|---|
| Tailscale node IP | `100.x.y.z` | Node runs Tailscale; peer dials CGNAT IP / MagicDNS |
| MagicDNS | `termix.tailnet-name.ts.net` | Same, name → 100.x |
| **LAN RFC1918** | `192.168.5.166` | **Requires a subnet router** on that LAN advertising e.g. `192.168.5.0/24`, plus ACL + route approval |

So “enter `http://192.168.5.166:XXX` after joining TS” only works if the tailnet has an approved **subnet route** covering that prefix.  
Otherwise prefer exposing Termix itself on Tailscale (`100.x` / MagicDNS) and use that as `serverUrl`.

Docs: [Subnet routers](https://tailscale.com/kb/1019/subnets).

### 2.3 What the app actually needs after “on network”

All of these must reach the same origin:

| Traffic | Path today |
|---|---|
| REST | axios → `http(s)://serverUrl/...` |
| SSH terminal | RN `WebSocket` → `ws(s)://serverUrl/ssh/websocket/?token=` |
| Docker console | RN `WebSocket` |
| Guacamole / OIDC | `react-native-webview` (system WebView networking) |

Any Tailscale solution must cover **fetch + WebSocket + WebView**, not only REST.

---

## 3. Current app integration points

| Area | File | Notes |
|---|---|---|
| Server URL UX | `app/authentication/AuthFlow.tsx` | Validates `/^https?:\/\//`, saves config |
| Config store | `app/main-axios.ts` `saveServerConfig` / `getCurrentServerUrl` | Single global origin |
| Type | `types/index.ts` `ServerConfig` | `{ serverUrl, lastUpdated }` |
| Terminal WS | `app/tabs/sessions/terminal/NativeWebSocketManager.ts` | `new WebSocket(url)` — no custom agent |
| SSL / cleartext | `plugins/with*` | Cleartext OK; **local SSL bypass is RFC1918/link-local only** — **not** `100.64/10` |

**Implication for Tailscale HTTPS:** self-signed certs on `100.x` / `*.ts.net` will **not** get the existing Android local-hostname SSL bypass. Prefer HTTP on private nets, public CA, or user-installed CA (or extend bypass to CGNAT / MagicDNS).

---

## 4. Feasibility of approaches

### Option A — Out-of-process: official Tailscale app (already works)

**Flow**

1. User installs [Tailscale iOS/Android](https://tailscale.com/download).
2. Joins tailnet (SSO, or admin-issued **auth key** in client UI where supported).
3. Ensure path to backend:
   - Termix on a TS node → use `http://100.x.y.z:PORT` or MagicDNS; **or**
   - Subnet router advertises `192.168.5.0/24` → use `http://192.168.5.166:PORT`.
4. In Termix Mobile AuthFlow, enter that URL as today.

**Pros**

- Zero Termix code for VPN.
- Full system VPN: axios, WS, WebView all “just work”.
- Apple/Google already approved Tailscale’s Network Extension / VpnService.
- iOS/Android auto-accept subnet routes.

**Cons**

- Two apps; user must enable VPN.
- Auth key UX lives in Tailscale app, not Termix.
- Cannot force “must be on TS before login” inside Termix without reachability probes.

**Verdict:** **Supported today.** Best default recommendation for self-hosters.

---

### Option B — In-app system VPN (embed Tailscale TUN)

Run Tailscale as a **Packet Tunnel Provider** (iOS Network Extension) / **VpnService** (Android) inside Termix, join with auth key, install routes, then use normal `serverUrl`.

**Pros**

- One app; all traffic types covered.
- Can gate AuthFlow on “Tailscale connected”.

**Cons / blockers**

- **No official Tailscale mobile embedding SDK** for third-party apps.
- Would mean vendoring/porting `tailscaled` + platform tunnel plumbing (what Tailscale’s own apps do).
- iOS: Network Extension entitlement, App Store review, always-on VPN scrutiny, separate extension target, keychain access groups, NE packet APIs.
- Android: foreground service, VPN consent dialog, OEM battery kills.
- Binary size, update lag vs upstream Tailscale, security responsibility (you become a VPN vendor).
- Expo: needs custom dev client + multi-target native project (doable with config plugins, still large).

**Verdict:** **Possible in theory, not practical** without Tailscale partnership or a multi-month native effort. Not recommended as first step.

---

### Option C — In-process userspace node (`tsnet` / gVisor) via native Go module

[tsnet](https://pkg.go.dev/tailscale.com/tsnet) embeds a Tailscale node with userspace stack:

```go
s := &tsnet.Server{Hostname: "termix-mobile", AuthKey: key, Ephemeral: true}
conn, err := s.Dial(ctx, "tcp", "192.168.5.166:8080")
// or s.HTTPClient() for HTTP over tailnet
```

**Auth key:** first-class (`Server.AuthKey` / `TS_AUTHKEY`).

**Critical gap for React Native**

| API | Uses system network stack? | Auto-uses tsnet? |
|---|---|---|
| RN `fetch` / axios | Yes | **No** |
| RN `WebSocket` | Yes | **No** |
| WebView | Yes | **No** |
| `tsnet.Dial` / `HTTPClient` | Userspace | Yes, only if you call it |

So embedding tsnet alone does **not** make `http://192.168.5.166` work in AuthFlow. You must either:

1. **SOCKS5/HTTP proxy local loopback** (`tsnet`/`tailscaled --tun=userspace-networking` style) **and** force every client through it — RN has **poor** first-class SOCKS support for fetch/WS/WebView; or  
2. **Replace transports**: custom native HTTP + WS that dial via tsnet, and stop using WebView for Guacamole/OIDC (or inject proxy into WebView — platform-specific and fragile); or  
3. **Userspace TUN + VPN API** — collapses into Option B.

**gomobile / Expo module**

- Ship a small Go library: `up(authKey)`, `status()`, `dial(host,port)`, maybe local SOCKS.
- Android easier than iOS (bitcode/extension/signing).
- Still need the transport rewrite above.

**Verdict:** **Technically interesting for a constrained “API-only” path; incomplete for Termix** unless you also rebuild networking. High complexity, medium risk.

---

### Option D — `@tailscale/connect` (JS + WASM)

NPM: [`@tailscale/connect`](https://www.npmjs.com/package/@tailscale/connect) — browser Tailscale client from `cmd/tsconnect`.

| Fact | Detail |
|---|---|
| Artifact | `main.wasm` ~**25 MB** uncompressed (~6 MB gz) |
| Target | Browser / WASM, not RN Hermes native networking |
| RN | No practical path to route native axios/WS/WebView through it |

**Verdict:** **Not suitable** for Termix Mobile native app.

---

### Option E — Productized “guided external VPN” (recommended product middle ground)

Don’t embed Tailscale. Add Termix UX that:

1. Documents / deep-links to install Tailscale.
2. Optional fields: auth-key instructions (or open TS app), expected backend URL templates (`100.x`, MagicDNS, LAN via subnet router).
3. **Reachability probe** before login (`HEAD /status` with timeout) + clear errors (“not reachable — is Tailscale connected? subnet route approved?”).
4. Optional: store secondary `serverUrl` candidates (LAN vs TS) and try in order when offline/online — still no VPN code.

**Verdict:** **Best ROI** if Option A is the operational model.

---

### Option F — Don’t put phone on TS; put a public edge in front

Cloudflare Tunnel / Pangolin / reverse proxy with auth (app already has reverse-proxy / OIDC WebView flows). Backend stays private; phone hits a public hostname.

**Verdict:** Already partially supported; orthogonal to Tailscale. Good for users who refuse a second VPN app.

---

## 5. Recommended architecture if building *something*

### Phase 0 — Validate ops path (no app change)

On the home network:

1. Install Tailscale on the Termix host **or** on a always-on subnet router.
2. If using LAN IP `192.168.5.166`: advertise `192.168.5.0/24`, approve route, ACL allow.
3. On phone: official Tailscale app → join → open Termix → `http://192.168.5.166:PORT` (or better `http://100.x:PORT`).
4. Confirm REST login + SSH WebSocket + one WebView path.

If this fails, in-app embedding will fail the same way (routing/ACL), so fix infra first.

### Phase 1 — UX only (small PR)

- Settings / AuthFlow: “Connecting over Tailscale?” help sheet.
- Optional URL presets / validation tips for `100.64.0.0/10` and `.ts.net`.
- Better offline errors from `probeServer`.
- Consider treating Tailscale CGNAT like “private” for SSL hostname bypass (careful security tradeoff).

### Phase 2 — Only if product requires in-app join

Spike **one** platform first (Android VpnService or tsnet+custom dial for REST-only proof):

1. Auth key in SecureStore (never AsyncStorage).
2. Ephemeral tagged node (`tag:termix-mobile`) + ACL.
3. Prefer MagicDNS / 100.x as `serverUrl` after `Up()`.
4. Measure: binary size, connect time, battery, App Store policy.

Do **not** promise iOS+Android system VPN in one sprint.

### Auth key security (if ever stored in app)

| Practice | Why |
|---|---|
| Prefer **one-off** or short-lived keys | Stolen reusable keys enroll attacker devices |
| Prefer **tagged** + **ephemeral** nodes | ACL as `tag:termix-mobile`, auto-cleanup |
| Generate keys via **your** backend using TS API token | Phone never holds a powerful reusable key |
| Store material in **SecureStore** | JWT today is AsyncStorage — don’t repeat for TS keys |
| Device approval / tailnet lock policies | Org hardening |

Creating keys: admin console or API with OAuth client / API token ([auth keys KB](https://tailscale.com/kb/1085/auth-keys)).

---

## 6. Mapping to “user story”

> 用户先连入 tailscale 网络（通过 ts api key），然后再去访问后端 `http://192.168.5.166:XXX`

| Step | Feasible? | How |
|---|---|---|
| Join tailnet with a key | Yes | Auth key in official TS app, or embed (hard) |
| Reach `192.168.5.166` | Yes **iff** subnet router + approved routes + ACL | Not automatic from auth key alone |
| Then use Termix as today | Yes | `serverUrl = http://192.168.5.166:XXX` once OS routes there |
| All of the above **inside** Termix without second app | **Hard** | No official SDK; system VPN or full transport rewrite |

---

## 7. Effort / risk matrix

| Approach | Effort | Risk | Covers WS+WebView | Recommend |
|---|---|---|---|---|
| A Official TS app + URL | None–docs | Low | Yes | **Yes (default)** |
| E Guided UX + probes | S | Low | Yes | **Yes** |
| F Tunnel / reverse proxy | Ops | Low | Yes | Yes (alt) |
| C tsnet native + custom transport | L–XL | High | Only if rewritten | Spike only |
| B Full in-app VPN | XL | Very high | Yes | No (unless strategic) |
| D WASM connect | — | — | No | No |

---

## 8. Concrete recommendation

1. **Treat infra as the feature:** run Termix (or a subnet router) on the tailnet; document auth-key join via official mobile Tailscale; use `100.x`/MagicDNS preferably over raw `192.168.x` unless subnet routes are intentional.
2. **Ship product polish in Termix** (Phase 1): help copy, reachability errors, maybe dual URL / private-range SSL tweak — **not** a VPN engine.
3. **Revisit in-app VPN only** if a hard requirement appears (e.g. MDM forbids second VPN app, or consumer SKU must be one-tap). Then budget for native specialists and App Store process; start with Android spike + auth-key-from-backend.

---

## 9. Open questions for product

1. Is the backend **only** on LAN (`192.168.5.166`), or can it run Tailscale and use `100.x` / MagicDNS?
2. Is a **second app** (official Tailscale) acceptable for v1?
3. Who issues keys — end user admin console, or Termix server mints ephemeral auth keys via TS API?
4. Multi-user: one shared tagged key vs per-user nodes?
5. Must Guacamole/OIDC WebView work over the same path on day one?

---

## 10. References

- [Auth keys](https://tailscale.com/kb/1085/auth-keys)
- [Subnet routers](https://tailscale.com/kb/1019/subnets)
- [Userspace networking](https://tailscale.com/kb/1112/userspace-networking)
- [tsnet package](https://pkg.go.dev/tailscale.com/tsnet)
- [tsconnect / @tailscale/connect](https://github.com/tailscale/tailscale/tree/main/cmd/tsconnect)
- App networking hub: `app/main-axios.ts`
- Server entry UX: `app/authentication/AuthFlow.tsx`
