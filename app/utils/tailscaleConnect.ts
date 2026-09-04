import * as SecureStore from "expo-secure-store";
import {
  closeTermixTailscale,
  configureTermixTailscale,
  isTermixTailscaleAvailable,
  isTermixTailscaleForwardActive,
  isTermixTailscaleUp,
  probeTermixTailscaleForward,
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
  /** Optional path prefix (usually empty for a Termix base URL). */
  rest: string;
  original: string;
};

export type TailscaleTransportErrorCode =
  | "not_available"
  | "missing_auth_key"
  | "invalid_server"
  | "stale_operation"
  | "connect_failed";

export class TailscaleTransportError extends Error {
  constructor(
    public readonly code: TailscaleTransportErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "TailscaleTransportError";
  }
}

export type TailscaleTransportResult = {
  transportUrl: string;
  displayUrl: string;
  forward: ForwardHandle;
  rebuilt: boolean;
};

type ActiveNodeConfig = {
  authKey: string;
  hostname: string;
  ephemeral: boolean;
};

let activeForward: ForwardHandle | null = null;
let activeNodeConfig: ActiveNodeConfig | null = null;
let tailscaleLifecycleQueue: Promise<void> = Promise.resolve();
let lifecycleGeneration = 0;
let recoveryFlight: {
  displayUrl: string;
  promise: Promise<TailscaleTransportResult>;
} | null = null;

function withTailscaleLifecycleLock<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const previous = tailscaleLifecycleQueue;
  let release!: () => void;
  tailscaleLifecycleQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  return previous
    .catch(() => undefined)
    .then(operation)
    .finally(() => release());
}

function assertCurrentGeneration(generation: number): void {
  if (generation !== lifecycleGeneration) {
    throw new TailscaleTransportError(
      "stale_operation",
      "A newer Tailscale transport operation replaced this one.",
    );
  }
}

function asTransportError(error: unknown): TailscaleTransportError {
  if (error instanceof TailscaleTransportError) return error;
  const message =
    error instanceof Error && error.message.trim()
      ? error.message
      : "Unable to establish the Tailscale transport.";
  return new TailscaleTransportError("connect_failed", message);
}

export function getTailscaleTransportErrorMessage(error: unknown): string {
  return asTransportError(error).message;
}

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

function normalizeHost(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1).toLowerCase()
    : hostname.toLowerCase();
}

/** Parse a Termix origin into the target used by the native forward. */
export function parseServerUrl(url: string): ParsedServerUrl {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    throw new TailscaleTransportError("invalid_server", "Invalid server URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new TailscaleTransportError(
      "invalid_server",
      "Server address must start with http:// or https://.",
    );
  }
  if (!parsed.hostname) {
    throw new TailscaleTransportError("invalid_server", "Invalid server host.");
  }
  if (parsed.search || parsed.hash) {
    throw new TailscaleTransportError(
      "invalid_server",
      "Server address must not include query parameters or a fragment.",
    );
  }

  const port = parsed.port
    ? Number(parsed.port)
    : parsed.protocol === "https:"
      ? 443
      : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new TailscaleTransportError("invalid_server", "Invalid server port.");
  }

  const pathname =
    parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/+$/, "");
  const rest = pathname;
  const original = `${parsed.origin}${pathname}`;
  return {
    protocol: parsed.protocol,
    host: normalizeHost(parsed.hostname),
    port,
    rest,
    original,
  };
}

function transportUrlFor(forward: ForwardHandle, rest: string): string {
  return `http://127.0.0.1:${forward.localPort}${rest}`;
}

function sameForwardTarget(
  forward: ForwardHandle,
  parsed: ParsedServerUrl,
): boolean {
  return (
    forward.protocol === parsed.protocol &&
    normalizeHost(forward.remoteHost) === parsed.host &&
    forward.remotePort === parsed.port
  );
}

async function getLiveTransportUrlUnsafe(
  displayUrl: string,
): Promise<string | null> {
  if (!activeForward || !activeNodeConfig) return null;

  try {
    const parsed = parseServerUrl(displayUrl);
    if (!sameForwardTarget(activeForward, parsed)) return null;
    if (!(await isTermixTailscaleUp())) return null;
    if (!(await isTermixTailscaleForwardActive(activeForward))) return null;
    if (!(await probeTermixTailscaleForward(activeForward))) return null;
    return transportUrlFor(activeForward, parsed.rest);
  } catch {
    return null;
  }
}

/** A strongly validated localhost transport for the requested display URL. */
export function getLiveTransportUrl(
  displayUrl: string,
): Promise<string | null> {
  return withTailscaleLifecycleLock(() =>
    getLiveTransportUrlUnsafe(displayUrl),
  );
}

export function getActiveTailscaleForward(): ForwardHandle | null {
  return activeForward;
}

type ConnectServerViaTailscaleOptions = {
  serverUrl: string;
  authKey: string;
  hostname?: string;
  ephemeral?: boolean;
};

async function shutdownTailscaleUnsafe(): Promise<void> {
  let stopError: unknown;
  try {
    await stopAllTermixTailscaleForwards();
  } catch (error) {
    stopError = error;
  }

  try {
    await closeTermixTailscale();
  } finally {
    activeForward = null;
    activeNodeConfig = null;
  }

  if (stopError) throw stopError;
}

async function connectServerViaTailscaleUnsafe(
  opts: ConnectServerViaTailscaleOptions,
  generation: number,
): Promise<TailscaleTransportResult> {
  if (!isTermixTailscaleAvailable()) {
    throw new TailscaleTransportError(
      "not_available",
      "Tailscale is not available in this build. Use a custom development or production build with the native module.",
    );
  }

  const parsed = parseServerUrl(opts.serverUrl);
  const authKey = opts.authKey.trim();
  if (!authKey) {
    throw new TailscaleTransportError(
      "missing_auth_key",
      "Tailscale auth key is required.",
    );
  }

  const desiredConfig: ActiveNodeConfig = {
    authKey,
    hostname: opts.hostname?.trim() || "termix-mobile",
    ephemeral: opts.ephemeral ?? true,
  };
  const configChanged =
    activeNodeConfig !== null &&
    (activeNodeConfig.authKey !== desiredConfig.authKey ||
      activeNodeConfig.hostname !== desiredConfig.hostname ||
      activeNodeConfig.ephemeral !== desiredConfig.ephemeral);

  if (configChanged) {
    await shutdownTailscaleUnsafe();
    assertCurrentGeneration(generation);
  }

  let alreadyUp = await isTermixTailscaleUp();
  assertCurrentGeneration(generation);

  if (!alreadyUp && activeNodeConfig !== null) {
    await shutdownTailscaleUnsafe();
    assertCurrentGeneration(generation);
    alreadyUp = false;
  } else if (alreadyUp && activeNodeConfig === null) {
    // Native state can outlive a JS reload. Reconfigure rather than attaching a
    // forward to a node whose credentials/options cannot be identified.
    await shutdownTailscaleUnsafe();
    assertCurrentGeneration(generation);
    alreadyUp = false;
  }

  const live = activeNodeConfig
    ? await getLiveTransportUrlUnsafe(parsed.original)
    : null;
  assertCurrentGeneration(generation);
  if (live && activeForward) {
    return {
      transportUrl: live,
      displayUrl: parsed.original,
      forward: activeForward,
      rebuilt: false,
    };
  }

  if (!alreadyUp) {
    await configureTermixTailscale(desiredConfig);
    assertCurrentGeneration(generation);
    await upTermixTailscale();
    assertCurrentGeneration(generation);
    activeNodeConfig = desiredConfig;
  }

  try {
    await stopAllTermixTailscaleForwards();
  } finally {
    activeForward = null;
  }
  assertCurrentGeneration(generation);

  const forward = await startTermixTailscaleForward(
    parsed.protocol,
    parsed.host,
    parsed.port,
  );
  if (generation !== lifecycleGeneration) {
    await stopAllTermixTailscaleForwards().catch(() => undefined);
    throw new TailscaleTransportError(
      "stale_operation",
      "A newer Tailscale transport operation replaced this one.",
    );
  }
  activeForward = forward;

  return {
    transportUrl: transportUrlFor(forward, parsed.rest),
    displayUrl: parsed.original,
    forward,
    rebuilt: true,
  };
}

/** Bring up userspace Tailscale and return the current loopback transport. */
export function connectServerViaTailscale(
  opts: ConnectServerViaTailscaleOptions,
): Promise<TailscaleTransportResult> {
  const generation = ++lifecycleGeneration;
  return withTailscaleLifecycleLock(() =>
    connectServerViaTailscaleUnsafe(opts, generation).catch((error) => {
      throw asTransportError(error);
    }),
  );
}

export function disconnectTailscaleForwards(): Promise<void> {
  const generation = ++lifecycleGeneration;
  return withTailscaleLifecycleLock(async () => {
    try {
      await stopAllTermixTailscaleForwards();
      assertCurrentGeneration(generation);
    } finally {
      activeForward = null;
    }
  });
}

export function shutdownTailscale(): Promise<void> {
  const generation = ++lifecycleGeneration;
  return withTailscaleLifecycleLock(async () => {
    await shutdownTailscaleUnsafe();
    assertCurrentGeneration(generation);
  });
}

/**
 * Validate or rebuild the transport using the credentials stored in SecureStore.
 * Concurrent callers for the same display URL share one recovery flight.
 */
export function recoverTailscaleTransport(
  displayUrl: string,
): Promise<TailscaleTransportResult> {
  const parsed = parseServerUrl(displayUrl);
  if (recoveryFlight?.displayUrl === parsed.original) {
    return recoveryFlight.promise;
  }

  const generation = ++lifecycleGeneration;
  const promise = withTailscaleLifecycleLock(async () => {
    try {
      const live = await getLiveTransportUrlUnsafe(parsed.original);
      assertCurrentGeneration(generation);
      if (live && activeForward) {
        return {
          transportUrl: live,
          displayUrl: parsed.original,
          forward: activeForward,
          rebuilt: false,
        };
      }

      const settings = await loadTailscaleSettings();
      assertCurrentGeneration(generation);
      if (!settings.authKey.trim()) {
        throw new TailscaleTransportError(
          "missing_auth_key",
          "No saved Tailscale auth key is available.",
        );
      }

      // A failed strong health check is not reusable. Close all stale native
      // state before rebuilding so an old listener cannot survive foregrounding.
      await shutdownTailscaleUnsafe().catch(() => undefined);
      assertCurrentGeneration(generation);

      return await connectServerViaTailscaleUnsafe(
        {
          serverUrl: parsed.original,
          authKey: settings.authKey,
          hostname: settings.hostname,
          ephemeral: true,
        },
        generation,
      );
    } catch (error) {
      throw asTransportError(error);
    }
  });

  recoveryFlight = { displayUrl: parsed.original, promise };
  const clearRecoveryFlight = () => {
    if (recoveryFlight?.promise === promise) recoveryFlight = null;
  };
  void promise.then(clearRecoveryFlight, clearRecoveryFlight);
  return promise;
}

/** Compatibility wrapper for callers that only need a nullable URL. */
export async function rehydrateTailscaleTransport(
  displayUrl: string,
): Promise<string | null> {
  if (!isTermixTailscaleAvailable()) return null;
  try {
    return (await recoverTailscaleTransport(displayUrl)).transportUrl;
  } catch {
    return null;
  }
}

/** True when the user previously saved a Tailscale auth key for this app. */
export async function isTailscaleConfigured(): Promise<boolean> {
  if (!isTermixTailscaleAvailable()) return false;
  const settings = await loadTailscaleSettings();
  return !!settings.authKey.trim();
}
