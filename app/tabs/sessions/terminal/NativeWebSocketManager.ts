import * as mainAxios from "../../../main-axios";

type MainAxiosWithTransportBarrier = typeof mainAxios & {
  waitForServerTransportReady?: () => Promise<void>;
};

async function waitForServerTransportReady(): Promise<void> {
  const waitForReady = (mainAxios as MainAxiosWithTransportBarrier)
    .waitForServerTransportReady;
  if (waitForReady) {
    await waitForReady();
  }
}

export interface TerminalHostConfig {
  id: number;
  name: string;
  ip: string;
  port: number;
  username: string;
  authType: "password" | "key" | "credential" | "none";
  password?: string;
  key?: string;
  keyPassword?: string;
  keyType?: string;
  credentialId?: number;
  jumpHosts?: { hostId: number }[];
  forceKeyboardInteractive?: boolean;
  overrideCredentialUsername?: boolean;
}

export type WsState =
  | "connecting"
  | "connected"
  | "disconnected"
  | "dataReceived"
  | "connectionFailed";

export interface HostKeyData {
  ip: string;
  port: number;
  hostname?: string;
  fingerprint: string;
  oldFingerprint?: string;
  keyType: string;
  oldKeyType?: string;
  algorithm: string;
}

export interface NativeWSConfig {
  hostConfig: TerminalHostConfig;
  /** Stable tab instance id for cross-device session tracking (open-tabs). */
  tabInstanceId?: string;
  /** Backend session id to attach to on first connect (reviving a tab). */
  initialSessionId?: string | null;
  onStateChange: (state: WsState, data?: Record<string, unknown>) => void;
  onData: (data: string) => void;
  onTotpRequired: (prompt: string, isPassword: boolean) => void;
  onAuthDialogNeeded: (
    reason: "no_keyboard" | "auth_failed" | "timeout",
  ) => void;
  onHostKeyVerificationRequired?: (
    scenario: "new" | "changed",
    data: HostKeyData,
  ) => void;
  onPassphraseRequired?: () => void;
  onWarpgateAuthRequired?: (url: string, securityKey: string) => void;
  onPostConnectionSetup: () => void;
  onDisconnected: (hostName: string) => void;
  onConnectionFailed: (message: string) => void;
  /** Fired once when the backend reports that the terminal session ended. */
  onSessionEnded: () => void;
  /** Fired when the backend session id is created/attached/cleared. */
  onSessionIdChange?: (sessionId: string | null) => void;
  /** Fired for each `connection_log` WS message from the server. */
  onConnectionLog?: (entry: {
    level?: string;
    stage?: string;
    message: string;
  }) => void;
}

export class NativeWebSocketManager {
  private config: NativeWSConfig;
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private readonly maxReconnectAttempts = 5;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private connectionTimeout: ReturnType<typeof setTimeout> | null = null;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private pongTimeout: ReturnType<typeof setTimeout> | null = null;
  private shouldNotReconnect = false;
  private hasNotifiedFailure = false;
  private isAppInBackground = false;
  private backgroundTime: number | null = null;
  private isReconnectFromBackground = false;
  private currentConnectionFromBackground = false;
  private destroyed = false;
  private sessionEnded = false;
  private connectionGeneration = 0;
  private cols = 80;
  private rows = 24;
  private serverSessionId: string | null = null;
  private pendingReattach = false;
  private awaitingAuthCredentials = false;

  constructor(config: NativeWSConfig) {
    this.config = config;
    // Seed the backend session id when reviving a backgrounded/cross-device tab.
    if (config.initialSessionId) {
      this.serverSessionId = config.initialSessionId;
    }
  }

  private setServerSessionId(id: string | null) {
    if (this.serverSessionId === id) return;
    this.serverSessionId = id;
    this.config.onSessionIdChange?.(id);
  }

  async connect(cols: number, rows: number): Promise<void> {
    if (this.destroyed || this.sessionEnded) return;

    this.cols = cols;
    this.rows = rows;

    await this.connectWebSocket();
  }

  destroy(): void {
    if (this.destroyed) return;

    this.destroyed = true;
    this.shouldNotReconnect = true;
    this.awaitingAuthCredentials = false;
    this.connectionGeneration += 1;

    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: "disconnect" }));
      } catch (_) {}
    }

    this.setServerSessionId(null);
    this.pendingReattach = false;
    this.clearAllTimers();
    if (ws) {
      this.detachAndCloseSocket(ws, 1000, "Component unmounted");
    }
  }

  sendInput(data: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "input", data }));
      } catch (e) {}
    }
  }

  sendResize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: "resize", data: { cols, rows } }));
      } catch (e) {}
    }
  }

  sendTotpResponse(code: string, isPassword: boolean): void {
    const responseType = isPassword ? "password_response" : "totp_response";
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(JSON.stringify({ type: responseType, data: { code } }));
      } catch (e) {}
    }
  }

  sendHostKeyResponse(action: "accept" | "reject"): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(
          JSON.stringify({
            type: "host_key_verification_response",
            data: { action },
          }),
        );
      } catch (e) {}
    }
  }

  sendReconnectWithCredentials(
    credentials: { password?: string; sshKey?: string; keyPassword?: string },
    cols: number,
    rows: number,
  ): void {
    this.cols = cols;
    this.rows = rows;
    const updatedHostConfig: TerminalHostConfig = {
      ...this.config.hostConfig,
      password: credentials.password,
      key: credentials.sshKey,
      keyPassword: credentials.keyPassword,
      authType: (credentials.password ? "password" : "key") as
        | "password"
        | "key",
    };

    this.config.hostConfig = updatedHostConfig;
    this.awaitingAuthCredentials = false;
    this.shouldNotReconnect = false;
    this.hasNotifiedFailure = false;

    const messageData = {
      password: credentials.password,
      sshKey: credentials.sshKey,
      keyPassword: credentials.keyPassword,
      hostConfig: updatedHostConfig,
      cols,
      rows,
    };

    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(
          JSON.stringify({
            type: "reconnect_with_credentials",
            data: messageData,
          }),
        );
      } catch (e) {}
      return;
    }

    this.clearAllTimers();
    void this.connectWebSocket();
  }

  sendWarpgateContinue(): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(
          JSON.stringify({ type: "warpgate_auth_continue", data: {} }),
        );
      } catch (_) {}
    }
  }

  sendPassphraseResponse(passphrase: string): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      try {
        this.ws.send(
          JSON.stringify({
            type: "reconnect_with_credentials",
            data: {
              keyPassword: passphrase,
              hostConfig: {
                ...this.config.hostConfig,
                keyPassword: passphrase,
              },
              cols: this.cols,
              rows: this.rows,
            },
          }),
        );
      } catch (_) {}
    }
  }

  notifyBackgrounded(): void {
    this.isAppInBackground = true;
    this.backgroundTime = Date.now();
    this.reconnectAttempts = 0;
    this.stopPingInterval();
    this.clearReconnectTimeout();
    this.clearConnectionTimeout();
  }

  notifyForegrounded(): void {
    const wasInBackground = this.isAppInBackground;
    this.isAppInBackground = false;
    this.backgroundTime = null;

    if (!wasInBackground || this.destroyed || this.sessionEnded) return;

    const viaTailscale = !!mainAxios.getServerConfigMeta()?.viaTailscale;
    const ws = this.ws;
    if (!viaTailscale && ws && ws.readyState === WebSocket.OPEN) {
      this.isReconnectFromBackground = false;
      this.startPingInterval(ws, this.connectionGeneration);
      return;
    }

    this.isReconnectFromBackground = true;
    this.reconnectAttempts = 0;
    this.connectionGeneration += 1;
    this.clearAllTimers();

    if (ws) {
      this.detachAndCloseSocket(ws);
    }

    void this.connectWebSocket();
  }

  private async connectWebSocket(): Promise<void> {
    if (this.destroyed || this.sessionEnded || this.isAppInBackground) return;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    this.clearReconnectTimeout();
    this.clearConnectionTimeout();
    this.stopPingInterval();
    this.clearPongTimeout();

    const previousSocket = this.ws;
    const generation = ++this.connectionGeneration;
    if (previousSocket) {
      this.detachAndCloseSocket(previousSocket);
    }

    this.config.onStateChange("connecting", {
      retryCount: this.reconnectAttempts,
    });

    try {
      await waitForServerTransportReady();
      if (!this.isCurrentAttempt(generation) || this.isAppInBackground) return;

      const jwtToken = await mainAxios.getCookie("jwt");
      if (!this.isCurrentAttempt(generation) || this.isAppInBackground) return;

      const serverUrl = mainAxios.getCurrentServerUrl();
      if (!serverUrl) {
        this.config.onConnectionFailed(
          "No server URL found - please configure a server first",
        );
        return;
      }

      if (!jwtToken || jwtToken.trim() === "") {
        this.config.onConnectionFailed(
          "Authentication required - please log in again",
        );
        return;
      }

      const wsProtocol = serverUrl.startsWith("https://") ? "wss://" : "ws://";
      const wsHost = serverUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
      const wsUrl = `${wsProtocol}${wsHost}/ssh/websocket/?token=${encodeURIComponent(jwtToken)}`;

      if (!this.isCurrentAttempt(generation) || this.isAppInBackground) return;

      const ws = new WebSocket(wsUrl);
      if (!this.isCurrentAttempt(generation)) {
        this.detachAndCloseSocket(ws);
        return;
      }
      this.ws = ws;
      this.configureSocket(ws, generation);
    } catch (_) {
      if (!this.isCurrentAttempt(generation) || this.isAppInBackground) return;
      this.scheduleReconnect(generation);
    }
  }

  private configureSocket(ws: WebSocket, generation: number): void {
    const connectionTimeout = setTimeout(() => {
      if (
        this.connectionTimeout !== connectionTimeout ||
        !this.isCurrentSocket(ws, generation)
      ) {
        return;
      }
      this.connectionTimeout = null;

      if (ws.readyState === WebSocket.CONNECTING) {
        this.detachAndCloseSocket(ws);
        if (
          !this.shouldNotReconnect &&
          this.reconnectAttempts < this.maxReconnectAttempts
        ) {
          this.scheduleReconnect(generation);
        } else {
          this.notifyFailureOnce("Connection timeout - server not responding");
        }
      }
    }, 10000);
    this.connectionTimeout = connectionTimeout;

    ws.onopen = () => {
      if (!this.isCurrentSocket(ws, generation)) return;

      this.clearConnectionTimeout();
      this.clearReconnectTimeout();

      this.hasNotifiedFailure = false;
      this.reconnectAttempts = 0;

      this.currentConnectionFromBackground = this.isReconnectFromBackground;
      this.isReconnectFromBackground = false;

      try {
        if (this.serverSessionId) {
          this.pendingReattach = true;
          ws.send(
            JSON.stringify({
              type: "attachSession",
              data: {
                sessionId: this.serverSessionId,
                cols: this.cols,
                rows: this.rows,
                tabInstanceId: this.config.tabInstanceId,
              },
            }),
          );
        } else {
          this.pendingReattach = false;
          ws.send(
            JSON.stringify({
              type: "connectToHost",
              data: {
                cols: this.cols,
                rows: this.rows,
                hostConfig: this.config.hostConfig,
                tabInstanceId: this.config.tabInstanceId,
              },
            }),
          );
        }
      } catch (_) {
        this.handleSocketError(ws, generation);
        return;
      }

      this.startPingInterval(ws, generation);
    };

    ws.onmessage = (event: MessageEvent) => {
      if (!this.isCurrentSocket(ws, generation)) return;
      try {
        const msg = JSON.parse(event.data as string);

        if (msg.type === "data") {
          this.config.onData(msg.data as string);
          this.config.onStateChange("dataReceived", {
            hostName: this.config.hostConfig.name,
          });
        } else if (msg.type === "totp_required") {
          this.config.onTotpRequired(
            (msg.prompt as string) || "Verification code:",
            false,
          );
        } else if (msg.type === "password_required") {
          this.awaitingAuthCredentials = true;
          this.shouldNotReconnect = true;
          this.config.onTotpRequired(
            (msg.prompt as string) || "Password:",
            true,
          );
        } else if (
          msg.type === "keyboard_interactive_available" ||
          msg.type === "auth_method_not_available"
        ) {
          this.awaitingAuthCredentials = true;
          this.shouldNotReconnect = true;
          this.config.onAuthDialogNeeded("no_keyboard");
        } else if (msg.type === "host_key_verification_required") {
          this.clearConnectionTimeout();
          if (this.config.onHostKeyVerificationRequired) {
            this.config.onHostKeyVerificationRequired(
              "new",
              msg.data as HostKeyData,
            );
          } else {
            this.shouldNotReconnect = true;
            this.notifyFailureOnce(
              "Host key verification required but no handler is registered",
            );
          }
        } else if (msg.type === "host_key_changed") {
          this.clearConnectionTimeout();
          if (this.config.onHostKeyVerificationRequired) {
            this.config.onHostKeyVerificationRequired(
              "changed",
              msg.data as HostKeyData,
            );
          } else {
            this.shouldNotReconnect = true;
            this.notifyFailureOnce(
              "Host key changed but no handler is registered",
            );
          }
        } else if (msg.type === "passphrase_required") {
          this.clearConnectionTimeout();
          this.config.onPassphraseRequired?.();
        } else if (msg.type === "warpgate_auth_required") {
          this.clearConnectionTimeout();
          this.config.onWarpgateAuthRequired?.(
            (msg.url as string) || "",
            (msg.securityKey as string) || "",
          );
        } else if (msg.type === "error") {
          const message = (msg.message as string) || "Unknown error";
          if (
            this.config.hostConfig.authType === "none" &&
            this.isAuthenticationError(message)
          ) {
            this.awaitingAuthCredentials = true;
            this.shouldNotReconnect = true;
            this.config.onAuthDialogNeeded("no_keyboard");
            return;
          }

          if (this.isUnrecoverableError(message)) {
            this.shouldNotReconnect = true;
            this.notifyFailureOnce("Authentication failed: " + message);
            try {
              ws.close(1000);
            } catch (_) {}
            return;
          }
        } else if (msg.type === "connected") {
          const isReattach = this.pendingReattach;
          this.pendingReattach = false;
          this.config.onStateChange("connected", {
            hostName: this.config.hostConfig.name,
            fromBackground: this.currentConnectionFromBackground,
            isReattach,
          });
          if (!this.currentConnectionFromBackground && !isReattach) {
            this.config.onPostConnectionSetup();
          }
        } else if (msg.type === "disconnected") {
          this.setServerSessionId(null);
          this.config.onDisconnected(this.config.hostConfig.name);
        } else if (msg.type === "session_ended") {
          this.handleSessionEnded(ws, generation);
        } else if (msg.type === "pong") {
          this.clearPongTimeout();
        } else if (msg.type === "resized") {
        } else if (msg.type === "sessionCreated") {
          this.setServerSessionId(msg.sessionId as string);
        } else if (msg.type === "sessionAttached") {
          this.setServerSessionId(msg.sessionId as string);
        } else if (msg.type === "sessionExpired") {
          this.setServerSessionId(null);
          this.pendingReattach = false;
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(
              JSON.stringify({
                type: "connectToHost",
                data: {
                  cols: this.cols,
                  rows: this.rows,
                  hostConfig: this.config.hostConfig,
                  tabInstanceId: this.config.tabInstanceId,
                },
              }),
            );
          }
        } else if (msg.type === "sessionTakenOver") {
          this.setServerSessionId(null);
          this.shouldNotReconnect = true;
          this.config.onDisconnected(this.config.hostConfig.name);
        } else if (msg.type === "connection_log") {
          if (msg.data) {
            this.config.onConnectionLog?.(
              msg.data as { level?: string; stage?: string; message: string },
            );
          }
        }
      } catch (_) {
        // Malformed/non-JSON frame — discard rather than printing garbage to terminal.
      }
    };

    ws.onclose = (event: CloseEvent) => {
      if (!this.isCurrentSocket(ws, generation)) return;

      this.clearConnectionTimeout();
      this.stopPingInterval();
      this.clearPongTimeout();
      this.detachSocketHandlers(ws);
      this.ws = null;

      // Keep auth-dialog state intact while waiting for user input.
      if (!this.shouldNotReconnect) {
        this.awaitingAuthCredentials = false;
      }

      if (this.isAppInBackground || this.destroyed || this.sessionEnded) return;

      if (this.shouldNotReconnect) {
        this.notifyFailureOnce("Connection closed");
        return;
      }

      if (event.code === 1000 || event.code === 1001) {
        this.notifyFailureOnce("Connection closed");
        return;
      }

      this.scheduleReconnect(generation);
    };

    ws.onerror = () => {
      if (!this.isCurrentSocket(ws, generation)) return;

      this.clearConnectionTimeout();
      if (this.shouldNotReconnect) return;

      this.handleSocketError(ws, generation);
    };
  }

  private scheduleReconnect(generation: number): void {
    if (
      !this.isCurrentAttempt(generation) ||
      this.shouldNotReconnect ||
      this.isAppInBackground ||
      this.reconnectTimeout
    ) {
      return;
    }

    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.notifyFailureOnce("Maximum reconnection attempts reached");
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      5000,
    );

    this.config.onStateChange("connecting", {
      retryCount: this.reconnectAttempts,
    });

    const reconnectTimeout = setTimeout(() => {
      if (
        this.reconnectTimeout !== reconnectTimeout ||
        !this.isCurrentAttempt(generation)
      ) {
        return;
      }
      this.reconnectTimeout = null;
      if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
      void this.connectWebSocket();
    }, delay);
    this.reconnectTimeout = reconnectTimeout;
  }

  private startPingInterval(ws: WebSocket, generation: number): void {
    this.stopPingInterval();
    if (this.isAppInBackground || !this.isCurrentSocket(ws, generation)) return;

    const pingInterval = setInterval(() => {
      if (
        this.pingInterval !== pingInterval ||
        !this.isCurrentSocket(ws, generation)
      ) {
        return;
      }
      if (ws.readyState !== WebSocket.OPEN) return;

      try {
        ws.send(JSON.stringify({ type: "ping" }));
        this.clearPongTimeout();

        const pongTimeout = setTimeout(() => {
          if (
            this.pongTimeout !== pongTimeout ||
            !this.isCurrentSocket(ws, generation)
          ) {
            return;
          }
          this.pongTimeout = null;
          if (this.isAppInBackground) return;
          this.handleSocketError(ws, generation);
        }, 10000);
        this.pongTimeout = pongTimeout;
      } catch (_) {
        this.handleSocketError(ws, generation);
      }
    }, 25000);
    this.pingInterval = pingInterval;
  }

  private stopPingInterval(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  private clearPongTimeout(): void {
    if (this.pongTimeout) {
      clearTimeout(this.pongTimeout);
      this.pongTimeout = null;
    }
  }

  private clearReconnectTimeout(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
      this.reconnectTimeout = null;
    }
  }

  private clearConnectionTimeout(): void {
    if (this.connectionTimeout) {
      clearTimeout(this.connectionTimeout);
      this.connectionTimeout = null;
    }
  }

  private isCurrentAttempt(generation: number): boolean {
    return (
      !this.destroyed &&
      !this.sessionEnded &&
      generation === this.connectionGeneration
    );
  }

  private isCurrentSocket(ws: WebSocket, generation: number): boolean {
    return this.isCurrentAttempt(generation) && this.ws === ws;
  }

  private handleSocketError(ws: WebSocket, generation: number): void {
    if (!this.isCurrentSocket(ws, generation) || this.shouldNotReconnect)
      return;

    this.clearConnectionTimeout();
    this.stopPingInterval();
    this.clearPongTimeout();
    this.detachAndCloseSocket(ws);

    if (!this.isAppInBackground) {
      this.scheduleReconnect(generation);
    }
  }

  private handleSessionEnded(ws: WebSocket, generation: number): void {
    if (!this.isCurrentSocket(ws, generation) || this.sessionEnded) return;

    this.sessionEnded = true;
    this.shouldNotReconnect = true;
    this.awaitingAuthCredentials = false;
    this.pendingReattach = false;
    this.connectionGeneration += 1;
    this.clearAllTimers();
    this.setServerSessionId(null);
    this.detachAndCloseSocket(ws, 1000, "Session ended");
    this.config.onSessionEnded();
  }

  private detachSocketHandlers(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
  }

  private detachAndCloseSocket(
    ws: WebSocket,
    code?: number,
    reason?: string,
  ): void {
    this.detachSocketHandlers(ws);
    if (this.ws === ws) {
      this.ws = null;
    }

    try {
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close(code, reason);
      }
    } catch (_) {}
  }

  private clearAllTimers(): void {
    this.stopPingInterval();
    this.clearReconnectTimeout();
    this.clearPongTimeout();
    this.clearConnectionTimeout();
  }

  private notifyFailureOnce(message: string): void {
    if (this.hasNotifiedFailure) return;
    this.hasNotifiedFailure = true;
    this.config.onConnectionFailed(
      `${this.config.hostConfig.name}: ${message}`,
    );
  }

  private isUnrecoverableError(message: string): boolean {
    return this.isAuthenticationError(message);
  }

  private isAuthenticationError(message: string): boolean {
    if (!message) return false;
    const m = message.toLowerCase();
    return (
      m.includes("password") ||
      m.includes("authentication") ||
      m.includes("permission denied") ||
      m.includes("invalid") ||
      m.includes("incorrect") ||
      m.includes("denied")
    );
  }
}
