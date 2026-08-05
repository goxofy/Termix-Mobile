# Research: In-app Tailscale → private Termix backend

**Branch:** `research/tailscale-backend-access`  
**Date:** 2026-08-05 (rev 3 — implementation landed on this branch)  
**Goal:** User joins a Tailscale tailnet with an auth key **inside Termix**, then reaches a private backend such as `http://192.168.5.166:PORT` (or a `100.x` / MagicDNS host).

## Implementation status (this branch)

| Piece | Status |
|---|---|
| `modules/termix-tailscale` Expo module | ✅ scaffold (iOS bridge + stub; Android load-only) |
| Go `tsnet` local TCP forward (`TermixTS_*`) | ✅ compiles as host c-archive |
| AuthFlow toggle + auth key (SecureStore) | ✅ |
| `serverUrl` → `http://127.0.0.1:<port>` transport | ✅ |
| Cold-start rehydrate | ✅ best-effort via SecureStore key |
| iOS device `.a` in CI / local Xcode | ⬜ run `npm run build:tailscale-ios` then `npx expo prebuild` / EAS |
| Android full JNI | ⬜ follow-up |

See `modules/termix-tailscale/README.md`.

---

## 0. Correction vs first draft

First draft over-weighted “full system VPN / rewrite all RN networking” and under-weighted the **official embed path**:

| Source | What it gives us |
|---|---|
| [tailscale/libtailscale](https://github.com/tailscale/libtailscale) | Official **C library** wrapping userspace `tsnet`. Auth key, dial/listen, **loopback SOCKS5**, iOS static archives + **TailscaleKit** (Swift). |
| [wsvn53/scrcpy-mobile](https://github.com/wsvn53/scrcpy-mobile) | **Shipped App Store product** pattern: embed TS → `startForward(remoteHost, remotePort, localPort)` → app talks to **`127.0.0.1:localPort`** as if it were the remote. |

That pattern is **much simpler** than Network Extension / VpnService. It does **not** require hijacking the whole device network stack.

---

## 1. What we actually want (simple mental model)

```
┌─────────────────────────────────────────────────────────┐
│ Termix Mobile                                           │
│                                                         │
│  1) libtailscale / tsnet  up(authKey)                   │
│        → phone becomes a node on the tailnet            │
│                                                         │
│  2) local port forward                                  │
│        127.0.0.1:2xxxx  ──tsnet.Dial──►  target:PORT    │
│        target = 100.x / MagicDNS / (via subnet) 192.168 │
│                                                         │
│  3) existing app code unchanged in spirit:              │
│        serverUrl = http://127.0.0.1:2xxxx               │
│        axios / WebSocket / (most) traffic → localhost   │
│        which is bridged onto the tailnet                │
└─────────────────────────────────────────────────────────┘
```

User-facing flow:

1. Paste **Tailscale auth key** (and optional hostname).
2. App brings up embedded node (`tailscale_up` / `TailscaleNode.up()`).
3. User enters backend as today: `http://192.168.5.166:8080` or `http://termix.tailnet.ts.net`.
4. App **does not** open that host directly from JS. It:
   - parses host + port  
   - starts forward → free local port  
   - sets effective `serverUrl` to `http://127.0.0.1:<localPort>` (preserve path if any)  
5. Login / SSH WS / etc. hit localhost; Go side dials the real peer over Tailscale.

This is exactly how scrcpy-mobile’s `SessionNetworking` works:

- `useTailscale == false` → direct `host:port`
- `useTailscale == true` → `ensureConnected()` → `startForward(remote, remotePort, localPort)` → connect to `127.0.0.1:localPort`

---

## 2. Auth key vs API key (still important, but simple)

| Kind | Role in this design |
|---|---|
| **Auth key** `tskey-auth-…` | What the phone stores / uses to join. Primary UX field. |
| **API / OAuth client** | Optional: scrcpy auto-**mints** short-lived auth keys when the old one expires. Nice-to-have, not required for v1. |

v1: user pastes auth key (or admin pre-provisions one).  
v2: OAuth client id/secret + tag → create ephemeral keys (scrcpy already does this).

---

## 3. Official building blocks

### 3.1 libtailscale ([github.com/tailscale/libtailscale](https://github.com/tailscale/libtailscale))

C API (`tailscale.h`) — essentials:

```c
tailscale ts = tailscale_new();
tailscale_set_authkey(ts, "tskey-auth-...");
tailscale_set_hostname(ts, "termix-mobile");
tailscale_set_ephemeral(ts, 1);
tailscale_set_dir(ts, state_dir);
tailscale_up(ts);                          // join tailnet
tailscale_dial(ts, "tcp", "100.x.y.z:8080", &conn);  // userspace dial
tailscale_loopback(ts, addr, ..., proxy_cred, local_api_cred); // SOCKS5 on loopback
```

Also: `listen` / `accept`, `getips`, Funnel helper.

**Swift (Apple):** `swift/TailscaleKit` — `TailscaleNode`, `OutgoingConnection`, and:

```swift
// Official helper: URLSession → SOCKS5 via node.loopback()
let (config, _) = try await URLSessionConfiguration.tailscaleSession(node)
let session = URLSession(configuration: config)
// requests to https://server....ts.net go over the tailnet
```

Build targets in-tree: **macOS + iOS (+ sim)** archives. Android is **not** first-class in the Makefile (would be `GOOS=android` / NDK c-archive DIY, or a thin Go forwarder like scrcpy’s).

### 3.2 scrcpy-mobile pattern ([github.com/wsvn53/scrcpy-mobile](https://github.com/wsvn53/scrcpy-mobile))

They did **not** stop at raw `dial` for the UI layer. They wrapped a small Go library:

`porting/libtsnet` → **libtsnet-forwarder**

```c
update_tsnet_auth_key("tskey-auth-...");
tsnet_connect_async();
// when up:
tsnet_start_forward("100.78.206.85", 8000, 8080);
// app connects to 127.0.0.1:8080
tsnet_stop_forward(...);
```

Swift side (`TailscaleManager` / `SessionNetworking`):

1. Configure auth key + hostname + state dir (UserDefaults / Keychain-style settings).
2. `ensureConnected()` / wait until status OK.
3. Pick free local port in `20000–30000`.
4. `startForward(remoteHost, remotePort, localPort)`.
5. Hand `127.0.0.1:localPort` to the existing scrcpy/ADB client.
6. Optional: OAuth client regenerates auth key near expiry.

**Why this is elegant for apps like Termix:**

- Existing clients keep using normal TCP/HTTP/WS to **localhost**.
- No system VPN permission dialog for a full tunnel.
- No need to teach axios a custom dialer if localhost works.
- One forward per backend origin is enough for Termix (single `serverUrl`).

---

## 4. Mapping onto Termix Mobile

### 4.1 Today

| Piece | Behavior |
|---|---|
| `AuthFlow` | User enters `http(s)://host:port` |
| `saveServerConfig` | Stores one `serverUrl` |
| axios / `fetch` | System stack → that origin |
| `NativeWebSocketManager` | `new WebSocket(wsUrl)` same host |
| WebView (OIDC / Guacamole) | System WebView → same host |

### 4.2 With Tailscale (recommended Termix shape)

Add a thin native module (Expo module), conceptually:

```
modules/termix-tailscale/
  ios/   → link libtailscale or libtsnet-forwarder.a
  android/ → same Go c-shared / c-archive via NDK (extra work)
  src/   → JS API
```

JS API sketch:

```ts
type TailscaleConfig = {
  authKey: string;
  hostname?: string;
  ephemeral?: boolean;
};

await Tailscale.configure(config);
await Tailscale.up();                    // wait until connected
const { localPort } = await Tailscale.startForward({
  remoteHost: "192.168.5.166",           // or 100.x / magicdns
  remotePort: 8080,
});
// effective origin for the whole app:
await saveServerConfig({
  serverUrl: `http://127.0.0.1:${localPort}`,
  lastUpdated: new Date().toISOString(),
  // keep user-facing fields separately for UI:
  // displayUrl, tailscaleRemoteHost, ...
});
```

**AuthFlow UX (minimal):**

1. Toggle: “Connect via Tailscale”
2. Auth key field (SecureStore, not AsyncStorage)
3. Backend host field (can stay `http://192.168.5.166:8080` as **display / remote** URL)
4. On continue: `up` → `startForward` → save **localhost** as transport `serverUrl` → existing `probeServer` / login

**Settings:** Tailscale status (IP, MagicDNS, connected), regenerate key, disconnect / stop forwards.

### 4.3 WebSocket

`ws://127.0.0.1:localPort/ssh/websocket/?token=…` works if the forward is raw TCP (it is). Same for Docker console WS.

Path-prefix routing on the Termix reverse proxy is unchanged; only the host:port is localhost.

### 4.4 WebView caveat (real, but bounded)

| Feature | Uses | Over localhost forward? |
|---|---|---|
| REST + terminal WS | RN networking | Yes |
| Guacamole / OIDC WebView | WKWebView / Android WebView | **Usually yes** if page URL is also `http://127.0.0.1:port/...` |
| Absolute redirects to `https://real-host/...` inside OIDC | WebView leaves localhost | **Breaks** unless you also proxy or use system Tailscale |

Mitigations:

- Prefer password / TOTP native login over OIDC when using embedded TS, **or**
- Keep OIDC on a public URL, **or**
- Document “use official Tailscale app for OIDC/WebView-heavy setups”.

Guacamole if loaded as `http://127.0.0.1:port/guacamole/...` should be fine.

### 4.5 HTTPS / TLS to localhost

If backend is `https://192.168.5.166` with a cert for that name, terminating on localhost as `https://127.0.0.1` will **fail hostname verification**.

Practical options:

1. Prefer **HTTP** on the private side (Termix already allows cleartext).
2. Forward as TCP and use `http://127.0.0.1` if Termix speaks cleartext on that port.
3. If HTTPS is mandatory: terminate differently, or install CA + custom trust (messy on localhost name).

**Recommendation:** document cleartext or MagicDNS with proper certs on the **remote** side only when not rewriting to 127.0.0.1; for the forward pattern, **HTTP to private backends is the happy path**.

---

## 5. `192.168.5.166` still needs a path on the tailnet

Embedding libtailscale does **not** invent a route to arbitrary LAN IPs.

| Remote you enter | Requirement |
|---|---|
| `100.x.y.z` or `name.ts.net` | Peer (or service) on the same tailnet |
| `192.168.5.166` | Some node advertises subnet `192.168.5.0/24` (or host route), approved + ACL; **or** Termix host itself runs Tailscale and you use its `100.x` instead |

Ops checklist (once):

1. Termix host on TS **or** subnet router on that LAN.
2. ACL allows `tag:termix-mobile` (or user) → that IP:port.
3. Phone auth key preferably tagged + ephemeral.

---

## 6. Platform effort (realistic)

| Platform | Path | Effort |
|---|---|---|
| **iOS** | Official `libtailscale` iOS `.a` + C bridge Expo module, **or** copy scrcpy `libtsnet-forwarder` iOS build | **Medium** — proven in App Store app |
| **Android** | Build Go `c-shared`/`c-archive` with NDK; JNI Expo module; same forward API | **Medium–High** — no official android target in libtailscale Makefile, but Go + tsnet is portable |
| **Expo** | Config plugin: link static lib, headers, Gradle/CMake | Medium |
| **JS integration** | `ServerConfig` + AuthFlow + forward lifecycle | Small once native exists |

Binary size: expect **several–tens of MB** of native lib (Go + tsnet). Acceptable for a “pro” connectivity feature; gate behind optional native build / dev client (already using `expo-dev-client`).

---

## 7. Recommended product plan (simpler than before)

### Phase 0 — Ops proof (same as before, optional)

Official Tailscale app + `serverUrl` to `100.x` or subnet-routed `192.168.x` proves ACL/routes before writing native code.

### Phase 1 — Native spike (iOS first, scrcpy-shaped)

1. Expo module wrapping either:
   - **A.** scrcpy-style `tsnet_start_forward` (fastest product fit), or  
   - **B.** stock libtailscale `dial` + a tiny local TCP proxy written in Go/C (same idea).
2. Auth key in **SecureStore**.
3. AuthFlow toggle → up → forward → `serverUrl=http://127.0.0.1:port`.
4. Manual test: login + SSH websocket.

### Phase 2 — Android parity

Same C API surface from one Go package; Android Gradle links `.so`.

### Phase 3 — Polish

- Status UI, key expiry / OAuth mint (optional, scrcpy reference).
- Multi-forward if ever needed (Termix likely one).
- Clear errors: auth key invalid, not connected, forward failed, subnet unreachable.
- Don’t store reusable god-keys; prefer ephemeral tagged keys.

### Not required for v1

- System VPN / Network Extension  
- Routing **all** phone traffic through TS  
- `@tailscale/connect` WASM  
- Rewriting axios around a custom agent if localhost forward works  

---

## 8. Why this is simpler than the first write-up

| Earlier worry | Why scrcpy/libtailscale fixes it |
|---|---|
| “RN fetch/WS won’t use tsnet” | They talk to **127.0.0.1**; only the forwarder uses tsnet. |
| “Need full device VPN” | Userspace node + local TCP proxy is enough. |
| “No official mobile SDK” | **libtailscale** is official; iOS archives + TailscaleKit exist. scrcpy shows production UX. |
| “Must rewrite WebSocket stack” | `ws://127.0.0.1:...` is a normal WebSocket. |

Remaining hard parts are **boring engineering**, not research unknowns:

1. Expo native module + link Go static lib (iOS then Android).  
2. Lifecycle: up/down, re-forward after app resume, single origin.  
3. UX + SecureStore for auth key.  
4. Document subnet router when users insist on bare `192.168.x`.  
5. WebView/OIDC edge cases.

---

## 9. Suggested Termix architecture diagram

```
User enters:
  authKey = tskey-auth-...
  backend = http://192.168.5.166:8080

TermixTailscaleModule
  configure(authKey)
  up()
  startForward("192.168.5.166", 8080) → localPort=23456

main-axios configuredServerUrl
  = "http://127.0.0.1:23456"

axios  ──HTTP──► 127.0.0.1:23456 ──tsnet──► 192.168.5.166:8080
WS     ──WS────► 127.0.0.1:23456 ──tsnet──► same
WebView (if pointed at localhost) ─────────► same
```

Compare scrcpy:

```
session.useTailscale
  → SessionNetworking.setupTailscaleConnection
  → TailscaleManager.startForward(host, port, localPort)
  → scrcpy client connects 127.0.0.1:localPort
```

---

## 10. Open decisions (short)

1. **Ship iOS-only first?** (fastest; libtailscale is strongest there)  
2. **Vendor scrcpy `libtsnet` forwarder** vs implement forward on top of stock libtailscale?  
   - Forwarder: copy proven API (`tsnet_start_forward`).  
   - Stock + small proxy: fewer third-party lines, more work.  
3. **Default remote address style:** encourage `100.x` / MagicDNS over raw LAN?  
4. **OIDC over embedded TS:** support / degrade / document?

---

## 11. Bottom line

**Yes — your reading is right, and the first research note was too heavy.**

- [libtailscale](https://github.com/tailscale/libtailscale) = official userspace embed (auth key, dial, loopback SOCKS).  
- [scrcpy-mobile](https://github.com/wsvn53/scrcpy-mobile) = concrete app pattern: **auth key → connect → local port forward → existing client uses localhost**.  
- For Termix, that means: **one native module + forward + point `serverUrl` at `127.0.0.1`**, not a system VPN and not a full networking rewrite.  
- Still need correct tailnet routing for `192.168.5.166` (subnet router or put Termix on TS).  
- Feasible engineering project; **iOS spike is the right next step**.

---

## 12. References

- [libtailscale](https://github.com/tailscale/libtailscale) — `tailscale.h`, `swift/TailscaleKit`, iOS `c-archive`  
- [libtailscale Swift README](https://github.com/tailscale/libtailscale/blob/main/swift/README.md) — auth key + `URLSessionConfiguration.tailscaleSession`  
- [scrcpy-mobile](https://github.com/wsvn53/scrcpy-mobile) — `porting/libtsnet`, `TailscaleManager.swift`, `SessionNetworking.swift`  
- [Auth keys](https://tailscale.com/kb/1085/auth-keys)  
- [Subnet routers](https://tailscale.com/kb/1019/subnets)  
- Termix: `app/main-axios.ts`, `app/authentication/AuthFlow.tsx`
