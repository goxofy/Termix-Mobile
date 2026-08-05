import * as SecureStore from "expo-secure-store";
import {
  closeTermixTailscale,
  configureTermixTailscale,
  isTermixTailscaleAvailable,
  isTermixTailscaleUp,
  startTermixTailscaleForward,
  stopAllTermixTailscaleForwards,
  upTermixTailscale,
  type ForwardHandle,
} from "@/modules/termix-tailscale";

const AUTH_KEY_STORE = "termix.tailscale.authKey";
const ENABLED_STORE = "termix.tailscale.enabled";
const HOSTNAME_STORE = "termix.tailscale.hostname";

export type ParsedServerUrl = {
  protocol: "http:" | "https:";
  host: string;
  port: number;
  /** Path + query if present (usually empty for Termix base URL). */
  rest: string;
  original: string;
};

let activeForward: ForwardHandle | null = null;

export function isTailscaleNativeAvailable(): boolean {
  return isTermixTailscaleAvailable();
}

export async function loadTailscaleSettings(): Promise<{
  enabled: boolean;
  authKey: string;
  hostname: string;
}> {
  const [enabled, authKey, hostname] = await Promise.all([
    SecureStore.getItemAsync(ENABLED_STORE),
    SecureStore.getItemAsync(AUTH_KEY_STORE),
    SecureStore.getItemAsync(HOSTNAME_STORE),
  ]);
  return {
    enabled: enabled === "1",
    authKey: authKey ?? "",
    hostname: hostname ?? "termix-mobile",
  };
}

export async function saveTailscaleSettings(opts: {
  enabled: boolean;
  authKey: string;
  hostname?: string;
}): Promise<void> {
  await SecureStore.setItemAsync(ENABLED_STORE, opts.enabled ? "1" : "0");
  if (opts.authKey) {
    await SecureStore.setItemAsync(AUTH_KEY_STORE, opts.authKey.trim());
  } else {
    await SecureStore.deleteItemAsync(AUTH_KEY_STORE);
  }
  if (opts.hostname !== undefined) {
    const h = opts.hostname.trim() || "termix-mobile";
    await SecureStore.setItemAsync(HOSTNAME_STORE, h);
  }
}

export async function clearTailscaleSettings(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ENABLED_STORE),
    SecureStore.deleteItemAsync(AUTH_KEY_STORE),
    SecureStore.deleteItemAsync(HOSTNAME_STORE),
  ]);
}

/**
 * Parse a Termix server URL into host/port for TCP forwarding.
 * Default ports: http→80, https→443.
 */
export function parseServerUrl(url: string): ParsedServerUrl {
  const trimmed = url.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid server URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Server address must start with http:// or https://");
  }
  const port =
    parsed.port && parsed.port.length > 0
      ? Number(parsed.port)
      : parsed.protocol === "https:"
        ? 443
        : 80;
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error("Invalid server port");
  }
  const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}`;
  return {
    protocol: parsed.protocol,
    host: parsed.hostname,
    port,
    rest,
    original: trimmed,
  };
}

function transportUrlFor(
  forward: ForwardHandle,
  rest: string,
): string {
  return `http://127.0.0.1:${forward.localPort}${rest}`;
}

/** Live localhost transport if an active forward already targets this display URL. */
export function getLiveTransportUrl(displayUrl: string): string | null {
  if (!activeForward) return null;
  try {
    const parsed = parseServerUrl(displayUrl);
    if (
      activeForward.remoteHost === parsed.host &&
      activeForward.remotePort === parsed.port
    ) {
      return transportUrlFor(activeForward, parsed.rest);
    }
  } catch {
    return null;
  }
  return null;
}

export function getActiveTailscaleForward(): ForwardHandle | null {
  return activeForward;
}

/**
 * Bring up userspace Tailscale (if needed) and open a localhost TCP forward
 * to the remote Termix origin. Returns the URL the app should use for axios/WS.
 *
 * Reuses an existing live forward to the same host:port (critical: Hosts page
 * re-calls initializeServerConfig after login and must not tear down the tunnel).
 *
 * Transport is always http://127.0.0.1:<localPort>… because the forward is plain TCP
 * to the remote port (TLS would be end-to-end to 127.0.0.1 and fail hostname checks).
 */
export async function connectServerViaTailscale(opts: {
  serverUrl: string;
  authKey: string;
  hostname?: string;
  ephemeral?: boolean;
}): Promise<{ transportUrl: string; displayUrl: string; forward: ForwardHandle }> {
  if (!isTermixTailscaleAvailable()) {
    throw new Error(
      "Tailscale is not available in this build. Use a custom dev client with termix-tailscale native module.",
    );
  }
  const parsed = parseServerUrl(opts.serverUrl);
  if (!opts.authKey.trim()) {
    throw new Error("Tailscale auth key is required");
  }

  // Reuse a healthy forward — do not stop/reconfigure (configure fails once Up).
  const live = getLiveTransportUrl(parsed.original);
  if (live && activeForward && (await isTermixTailscaleUp())) {
    return {
      transportUrl: live,
      displayUrl: parsed.original,
      forward: activeForward,
    };
  }

  const alreadyUp = await isTermixTailscaleUp();
  if (!alreadyUp) {
    await configureTermixTailscale({
      authKey: opts.authKey.trim(),
      hostname: opts.hostname || "termix-mobile",
      ephemeral: opts.ephemeral ?? true,
    });
    await upTermixTailscale();
  }

  // Drop only stale forwards, then open the one we need.
  try {
    await stopAllTermixTailscaleForwards();
  } catch {
    // best-effort
  }
  activeForward = null;

  const forward = await startTermixTailscaleForward(parsed.host, parsed.port);
  activeForward = forward;

  return {
    transportUrl: transportUrlFor(forward, parsed.rest),
    displayUrl: parsed.original,
    forward,
  };
}

export async function disconnectTailscaleForwards(): Promise<void> {
  try {
    await stopAllTermixTailscaleForwards();
  } finally {
    activeForward = null;
  }
}

export async function shutdownTailscale(): Promise<void> {
  try {
    await stopAllTermixTailscaleForwards();
    await closeTermixTailscale();
  } finally {
    activeForward = null;
  }
}

/**
 * Ensure a localhost forward exists for displayUrl.
 * Reuses live forwards; otherwise joins with SecureStore auth key.
 */
export async function rehydrateTailscaleTransport(
  displayUrl: string,
): Promise<string | null> {
  if (!isTermixTailscaleAvailable()) return null;

  const live = getLiveTransportUrl(displayUrl);
  if (live && (await isTermixTailscaleUp())) {
    return live;
  }

  const settings = await loadTailscaleSettings();
  if (!settings.authKey) return null;

  try {
    const { transportUrl } = await connectServerViaTailscale({
      serverUrl: displayUrl,
      authKey: settings.authKey,
      hostname: settings.hostname,
      ephemeral: true,
    });
    return transportUrl;
  } catch {
    return null;
  }
}

/** True when user previously saved a Tailscale auth key for this app. */
export async function isTailscaleConfigured(): Promise<boolean> {
  if (!isTermixTailscaleAvailable()) return false;
  const s = await loadTailscaleSettings();
  return !!s.authKey.trim();
}
