# termix-tailscale

Userspace Tailscale for Termix Mobile (official `tailscale.com/tsnet`), exposed as an Expo native module.

**Not a system VPN.** The app joins a tailnet inside the process, then opens a **localhost TCP forward** to the private Termix origin. Existing axios / WebSocket code talks to `http://127.0.0.1:<port>`.

## Build native library

Requires Go 1.23+ and, for device builds, Xcode / Android NDK.

```bash
# Host (smoke-compile)
npm run build:tailscale-host

# iOS device archive → modules/termix-tailscale/ios/lib/libtermix_ts.a
npm run build:tailscale-ios

# Android arm64-v8a .so (set ANDROID_NDK_HOME)
npm run build:tailscale-android
```

If the Go archive is missing, iOS still links a **stub** that returns clear errors so the JS UI can show “needs native build”.

## JS API

```ts
import {
  isTermixTailscaleAvailable,
  configureTermixTailscale,
  upTermixTailscale,
  startTermixTailscaleForward,
  closeTermixTailscale,
} from "termix-tailscale";
```

Higher-level helpers live in `app/utils/tailscaleConnect.ts` (auth key in SecureStore, URL parse, rehydrate on boot).

## Auth

Use a Tailscale **auth key** (`tskey-auth-…`), preferably one-off / short-lived / tagged. Do not embed reusable keys in the binary.

## Notes

- Prefer remote `http://100.x.x.x:PORT` or MagicDNS. Raw `192.168.x` needs an approved **subnet route**.
- Local forward is cleartext TCP; prefer HTTP on the private backend (TLS to `127.0.0.1` will not match cert names).
- Android: library load is wired; full JNI parity is still a follow-up (iOS is the primary path).
