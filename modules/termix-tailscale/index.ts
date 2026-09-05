import { requireOptionalNativeModule } from "expo-modules-core";
import type { EventSubscription } from "expo-modules-core";

export type TermixTailscaleConfig = {
  authKey: string;
  hostname?: string;
  /** Absolute path for tsnet state. Defaults to a native app-support path. */
  stateDir?: string;
  ephemeral?: boolean;
};

export type NetworkSnapshot = {
  generation: number;
  signature: string;
  status: "online" | "offline" | "unknown";
  transport: "wifi" | "cellular" | "wired" | "other" | "none";
  systemVpn: boolean;
};

export type ForwardProtocol = "http:" | "https:";

export type ForwardHandle = {
  protocol: ForwardProtocol;
  remoteHost: string;
  remotePort: number;
  localPort: number;
};

type NativeModule = {
  isAvailable(): boolean;
  cancelCurrentOperation(): void;
  getNetworkSnapshot(): Promise<NetworkSnapshot>;
  addListener(
    eventName: "onNetworkChanged",
    listener: (snapshot: NetworkSnapshot) => void,
  ): EventSubscription;
  configure(options: {
    authKey: string;
    hostname: string;
    stateDir: string;
    ephemeral: boolean;
  }): Promise<void>;
  up(): Promise<void>;
  startForward(
    protocol: ForwardProtocol,
    remoteHost: string,
    remotePort: number,
  ): Promise<number>;
  stopForward(
    protocol: ForwardProtocol,
    remoteHost: string,
    remotePort: number,
    localPort: number,
  ): Promise<void>;
  stopAllForwards(): Promise<void>;
  isForwardActive(
    protocol: ForwardProtocol,
    remoteHost: string,
    remotePort: number,
    localPort: number,
  ): Promise<boolean>;
  probeForward(
    protocol: ForwardProtocol,
    remoteHost: string,
    remotePort: number,
    localPort: number,
  ): Promise<boolean>;
  isUp(): Promise<boolean>;
  getIPs(): Promise<string>;
  close(): Promise<void>;
  getDefaultStateDir(): Promise<string>;
};

const Native = requireOptionalNativeModule<NativeModule>("TermixTailscale");

const UNKNOWN_NETWORK_SNAPSHOT: NetworkSnapshot = {
  generation: 0,
  signature: "unknown|none|vpn:0",
  status: "unknown",
  transport: "none",
  systemVpn: false,
};

/** True when the Go/tsnet library is linked (the network monitor is independent). */
export function isTermixTailscaleAvailable(): boolean {
  return !!Native?.isAvailable?.();
}

/** Returns the latest immutable native connectivity snapshot. */
export async function getTermixTailscaleNetworkSnapshot(): Promise<NetworkSnapshot> {
  if (!Native) return { ...UNKNOWN_NETWORK_SNAPSHOT };
  return Native.getNetworkSnapshot();
}

/** Subscribes to material connectivity/signature changes only. */
export function addTermixTailscaleNetworkChangeListener(
  listener: (snapshot: NetworkSnapshot) => void,
): EventSubscription | null {
  if (!Native) return null;
  return Native.addListener("onNetworkChanged", listener);
}

/** Immediately invalidates/cancels native lifecycle work without waiting. */
export function cancelTermixTailscaleCurrentOperation(): void {
  Native?.cancelCurrentOperation();
}

export async function configureTermixTailscale(
  config: TermixTailscaleConfig,
): Promise<void> {
  if (!Native) {
    throw new Error(
      "Termix Tailscale native module is not available. Use a custom dev client build.",
    );
  }
  const stateDir =
    config.stateDir?.trim() || (await Native.getDefaultStateDir());
  await Native.configure({
    authKey: config.authKey.trim(),
    hostname: (config.hostname || "termix-mobile").trim(),
    stateDir,
    ephemeral: !!config.ephemeral,
  });
}

export async function upTermixTailscale(): Promise<void> {
  if (!Native)
    throw new Error("Termix Tailscale native module is not available");
  await Native.up();
}

export async function startTermixTailscaleForward(
  protocol: ForwardProtocol,
  remoteHost: string,
  remotePort: number,
): Promise<ForwardHandle> {
  if (!Native)
    throw new Error("Termix Tailscale native module is not available");
  const localPort = await Native.startForward(protocol, remoteHost, remotePort);
  return { protocol, remoteHost, remotePort, localPort };
}

export async function stopTermixTailscaleForward(
  handle: ForwardHandle,
): Promise<void> {
  if (!Native) return;
  await Native.stopForward(
    handle.protocol,
    handle.remoteHost,
    handle.remotePort,
    handle.localPort,
  );
}

export async function stopAllTermixTailscaleForwards(): Promise<void> {
  if (!Native) return;
  await Native.stopAllForwards();
}

export async function isTermixTailscaleForwardActive(
  handle: ForwardHandle,
): Promise<boolean> {
  if (!Native) return false;
  return Native.isForwardActive(
    handle.protocol,
    handle.remoteHost,
    handle.remotePort,
    handle.localPort,
  );
}

/**
 * True when the forward is registered and its remote target still accepts a
 * connection through the current node. A bound listener alone is not health.
 */
export async function probeTermixTailscaleForward(
  handle: ForwardHandle,
): Promise<boolean> {
  if (!Native) return false;
  return Native.probeForward(
    handle.protocol,
    handle.remoteHost,
    handle.remotePort,
    handle.localPort,
  );
}

export async function isTermixTailscaleUp(): Promise<boolean> {
  if (!Native) return false;
  return Native.isUp();
}

export async function getTermixTailscaleIPs(): Promise<string[]> {
  if (!Native) return [];
  const raw = await Native.getIPs();
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function closeTermixTailscale(): Promise<void> {
  if (!Native) return;
  await Native.close();
}
