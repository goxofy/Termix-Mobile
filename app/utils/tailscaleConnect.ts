import * as SecureStore from "expo-secure-store";
import {
  closeTermixTailscale,
  configureTermixTailscale,
  isTermixTailscaleAvailable,
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

/**
 * Bring up userspace Tailscale (if needed) and open a localhost TCP forward
 * to the remote Termix origin. Returns the URL the app should use for axios/WS.
 *
 * Transport is always http://127.0.0.1:<localPort>… because the forward is plain TCP
 * to the remote port (TLS would be end-to-end to 127.0.0.1 and fail hostname checks).
 * Prefer HTTP backends over Tailscale, or terminate TLS on the remote as HTTP for this path.
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

  await stopAllTermixTailscaleForwards();
  activeForward = null;

  await configureTermixTailscale({
    authKey: opts.authKey.trim(),
    hostname: opts.hostname || "termix-mobile",
    ephemeral: opts.ephemeral ?? true,
  });
  await upTermixTailscale();

  const forward = await startTermixTailscaleForward(parsed.host, parsed.port);
  activeForward = forward;

  // Local forward is cleartext TCP to the remote port. Use http:// on localhost.
  const transportUrl = `http://127.0.0.1:${forward.localPort}${parsed.rest}`;

  return {
    transportUrl,
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

export function getActiveTailscaleForward(): ForwardHandle | null {
  return activeForward;
}

/**
 * After process restart, rebuild a localhost forward for a previously saved
 * Tailscale-backed display URL using the SecureStore auth key.
 * Returns the new transport URL, or null if Tailscale cannot be rehydrated.
 */
export async function rehydrateTailscaleTransport(
  displayUrl: string,
): Promise<string | null> {
  if (!isTermixTailscaleAvailable()) return null;
  const settings = await loadTailscaleSettings();
  if (!settings.enabled || !settings.authKey) return null;
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
