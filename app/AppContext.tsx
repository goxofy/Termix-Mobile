import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { AppState, type AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import {
  addTermixTailscaleNetworkChangeListener,
  cancelTermixTailscaleCurrentOperation,
  getTermixTailscaleNetworkSnapshot,
  type NetworkSnapshot,
} from "@/modules/termix-tailscale";
import {
  applyServerTransportMode,
  blockServerTransportRequests,
  clearAuth,
  clearSession,
  failServerTransportRequests,
  getCurrentServerUrl,
  getDisplayServerUrl,
  getLatestGitHubRelease,
  getServerConfigMeta,
  getVersionInfo,
  initializeServerConfig,
  probeServerTransport,
  releaseServerTransportRequests,
  setAuthStateCallback,
  type ApplyServerTransportResult,
  type ServerTransportHealth,
} from "./main-axios";
import {
  getTailscaleTransportErrorMessage,
  invalidateTailscaleLifecycle,
  isTailscaleConfigured,
  saveTailscaleSettings,
} from "./utils/tailscaleConnect";
import {
  NetworkModeDialog,
  type NetworkModeChoice,
} from "./components/NetworkModeDialog";
import { clearCachedUserId } from "./utils/user";

interface Server {
  name: string;
  ip: string;
}

/** Steps the auth flow can be opened directly to. */
export type AuthStep = "server" | "login" | "signup";
export type TransportState = "recovering" | "ready" | "failed";

export type ConnectServerTransportInput = {
  serverUrl: string;
  mode: NetworkModeChoice;
  tailscaleAuthKey: string;
  tailscaleHostname: string;
};

export type SessionValidationResult =
  | { ok: true; health: ServerTransportHealth }
  | { ok: false; error: string; health?: ServerTransportHealth };

interface AppContextType {
  selectedServer: Server | null;
  setSelectedServer: (server: Server | null) => void;
  isAuthenticated: boolean;
  setAuthenticated: (auth: boolean) => void;
  showUpdateScreen: boolean;
  setShowUpdateScreen: (show: boolean) => void;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;

  /** Whether a server URL is currently configured (drives empty states). */
  hasServerConfigured: boolean;
  setHasServerConfigured: (has: boolean) => void;

  /** Shared transport must be ready before API calls and terminal foregrounding. */
  transportState: TransportState;
  transportReadyEpoch: number;
  transportError: string | null;
  retryTransport: () => void;
  cancelTransportRecovery: () => void;
  changeServer: () => void;
  connectServerTransport: (
    input: ConnectServerTransportInput,
  ) => Promise<ApplyServerTransportResult>;
  validateAuthenticatedSession: () => Promise<SessionValidationResult>;

  /** Auth flow overlay control. */
  authFlowVisible: boolean;
  authFlowInitialStep: AuthStep;
  openAuthFlow: (step?: AuthStep) => void;
  closeAuthFlow: () => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const useAppContext = () => {
  const context = useContext(AppContext);
  if (context === undefined) {
    throw new Error("useAppContext must be used within an AppProvider");
  }
  return context;
};

interface AppProviderProps {
  children: ReactNode;
}

type CoordinatorAttempt = {
  appGeneration: number;
  networkGeneration: number;
  networkSignature: string;
  mode: NetworkModeChoice;
  controller: AbortController;
};

const UNKNOWN_NETWORK_SNAPSHOT: NetworkSnapshot = {
  generation: 0,
  signature: "unknown|none|vpn:0",
  status: "unknown",
  transport: "none",
  systemVpn: false,
};

function canceledTransportResult(): ApplyServerTransportResult {
  return { ok: false, error: "The connection attempt was canceled." };
}

export const AppProvider: React.FC<AppProviderProps> = ({ children }) => {
  const [selectedServer, setSelectedServer] = useState<Server | null>(null);
  const [isAuthenticated, setAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showUpdateScreen, setShowUpdateScreen] = useState(false);
  const [hasServerConfigured, setHasServerConfigured] = useState(false);
  const [transportState, setTransportState] =
    useState<TransportState>("recovering");
  const [transportReadyEpoch, setTransportReadyEpoch] = useState(0);
  const [transportError, setTransportError] = useState<string | null>(null);

  const [authFlowVisible, setAuthFlowVisible] = useState(false);
  const [authFlowInitialStep, setAuthFlowInitialStep] =
    useState<AuthStep>("server");
  const [networkModeVisible, setNetworkModeVisible] = useState(false);
  const [networkModeBusy, setNetworkModeBusy] = useState(false);
  const [networkModeServerLabel, setNetworkModeServerLabel] = useState("");
  const [networkModeError, setNetworkModeError] = useState<string | null>(null);
  const [networkModeCanUseTailscale, setNetworkModeCanUseTailscale] =
    useState(false);

  const mountedRef = useRef(true);
  const bootCompleteRef = useRef(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const appGenerationRef = useRef(0);
  const latestSnapshotRef = useRef<NetworkSnapshot>(UNKNOWN_NETWORK_SNAPSHOT);
  const activeAttemptRef = useRef<CoordinatorAttempt | null>(null);
  const authValidationControllerRef = useRef<AbortController | null>(null);
  const lastAttemptModeRef = useRef<NetworkModeChoice | null>(null);
  const choiceSnapshotRef = useRef<NetworkSnapshot | null>(null);
  const authFlowVisibleRef = useRef(false);

  const openAuthFlow = useCallback((step: AuthStep = "server") => {
    authFlowVisibleRef.current = true;
    setAuthFlowInitialStep(step);
    setAuthFlowVisible(true);
  }, []);

  const closeAuthFlow = useCallback(() => {
    authFlowVisibleRef.current = false;
    setAuthFlowVisible(false);
  }, []);

  const markTransportReady = useCallback(() => {
    if (!mountedRef.current) return;
    setTransportState("ready");
    setTransportError(null);
    setNetworkModeError(null);
    setTransportReadyEpoch((epoch) => epoch + 1);
    releaseServerTransportRequests();
  }, []);

  const markTransportFailed = useCallback((error: unknown) => {
    const message = getTailscaleTransportErrorMessage(error);
    const reason = error instanceof Error ? error : new Error(message);
    // Reject work waiting on this attempt, then install a fresh barrier so later
    // requests cannot leak to a stale localhost port while recovery UI is open.
    failServerTransportRequests(reason);
    blockServerTransportRequests();
    if (mountedRef.current) {
      setTransportState("failed");
      setTransportError(message);
      setNetworkModeError(message);
    }
    return message;
  }, []);

  const clearAuthenticatedSession = useCallback(async () => {
    setAuthenticated(false);
    clearCachedUserId();
    await clearAuth();
  }, []);

  const supersedeCoordinator = useCallback(() => {
    appGenerationRef.current += 1;
    activeAttemptRef.current?.controller.abort();
    activeAttemptRef.current = null;
    authValidationControllerRef.current?.abort();
    authValidationControllerRef.current = null;
    if (mountedRef.current) setNetworkModeBusy(false);
    return appGenerationRef.current;
  }, []);

  const prepareTransportGate = useCallback(() => {
    blockServerTransportRequests();
    if (!mountedRef.current) return;
    setTransportState("recovering");
    setTransportError(null);
    setNetworkModeError(null);
  }, []);

  const isAttemptCurrent = useCallback((attempt: CoordinatorAttempt) => {
    const snapshot = latestSnapshotRef.current;
    return (
      mountedRef.current &&
      appStateRef.current === "active" &&
      !attempt.controller.signal.aborted &&
      activeAttemptRef.current === attempt &&
      appGenerationRef.current === attempt.appGeneration &&
      snapshot.generation === attempt.networkGeneration &&
      snapshot.signature === attempt.networkSignature
    );
  }, []);

  const syncAuthenticationFromHealth = useCallback(
    async (health: ServerTransportHealth, openLoginOnExpiry: boolean) => {
      if (health.sessionState === "unauthorized") {
        await clearAuthenticatedSession();
        if (openLoginOnExpiry) openAuthFlow("login");
        return;
      }
      if (
        health.sessionState === "authenticated" &&
        health.hostsState === "healthy" &&
        health.userInfo?.data_unlocked !== false
      ) {
        setAuthenticated(true);
        return;
      }
      // A token may still exist after transient/proxy failures. Keep it on disk,
      // but never mount authenticated screens until both user and Hosts validate.
      setAuthenticated(false);
    },
    [clearAuthenticatedSession, openAuthFlow],
  );

  const showNetworkModePrompt = useCallback(
    (
      snapshot: NetworkSnapshot,
      canUseTailscale: boolean,
      initialError?: string | null,
    ) => {
      choiceSnapshotRef.current = snapshot;
      setNetworkModeServerLabel(
        getDisplayServerUrl() || getCurrentServerUrl() || "",
      );
      setNetworkModeCanUseTailscale(canUseTailscale);
      setNetworkModeBusy(false);
      setNetworkModeError(initialError || null);
      setNetworkModeVisible(true);
    },
    [],
  );

  const executeTransportMode = useCallback(
    async (
      mode: NetworkModeChoice,
      snapshot: NetworkSnapshot,
      options: {
        appGeneration?: number;
        displayUrl?: string;
        showDialogOnFailure?: boolean;
        openLoginOnExpiry?: boolean;
      } = {},
    ): Promise<ApplyServerTransportResult> => {
      const appGeneration = options.appGeneration ?? supersedeCoordinator();
      if (appGeneration !== appGenerationRef.current) {
        return canceledTransportResult();
      }

      const controller = new AbortController();
      const attempt: CoordinatorAttempt = {
        appGeneration,
        networkGeneration: snapshot.generation,
        networkSignature: snapshot.signature,
        mode,
        controller,
      };
      activeAttemptRef.current = attempt;
      lastAttemptModeRef.current = mode;
      prepareTransportGate();
      setNetworkModeBusy(true);
      setNetworkModeError(null);

      let result: ApplyServerTransportResult;
      try {
        result = await applyServerTransportMode(mode, {
          displayUrl: options.displayUrl,
          networkSignature: snapshot.signature,
          networkGeneration: snapshot.generation,
          signal: controller.signal,
        });
      } catch (error) {
        if (!isAttemptCurrent(attempt)) return canceledTransportResult();
        activeAttemptRef.current = null;
        const message = markTransportFailed(error);
        setNetworkModeBusy(false);
        if (
          options.showDialogOnFailure !== false &&
          !authFlowVisibleRef.current
        ) {
          showNetworkModePrompt(
            snapshot,
            await isTailscaleConfigured().catch(() => false),
            message,
          );
        }
        return { ok: false, error: message };
      }

      if (!isAttemptCurrent(attempt)) return canceledTransportResult();

      if (!result.ok) {
        activeAttemptRef.current = null;
        const message = markTransportFailed(new Error(result.error));
        setNetworkModeBusy(false);
        if (
          options.showDialogOnFailure !== false &&
          !authFlowVisibleRef.current
        ) {
          const canUseTailscale = await isTailscaleConfigured().catch(
            () => false,
          );
          if (
            appGeneration === appGenerationRef.current &&
            appStateRef.current === "active"
          ) {
            showNetworkModePrompt(snapshot, canUseTailscale, message);
          }
        }
        return result;
      }

      await syncAuthenticationFromHealth(
        result.health,
        options.openLoginOnExpiry !== false,
      );
      if (!isAttemptCurrent(attempt)) return canceledTransportResult();

      activeAttemptRef.current = null;
      choiceSnapshotRef.current = null;
      setNetworkModeBusy(false);
      setNetworkModeVisible(false);
      const displayUrl =
        getDisplayServerUrl() || options.displayUrl || "Server";
      setSelectedServer({ name: "Server", ip: displayUrl });
      setHasServerConfigured(true);
      markTransportReady();
      return result;
    },
    [
      isAttemptCurrent,
      markTransportFailed,
      markTransportReady,
      prepareTransportGate,
      showNetworkModePrompt,
      supersedeCoordinator,
      syncAuthenticationFromHealth,
    ],
  );

  const coordinateTransport = useCallback(
    async (snapshot: NetworkSnapshot) => {
      if (!bootCompleteRef.current || appStateRef.current !== "active") return;

      const appGeneration = supersedeCoordinator();
      prepareTransportGate();
      setNetworkModeVisible(false);

      const displayUrl = getDisplayServerUrl() || getCurrentServerUrl();
      const config = getServerConfigMeta();
      if (!displayUrl) {
        setSelectedServer(null);
        setHasServerConfigured(false);
        setAuthenticated(false);
        markTransportReady();
        openAuthFlow("server");
        return;
      }

      setSelectedServer({ name: "Server", ip: displayUrl });
      setHasServerConfigured(true);
      const canUseTailscale = await isTailscaleConfigured().catch(() => false);
      if (
        appGeneration !== appGenerationRef.current ||
        appStateRef.current !== "active"
      ) {
        return;
      }

      const topologyChanged =
        !config?.lastNetworkSignature ||
        config.lastNetworkSignature !== snapshot.signature;
      if (topologyChanged && canUseTailscale) {
        showNetworkModePrompt(snapshot, true);
        return;
      }

      const mode: NetworkModeChoice =
        config?.viaTailscale && canUseTailscale ? "tailscale" : "direct";
      await executeTransportMode(mode, snapshot, {
        appGeneration,
        showDialogOnFailure: true,
        openLoginOnExpiry: true,
      });
    },
    [
      executeTransportMode,
      markTransportReady,
      openAuthFlow,
      prepareTransportGate,
      showNetworkModePrompt,
      supersedeCoordinator,
    ],
  );

  const adoptFreshSnapshot = useCallback((snapshot: NetworkSnapshot) => {
    const current = latestSnapshotRef.current;
    if (snapshot.generation < current.generation) return current;
    if (
      snapshot.signature !== current.signature ||
      snapshot.generation !== current.generation
    ) {
      latestSnapshotRef.current = snapshot;
    }
    return latestSnapshotRef.current;
  }, []);

  const refreshSnapshotAndCoordinate = useCallback(async () => {
    const generationBeforeRead = appGenerationRef.current;
    let snapshot = latestSnapshotRef.current;
    try {
      const nativeSnapshot = await getTermixTailscaleNetworkSnapshot();
      if (nativeSnapshot.signature !== snapshot.signature) {
        invalidateTailscaleLifecycle(nativeSnapshot.generation);
      }
      snapshot = adoptFreshSnapshot(nativeSnapshot);
    } catch {
      // The normalized fallback remains stable on builds without the module.
    }
    if (
      appStateRef.current !== "active" ||
      generationBeforeRead !== appGenerationRef.current
    ) {
      return;
    }
    await coordinateTransport(snapshot);
  }, [adoptFreshSnapshot, coordinateTransport]);

  const retryTransport = useCallback(() => {
    void refreshSnapshotAndCoordinate();
  }, [refreshSnapshotAndCoordinate]);

  const cancelTransportRecovery = useCallback(() => {
    supersedeCoordinator();
    cancelTermixTailscaleCurrentOperation();
    setNetworkModeVisible(false);
    setNetworkModeBusy(false);
    setIsLoading(false);
    markTransportFailed(new Error("The connection attempt was canceled."));
  }, [markTransportFailed, supersedeCoordinator]);

  const changeServer = useCallback(() => {
    supersedeCoordinator();
    cancelTermixTailscaleCurrentOperation();
    setNetworkModeVisible(false);
    setNetworkModeBusy(false);
    setIsLoading(false);
    setAuthenticated(false);
    clearCachedUserId();
    void clearSession().catch(() => undefined);
    markTransportFailed(
      new Error("Choose a server and connection mode to continue."),
    );
    openAuthFlow("server");
  }, [markTransportFailed, openAuthFlow, supersedeCoordinator]);

  const connectServerTransport = useCallback(
    async (
      input: ConnectServerTransportInput,
    ): Promise<ApplyServerTransportResult> => {
      setAuthenticated(false);
      try {
        await saveTailscaleSettings({
          authKey: input.tailscaleAuthKey,
          hostname: input.tailscaleHostname,
        });
      } catch (error) {
        const message = markTransportFailed(error);
        return { ok: false, error: message };
      }

      let snapshot = latestSnapshotRef.current;
      try {
        const nativeSnapshot = await getTermixTailscaleNetworkSnapshot();
        if (nativeSnapshot.signature !== snapshot.signature) {
          invalidateTailscaleLifecycle(nativeSnapshot.generation);
        }
        snapshot = adoptFreshSnapshot(nativeSnapshot);
      } catch {
        // Use the last immutable snapshot.
      }

      return executeTransportMode(input.mode, snapshot, {
        displayUrl: input.serverUrl,
        showDialogOnFailure: false,
        openLoginOnExpiry: false,
      });
    },
    [adoptFreshSnapshot, executeTransportMode, markTransportFailed],
  );

  const validateAuthenticatedSession =
    useCallback(async (): Promise<SessionValidationResult> => {
      const token = await AsyncStorage.getItem("jwt");
      const runtimeUrl = getCurrentServerUrl();
      if (!token || !runtimeUrl) {
        setAuthenticated(false);
        return {
          ok: false as const,
          error: "No reusable login session is available.",
        };
      }

      authValidationControllerRef.current?.abort();
      const controller = new AbortController();
      authValidationControllerRef.current = controller;
      const appGeneration = appGenerationRef.current;
      const snapshot = latestSnapshotRef.current;

      try {
        const health = await probeServerTransport(runtimeUrl, {
          token,
          signal: controller.signal,
        });
        if (
          controller.signal.aborted ||
          appGeneration !== appGenerationRef.current ||
          snapshot.generation !== latestSnapshotRef.current.generation
        ) {
          return {
            ok: false as const,
            error: "The network changed while the session was being validated.",
          };
        }
        if (health.sessionState === "unauthorized") {
          await clearAuthenticatedSession();
          return {
            ok: false as const,
            error: health.error || "The server rejected the login session.",
            health,
          };
        }
        if (
          health.ok &&
          health.sessionState === "authenticated" &&
          health.hostsState === "healthy" &&
          health.userInfo?.data_unlocked !== false
        ) {
          setAuthenticated(true);
          return { ok: true as const, health };
        }
        setAuthenticated(false);
        return {
          ok: false as const,
          error:
            health.error ||
            "Signed in, but the Termix user and Hosts APIs could not be validated.",
          health,
        };
      } catch (error) {
        setAuthenticated(false);
        return {
          ok: false as const,
          error:
            error instanceof Error
              ? error.message
              : "Could not validate the login session.",
        };
      } finally {
        if (authValidationControllerRef.current === controller) {
          authValidationControllerRef.current = null;
        }
      }
    }, [clearAuthenticatedSession]);

  const handleNetworkModeChoice = useCallback(
    (choice: NetworkModeChoice) => {
      const snapshot = choiceSnapshotRef.current || latestSnapshotRef.current;
      void executeTransportMode(choice, snapshot, {
        showDialogOnFailure: true,
        openLoginOnExpiry: true,
      });
    },
    [executeTransportMode],
  );

  const handleNetworkModeRetry = useCallback(() => {
    const mode = lastAttemptModeRef.current;
    if (!mode) {
      retryTransport();
      return;
    }
    const snapshot = choiceSnapshotRef.current || latestSnapshotRef.current;
    void executeTransportMode(mode, snapshot, {
      showDialogOnFailure: true,
      openLoginOnExpiry: true,
    });
  }, [executeTransportMode, retryTransport]);

  const checkShouldShowUpdateScreen = useCallback(async () => {
    try {
      const currentAppVersion = Constants.expoConfig?.version || "1.0.0";
      const latestRelease = await getLatestGitHubRelease();
      if (!latestRelease || currentAppVersion === latestRelease.version) {
        return false;
      }
      const dismissedVersion = await AsyncStorage.getItem(
        "dismissedUpdateVersion",
      );
      return dismissedVersion !== latestRelease.version;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    const handleNetworkChange = (snapshot: NetworkSnapshot) => {
      const previous = latestSnapshotRef.current;
      if (
        snapshot.generation < previous.generation ||
        (snapshot.generation === previous.generation &&
          snapshot.signature === previous.signature)
      ) {
        return;
      }

      latestSnapshotRef.current = snapshot;
      invalidateTailscaleLifecycle(snapshot.generation);
      supersedeCoordinator();
      prepareTransportGate();
      setNetworkModeVisible(false);
      choiceSnapshotRef.current = snapshot;
      if (bootCompleteRef.current && appStateRef.current === "active") {
        void coordinateTransport(snapshot);
      }
    };

    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      appStateRef.current = nextAppState;
      if (!bootCompleteRef.current) return;

      if (nextAppState !== "active") {
        supersedeCoordinator();
        prepareTransportGate();
        setNetworkModeVisible(false);
        return;
      }

      void refreshSnapshotAndCoordinate();
    };

    const networkSubscription =
      addTermixTailscaleNetworkChangeListener(handleNetworkChange);
    const appStateSubscription = AppState.addEventListener(
      "change",
      handleAppStateChange,
    );

    const initializeApp = async () => {
      blockServerTransportRequests();
      setTransportState("recovering");
      setIsLoading(true);
      try {
        await initializeServerConfig({
          rehydrateTailscale: false,
          detect: false,
        });

        try {
          adoptFreshSnapshot(await getTermixTailscaleNetworkSnapshot());
        } catch {
          // Keep the normalized unknown snapshot.
        }

        const displayUrl = getDisplayServerUrl() || getCurrentServerUrl();
        setHasServerConfigured(!!displayUrl);
        setSelectedServer(
          displayUrl ? { name: "Server", ip: displayUrl } : null,
        );
        setAuthenticated(false);
        bootCompleteRef.current = true;
        setIsLoading(false);

        if (appStateRef.current === "active") {
          await coordinateTransport(latestSnapshotRef.current);
        }

        void getVersionInfo().catch((error) => {
          console.warn("[AppContext] Version check failed:", error);
        });
        void checkShouldShowUpdateScreen().then((show) => {
          if (mountedRef.current) setShowUpdateScreen(show);
        });
      } catch (error) {
        bootCompleteRef.current = true;
        setIsLoading(false);
        const displayUrl = getDisplayServerUrl() || getCurrentServerUrl();
        setHasServerConfigured(!!displayUrl);
        setSelectedServer(
          displayUrl ? { name: "Server", ip: displayUrl } : null,
        );
        setAuthenticated(false);
        if (displayUrl) {
          const message = markTransportFailed(error);
          showNetworkModePrompt(
            latestSnapshotRef.current,
            await isTailscaleConfigured().catch(() => false),
            message,
          );
        } else {
          markTransportReady();
          openAuthFlow("server");
        }
        console.error("[AppContext] Failed to initialize app:", error);
      }
    };

    void initializeApp();
    return () => {
      mountedRef.current = false;
      supersedeCoordinator();
      networkSubscription?.remove();
      appStateSubscription.remove();
    };
  }, [
    adoptFreshSnapshot,
    checkShouldShowUpdateScreen,
    coordinateTransport,
    markTransportFailed,
    markTransportReady,
    openAuthFlow,
    prepareTransportGate,
    refreshSnapshotAndCoordinate,
    showNetworkModePrompt,
    supersedeCoordinator,
  ]);

  useEffect(() => {
    setAuthStateCallback((authed: boolean) => {
      if (!authed) void clearAuthenticatedSession();
    });
  }, [clearAuthenticatedSession]);

  // The auth flow can commit a new server without changing authentication state.
  useEffect(() => {
    if (authFlowVisible) return;
    const displayUrl = getDisplayServerUrl() || getCurrentServerUrl();
    setHasServerConfigured(!!displayUrl);
    setSelectedServer(displayUrl ? { name: "Server", ip: displayUrl } : null);
  }, [authFlowVisible]);

  return (
    <AppContext.Provider
      value={{
        selectedServer,
        setSelectedServer,
        isAuthenticated,
        setAuthenticated,
        showUpdateScreen,
        setShowUpdateScreen,
        isLoading,
        setIsLoading,
        hasServerConfigured,
        setHasServerConfigured,
        transportState,
        transportReadyEpoch,
        transportError,
        retryTransport,
        cancelTransportRecovery,
        changeServer,
        connectServerTransport,
        validateAuthenticatedSession,
        authFlowVisible,
        authFlowInitialStep,
        openAuthFlow,
        closeAuthFlow,
      }}
    >
      {children}
      <NetworkModeDialog
        visible={networkModeVisible}
        busy={networkModeBusy}
        canUseTailscale={networkModeCanUseTailscale}
        retryMode={lastAttemptModeRef.current}
        serverLabel={networkModeServerLabel}
        errorMessage={networkModeError}
        onChoose={handleNetworkModeChoice}
        onRetry={handleNetworkModeRetry}
        onCancel={cancelTransportRecovery}
        onChangeServer={changeServer}
      />
    </AppContext.Provider>
  );
};
