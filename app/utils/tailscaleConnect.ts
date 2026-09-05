import * as SecureStore from "expo-secure-store";
import {
  cancelTermixTailscaleCurrentOperation,
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

const LEGACY_ENABLED_STORE = "termix.tailscale.enabled";
const AUTH_KEY_STORE = "termix.tailscale.authKey";
const HOSTNAME_STORE = "termix.tailscale.hostname";

const CONFIGURE_TIMEOUT_MS = 10_000;
const UP_TIMEOUT_MS = 95_000;
const START_FORWARD_TIMEOUT_MS = 15_000;
const STATUS_TIMEOUT_MS = 5_000;
const FORWARD_PROBE_TIMEOUT_MS = 8_000;
const STOP_TIMEOUT_MS = 8_000;
const CLOSE_TIMEOUT_MS = 6_000;
const RECOVERY_TIMEOUT_MS = 125_000;

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
  | "operation_canceled"
  | "operation_timeout"
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

export type TailscaleLifecycleOptions = {
  networkGeneration?: number;
  signal?: AbortSignal;
};

type ActiveNodeConfig = {
  authKey: string;
  hostname: string;
  ephemeral: boolean;
  networkGeneration: number;
};

let activeForward: ForwardHandle | null = null;
let activeNodeConfig: ActiveNodeConfig | null = null;
let tailscaleLifecycleQueue: Promise<void> = Promise.resolve();
let lifecycleGeneration = 0;
let currentNetworkGeneration = 0;
let activeLifecycleController: AbortController | null = null;
type RecoveryFlight = {
  displayUrl: string;
  networkGeneration: number;
  lifecycleGeneration: number;
  controller: AbortController;
  waiters: number;
  promise: Promise<TailscaleTransportResult>;
};
let recoveryFlight: RecoveryFlight | null = null;

function canceledError(message = "The Tailscale operation was canceled.") {
  return new TailscaleTransportError("operation_canceled", message);
}

function timeoutError(label: string) {
  return new TailscaleTransportError(
    "operation_timeout",
    `${label} took too long. The native operation was canceled; cleanup will continue in the background.`,
  );
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw canceledError();
}

function withBoundedPromise<T>(
  promise: Promise<T>,
  options: {
    label: string;
    timeoutMs: number;
    signal?: AbortSignal;
    onInterrupt?: () => void;
  },
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timeoutId);
      options.signal?.removeEventListener("abort", handleAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const interrupt = (error: TailscaleTransportError) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        options.onInterrupt?.();
      } finally {
        reject(error);
      }
    };
    const handleAbort = () => interrupt(canceledError());
    const timeoutId = setTimeout(
      () => interrupt(timeoutError(options.label)),
      options.timeoutMs,
    );

    if (options.signal?.aborted) {
      handleAbort();
    } else {
      options.signal?.addEventListener("abort", handleAbort, { once: true });
      void promise.then(
        (value) => finish(() => resolve(value)),
        (error) => finish(() => reject(error)),
      );
    }
  });
}

function runNativeStep<T>(
  label: string,
  timeoutMs: number,
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  throwIfAborted(signal);
  const promise = Promise.resolve().then(operation);
  return withBoundedPromise(promise, {
    label,
    timeoutMs,
    signal,
    onInterrupt: cancelTermixTailscaleCurrentOperation,
  });
}

function withTailscaleLifecycleLock<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: {
    generation?: number;
    signal?: AbortSignal;
    timeoutMs?: number;
    label?: string;
  } = {},
): Promise<T> {
  const previous = tailscaleLifecycleQueue;
  let release!: () => void;
  tailscaleLifecycleQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  return previous
    .catch(() => undefined)
    .then(async () => {
      if (options.generation !== undefined) {
        assertCurrentGeneration(options.generation);
      }
      throwIfAborted(options.signal);

      const controller = new AbortController();
      const abortFromCaller = () => controller.abort();
      options.signal?.addEventListener("abort", abortFromCaller, {
        once: true,
      });
      if (options.signal?.aborted) controller.abort();
      activeLifecycleController = controller;

      const operationPromise = Promise.resolve().then(() =>
        operation(controller.signal),
      );
      try {
        return await withBoundedPromise(operationPromise, {
          label: options.label ?? "Tailscale transport recovery",
          timeoutMs: options.timeoutMs ?? RECOVERY_TIMEOUT_MS,
          signal: controller.signal,
          onInterrupt: () => {
            controller.abort();
            cancelTermixTailscaleCurrentOperation();
          },
        });
      } finally {
        options.signal?.removeEventListener("abort", abortFromCaller);
        if (activeLifecycleController === controller) {
          activeLifecycleController = null;
        }
      }
    })
    .finally(() => release());
}

function supersedeLifecycleOperation(): number {
  lifecycleGeneration += 1;
  const staleRecovery = recoveryFlight;
  recoveryFlight = null;
  staleRecovery?.controller.abort();
  if (activeLifecycleController) {
    activeLifecycleController.abort();
    cancelTermixTailscaleCurrentOperation();
  }
  return lifecycleGeneration;
}

function assertCurrentGeneration(
  generation: number,
  signal?: AbortSignal,
): void {
  throwIfAborted(signal);
  if (generation !== lifecycleGeneration) {
    throw new TailscaleTransportError(
      "stale_operation",
      "A newer Tailscale transport operation replaced this one.",
    );
  }
}

function resolveNetworkGeneration(networkGeneration?: number): number {
  if (networkGeneration === undefined) return currentNetworkGeneration;
  if (networkGeneration < currentNetworkGeneration) {
    throw new TailscaleTransportError(
      "stale_operation",
      "The network changed before this Tailscale operation could start.",
    );
  }
  currentNetworkGeneration = networkGeneration;
  return networkGeneration;
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
  /** @deprecated ServerConfig.viaTailscale is the selected-mode authority. */
  enabled: boolean;
  authKey: string;
  hostname: string;
}> {
  const [authKey, hostname] = await Promise.all([
    SecureStore.getItemAsync(AUTH_KEY_STORE),
    SecureStore.getItemAsync(HOSTNAME_STORE),
  ]);
  return {
    enabled: false,
    authKey: authKey ?? "",
    hostname: hostname ?? "termix-mobile",
  };
}

export async function saveTailscaleSettings(opts: {
  /** @deprecated Ignored; selected mode is persisted in ServerConfig. */
  enabled?: boolean;
  authKey: string;
  hostname?: string;
}): Promise<void> {
  if (opts.authKey) {
    await SecureStore.setItemAsync(AUTH_KEY_STORE, opts.authKey.trim());
  } else {
    await SecureStore.deleteItemAsync(AUTH_KEY_STORE);
  }
  if (opts.hostname !== undefined) {
    const h = opts.hostname.trim() || "termix-mobile";
    await SecureStore.setItemAsync(HOSTNAME_STORE, h);
  }
  await SecureStore.deleteItemAsync(LEGACY_ENABLED_STORE);
}

export async function clearTailscaleSettings(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(LEGACY_ENABLED_STORE),
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
  networkGeneration: number,
  signal: AbortSignal,
): Promise<string | null> {
  if (
    !activeForward ||
    !activeNodeConfig ||
    activeNodeConfig.networkGeneration !== networkGeneration
  ) {
    return null;
  }

  try {
    const parsed = parseServerUrl(displayUrl);
    if (!sameForwardTarget(activeForward, parsed)) return null;
    if (
      !(await runNativeStep(
        "Checking Tailscale status",
        STATUS_TIMEOUT_MS,
        signal,
        isTermixTailscaleUp,
      ))
    ) {
      return null;
    }
    if (
      !(await runNativeStep(
        "Checking the Tailscale forward",
        STATUS_TIMEOUT_MS,
        signal,
        () => isTermixTailscaleForwardActive(activeForward!),
      ))
    ) {
      return null;
    }
    if (
      !(await runNativeStep(
        "Probing the Tailscale target",
        FORWARD_PROBE_TIMEOUT_MS,
        signal,
        () => probeTermixTailscaleForward(activeForward!),
      ))
    ) {
      return null;
    }
    return transportUrlFor(activeForward, parsed.rest);
  } catch (error) {
    if (signal.aborted || error instanceof TailscaleTransportError) throw error;
    return null;
  }
}

/** A strongly validated localhost transport for the requested display URL. */
export function getLiveTransportUrl(
  displayUrl: string,
  options: TailscaleLifecycleOptions = {},
): Promise<string | null> {
  const networkGeneration = resolveNetworkGeneration(options.networkGeneration);
  return withTailscaleLifecycleLock(
    (signal) =>
      getLiveTransportUrlUnsafe(displayUrl, networkGeneration, signal),
    {
      signal: options.signal,
      timeoutMs: 25_000,
      label: "Tailscale health check",
    },
  );
}

export function getActiveTailscaleForward(): ForwardHandle | null {
  return activeForward;
}

export type ConnectServerViaTailscaleOptions = TailscaleLifecycleOptions & {
  serverUrl: string;
  authKey: string;
  hostname?: string;
  ephemeral?: boolean;
};

async function shutdownTailscaleUnsafe(signal: AbortSignal): Promise<void> {
  let stopError: unknown;
  try {
    await runNativeStep(
      "Stopping Tailscale forwards",
      STOP_TIMEOUT_MS,
      signal,
      stopAllTermixTailscaleForwards,
    );
  } catch (error) {
    stopError = error;
  }

  try {
    await runNativeStep(
      "Closing Tailscale",
      CLOSE_TIMEOUT_MS,
      signal,
      closeTermixTailscale,
    );
  } finally {
    activeForward = null;
    activeNodeConfig = null;
  }

  if (stopError) throw stopError;
}

async function connectServerViaTailscaleUnsafe(
  opts: ConnectServerViaTailscaleOptions,
  generation: number,
  networkGeneration: number,
  signal: AbortSignal,
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
    networkGeneration,
  };
  const configChanged =
    activeNodeConfig !== null &&
    (activeNodeConfig.authKey !== desiredConfig.authKey ||
      activeNodeConfig.hostname !== desiredConfig.hostname ||
      activeNodeConfig.ephemeral !== desiredConfig.ephemeral ||
      activeNodeConfig.networkGeneration !== desiredConfig.networkGeneration);

  if (configChanged) {
    await shutdownTailscaleUnsafe(signal);
    assertCurrentGeneration(generation, signal);
  }

  let alreadyUp = await runNativeStep(
    "Checking Tailscale status",
    STATUS_TIMEOUT_MS,
    signal,
    isTermixTailscaleUp,
  );
  assertCurrentGeneration(generation, signal);

  if (!alreadyUp && activeNodeConfig !== null) {
    await shutdownTailscaleUnsafe(signal);
    assertCurrentGeneration(generation, signal);
    alreadyUp = false;
  } else if (alreadyUp && activeNodeConfig === null) {
    // Native state can outlive a JS reload. Reconfigure rather than attaching a
    // forward to a node whose credentials/options cannot be identified.
    await shutdownTailscaleUnsafe(signal);
    assertCurrentGeneration(generation, signal);
    alreadyUp = false;
  }

  const live = activeNodeConfig
    ? await getLiveTransportUrlUnsafe(
        parsed.original,
        networkGeneration,
        signal,
      )
    : null;
  assertCurrentGeneration(generation, signal);
  if (live && activeForward) {
    return {
      transportUrl: live,
      displayUrl: parsed.original,
      forward: activeForward,
      rebuilt: false,
    };
  }

  if (!alreadyUp) {
    await runNativeStep(
      "Configuring Tailscale",
      CONFIGURE_TIMEOUT_MS,
      signal,
      () => configureTermixTailscale(desiredConfig),
    );
    assertCurrentGeneration(generation, signal);
    await runNativeStep(
      "Connecting to Tailscale",
      UP_TIMEOUT_MS,
      signal,
      upTermixTailscale,
    );
    assertCurrentGeneration(generation, signal);
    activeNodeConfig = desiredConfig;
  }

  try {
    await runNativeStep(
      "Replacing Tailscale forwards",
      STOP_TIMEOUT_MS,
      signal,
      stopAllTermixTailscaleForwards,
    );
  } finally {
    activeForward = null;
  }
  assertCurrentGeneration(generation, signal);

  const forward = await runNativeStep(
    "Opening the Tailscale forward",
    START_FORWARD_TIMEOUT_MS,
    signal,
    () =>
      startTermixTailscaleForward(parsed.protocol, parsed.host, parsed.port),
  );
  if (
    generation !== lifecycleGeneration ||
    signal.aborted ||
    networkGeneration !== currentNetworkGeneration
  ) {
    void stopAllTermixTailscaleForwards().catch(() => undefined);
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
  const networkGeneration = resolveNetworkGeneration(opts.networkGeneration);
  const generation = supersedeLifecycleOperation();
  return withTailscaleLifecycleLock(
    (signal) =>
      connectServerViaTailscaleUnsafe(
        opts,
        generation,
        networkGeneration,
        signal,
      ).catch((error) => {
        throw asTransportError(error);
      }),
    {
      generation,
      signal: opts.signal,
      timeoutMs: RECOVERY_TIMEOUT_MS,
      label: "Tailscale connection",
    },
  );
}

export function disconnectTailscaleForwards(): Promise<void> {
  const generation = supersedeLifecycleOperation();
  return withTailscaleLifecycleLock(
    async (signal) => {
      try {
        await runNativeStep(
          "Stopping Tailscale forwards",
          STOP_TIMEOUT_MS,
          signal,
          stopAllTermixTailscaleForwards,
        );
        assertCurrentGeneration(generation, signal);
      } finally {
        activeForward = null;
      }
    },
    { generation, timeoutMs: STOP_TIMEOUT_MS + 2_000 },
  );
}

export function shutdownTailscale(): Promise<void> {
  const generation = supersedeLifecycleOperation();
  cancelTermixTailscaleCurrentOperation();
  return withTailscaleLifecycleLock(
    async (signal) => {
      await shutdownTailscaleUnsafe(signal);
      assertCurrentGeneration(generation, signal);
    },
    {
      generation,
      timeoutMs: STOP_TIMEOUT_MS + CLOSE_TIMEOUT_MS + 2_000,
      label: "Tailscale shutdown",
    },
  );
}

/** Cancel immediately and let bounded cleanup finish without blocking the caller. */
export function shutdownTailscaleInBackground(): void {
  void Promise.resolve()
    .then(() => shutdownTailscale())
    .catch(() => undefined);
}

/**
 * Invalidate JS/native lifecycle work for a material native network generation.
 * Late native promises may settle, but cannot republish stale JS state.
 */
export function invalidateTailscaleLifecycle(networkGeneration: number): void {
  if (networkGeneration < currentNetworkGeneration) return;
  currentNetworkGeneration = networkGeneration;
  lifecycleGeneration += 1;
  const staleRecovery = recoveryFlight;
  recoveryFlight = null;
  staleRecovery?.controller.abort();
  activeLifecycleController?.abort();
  activeLifecycleController = null;
  activeForward = null;
  activeNodeConfig = null;
  cancelTermixTailscaleCurrentOperation();
}

function waitForRecoveryFlight(
  flight: RecoveryFlight,
  signal?: AbortSignal,
): Promise<TailscaleTransportResult> {
  if (signal?.aborted) return Promise.reject(canceledError());
  flight.waiters += 1;

  return new Promise<TailscaleTransportResult>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", handleAbort);
      flight.waiters = Math.max(0, flight.waiters - 1);
      callback();
    };
    const handleAbort = () => {
      finish(() => reject(canceledError()));
      if (flight.waiters === 0) flight.controller.abort();
    };

    signal?.addEventListener("abort", handleAbort, { once: true });
    void flight.promise.then(
      (result) => finish(() => resolve(result)),
      (error) => finish(() => reject(error)),
    );
  });
}

/**
 * Validate or rebuild the transport using the credentials stored in SecureStore.
 * Concurrent callers share a flight only for the same URL and network generation.
 */
export function recoverTailscaleTransport(
  displayUrl: string,
  options: TailscaleLifecycleOptions = {},
): Promise<TailscaleTransportResult> {
  const parsed = parseServerUrl(displayUrl);
  const networkGeneration = resolveNetworkGeneration(options.networkGeneration);
  if (
    recoveryFlight?.displayUrl === parsed.original &&
    recoveryFlight.networkGeneration === networkGeneration &&
    recoveryFlight.lifecycleGeneration === lifecycleGeneration
  ) {
    return waitForRecoveryFlight(recoveryFlight, options.signal);
  }

  const generation = supersedeLifecycleOperation();
  const controller = new AbortController();
  const promise = withTailscaleLifecycleLock(
    async (signal) => {
      try {
        const live = await getLiveTransportUrlUnsafe(
          parsed.original,
          networkGeneration,
          signal,
        );
        assertCurrentGeneration(generation, signal);
        if (live && activeForward) {
          return {
            transportUrl: live,
            displayUrl: parsed.original,
            forward: activeForward,
            rebuilt: false,
          };
        }

        const settings = await loadTailscaleSettings();
        assertCurrentGeneration(generation, signal);
        if (!settings.authKey.trim()) {
          throw new TailscaleTransportError(
            "missing_auth_key",
            "No saved Tailscale auth key is available.",
          );
        }

        // A failed strong health check is not reusable. Close all stale native
        // state before rebuilding so an old listener cannot survive foregrounding.
        await shutdownTailscaleUnsafe(signal).catch(() => undefined);
        assertCurrentGeneration(generation, signal);

        return await connectServerViaTailscaleUnsafe(
          {
            serverUrl: parsed.original,
            authKey: settings.authKey,
            hostname: settings.hostname,
            ephemeral: true,
            networkGeneration,
            signal,
          },
          generation,
          networkGeneration,
          signal,
        );
      } catch (error) {
        throw asTransportError(error);
      }
    },
    {
      generation,
      signal: controller.signal,
      timeoutMs: RECOVERY_TIMEOUT_MS,
      label: "Tailscale transport recovery",
    },
  );

  const flight: RecoveryFlight = {
    displayUrl: parsed.original,
    networkGeneration,
    lifecycleGeneration: generation,
    controller,
    waiters: 0,
    promise,
  };
  recoveryFlight = flight;
  const clearRecoveryFlight = () => {
    if (recoveryFlight === flight) recoveryFlight = null;
  };
  void promise.then(clearRecoveryFlight, clearRecoveryFlight);
  return waitForRecoveryFlight(flight, options.signal);
}

/** Compatibility wrapper for callers that only need a nullable URL. */
export async function rehydrateTailscaleTransport(
  displayUrl: string,
  options: TailscaleLifecycleOptions = {},
): Promise<string | null> {
  if (!isTermixTailscaleAvailable()) return null;
  try {
    return (await recoverTailscaleTransport(displayUrl, options)).transportUrl;
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
