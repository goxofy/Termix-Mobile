import React, {
  createContext,
  useContext,
  useState,
  ReactNode,
  useEffect,
  useRef,
  useCallback,
} from "react";
import { AppState, AppStateStatus } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import {
  applyServerTransportMode,
  blockServerTransportRequests,
  clearAuth,
  detectServerRoutes,
  failServerTransportRequests,
  getCurrentServerUrl,
  getDisplayServerUrl,
  getLatestGitHubRelease,
  getServerConfigMeta,
  getUserInfo,
  getVersionInfo,
  initializeServerConfig,
  isUnauthorizedError,
  releaseServerTransportRequests,
  setAuthStateCallback,
  setRuntimeTransportUrl,
} from "./main-axios";
import {
  getLiveTransportUrl,
  getTailscaleTransportErrorMessage,
  isTailscaleConfigured,
  recoverTailscaleTransport,
} from "./utils/tailscaleConnect";
import {
  NetworkModeDialog,
  type NetworkModeChoice,
} from "./components/NetworkModeDialog";
import Constants from "expo-constants";
import { clearCachedUserId } from "./utils/user";

interface Server {
  name: string;
  ip: string;
}

/** Steps the auth flow can be opened directly to. */
export type AuthStep = "server" | "login" | "signup";
export type TransportState = "recovering" | "ready" | "failed";

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

export const AppProvider: React.FC<AppProviderProps> = ({ children }) => {
  const [selectedServer, setSelectedServer] = useState<Server | null>(null);
  const [isAuthenticated, setAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [showUpdateScreen, setShowUpdateScreen] = useState<boolean>(false);
  const [hasServerConfigured, setHasServerConfigured] = useState(false);
  const [transportState, setTransportState] =
    useState<TransportState>("recovering");
  const [transportReadyEpoch, setTransportReadyEpoch] = useState(0);

  const [authFlowVisible, setAuthFlowVisible] = useState(false);
  const [authFlowInitialStep, setAuthFlowInitialStep] =
    useState<AuthStep>("server");
  const [networkModeVisible, setNetworkModeVisible] = useState(false);
  const [networkModeBusy, setNetworkModeBusy] = useState(false);
  const [networkModeServerLabel, setNetworkModeServerLabel] = useState("");
  const [networkModeError, setNetworkModeError] = useState<string | null>(null);
  const networkModeResolverRef = useRef<
    ((choice: NetworkModeChoice) => void) | null
  >(null);
  const networkModePromiseRef = useRef<Promise<NetworkModeChoice> | null>(null);
  const networkModeOperationRef = useRef<Promise<void> | null>(null);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const transportOperationGenerationRef = useRef(0);
  const foregroundRecoveryRef = useRef<Promise<void> | null>(null);
  const initializationStartedRef = useRef(false);
  const initialConfigurationReadyRef = useRef<Promise<void> | null>(null);
  const lastValidationTimeRef = useRef(0);
  const validationInProgressRef = useRef(false);

  const openAuthFlow = useCallback((step: AuthStep = "server") => {
    setAuthFlowInitialStep(step);
    setAuthFlowVisible(true);
  }, []);

  const closeAuthFlow = useCallback(() => {
    setAuthFlowVisible(false);
  }, []);

  const markTransportReady = useCallback(() => {
    setTransportState("ready");
    setNetworkModeError(null);
    setTransportReadyEpoch((epoch) => epoch + 1);
    releaseServerTransportRequests();
  }, []);

  const markTransportFailed = useCallback((error: unknown) => {
    const message = getTailscaleTransportErrorMessage(error);
    // Reject requests that were waiting on the failed recovery, then immediately
    // install a new barrier so later work cannot leak to the stale port while the
    // retry/Direct chooser is open.
    failServerTransportRequests(
      error instanceof Error ? error : new Error(message),
    );
    blockServerTransportRequests();
    setTransportState("failed");
    setNetworkModeError(message);
    return message;
  }, []);

  const promptNetworkMode = useCallback(
    (
      serverLabel: string,
      initialError?: string | null,
    ): Promise<NetworkModeChoice> => {
      setNetworkModeServerLabel(serverLabel);
      setNetworkModeBusy(false);
      setNetworkModeError(initialError || null);
      setNetworkModeVisible(true);

      if (networkModePromiseRef.current) {
        return networkModePromiseRef.current;
      }

      const promise = new Promise<NetworkModeChoice>((resolve) => {
        networkModeResolverRef.current = resolve;
      });
      networkModePromiseRef.current = promise;
      return promise;
    },
    [],
  );

  const resolveNetworkModePrompt = useCallback((choice: NetworkModeChoice) => {
    const resolve = networkModeResolverRef.current;
    networkModeResolverRef.current = null;
    networkModePromiseRef.current = null;
    setNetworkModeBusy(false);
    setNetworkModeVisible(false);
    resolve?.(choice);
  }, []);

  const handleNetworkModeChoice = useCallback(
    (choice: NetworkModeChoice) => {
      if (networkModeOperationRef.current) return;

      const generation = transportOperationGenerationRef.current;
      setNetworkModeBusy(true);
      setNetworkModeError(null);

      const operation = (async () => {
        try {
          const result = await applyServerTransportMode(choice);
          const isCurrent =
            generation === transportOperationGenerationRef.current &&
            appStateRef.current === "active";

          if (!result.ok) {
            if (isCurrent) {
              markTransportFailed(new Error(result.error));
            }
            setNetworkModeBusy(false);
            return;
          }

          // A selection that finishes after backgrounding may persist its choice,
          // but it must not release the newer background barrier. Foreground
          // recovery waits for this operation and validates the final choice.
          if (isCurrent) {
            markTransportReady();
          }
          resolveNetworkModePrompt(choice);
        } catch (error) {
          const isCurrent =
            generation === transportOperationGenerationRef.current &&
            appStateRef.current === "active";
          if (isCurrent) {
            markTransportFailed(error);
          }
          setNetworkModeBusy(false);
        }
      })();

      networkModeOperationRef.current = operation;
      const clearOperation = () => {
        if (networkModeOperationRef.current === operation) {
          networkModeOperationRef.current = null;
        }
      };
      void operation.then(clearOperation, clearOperation);
    },
    [markTransportFailed, markTransportReady, resolveNetworkModePrompt],
  );

  const handleNetworkModeDismiss = useCallback(() => {
    // The close button is an explicit Direct/LAN choice; failures stay visible.
    void handleNetworkModeChoice("direct");
  }, [handleNetworkModeChoice]);

  const checkShouldShowUpdateScreen =
    useCallback(async (): Promise<boolean> => {
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

  const validatePersistedSession = useCallback(async () => {
    if (validationInProgressRef.current) return;

    const now = Date.now();
    if (now - lastValidationTimeRef.current < 2000) return;

    validationInProgressRef.current = true;
    lastValidationTimeRef.current = now;
    try {
      const userInfo = await getUserInfo();
      if (!userInfo?.username || userInfo.data_unlocked === false) {
        setAuthenticated(false);
      }
    } catch {
      // Network failures do not clear a valid persisted login. The centralized
      // API 401 callback remains authoritative for expired credentials.
    } finally {
      validationInProgressRef.current = false;
    }
  }, []);

  const recoverSelectedTransport = useCallback(
    async (generation: number) => {
      const config = getServerConfigMeta();
      const displayUrl = getDisplayServerUrl();

      if (config?.viaTailscale) {
        if (!displayUrl) {
          throw new Error("No Tailscale server address is configured.");
        }
        const recovered = await recoverTailscaleTransport(displayUrl);
        if (generation !== transportOperationGenerationRef.current)
          return false;

        await setRuntimeTransportUrl(recovered.transportUrl, {
          detect: false,
        });
        if (generation !== transportOperationGenerationRef.current)
          return false;

        await detectServerRoutes();
        if (generation !== transportOperationGenerationRef.current)
          return false;
      }

      if (
        generation !== transportOperationGenerationRef.current ||
        appStateRef.current !== "active"
      ) {
        return false;
      }
      markTransportReady();
      resolveNetworkModePrompt(config?.viaTailscale ? "tailscale" : "direct");
      return true;
    },
    [markTransportReady, resolveNetworkModePrompt],
  );

  const runForegroundRecovery = useCallback((): Promise<void> => {
    if (foregroundRecoveryRef.current) {
      return foregroundRecoveryRef.current;
    }

    const generation = ++transportOperationGenerationRef.current;
    blockServerTransportRequests();
    setTransportState("recovering");

    const recovery = (async () => {
      const initialConfigurationReady = initialConfigurationReadyRef.current;
      if (initialConfigurationReady) {
        await initialConfigurationReady;
      }

      const pendingModeOperation = networkModeOperationRef.current;
      if (pendingModeOperation) {
        await pendingModeOperation;
      }
      if (
        generation !== transportOperationGenerationRef.current ||
        appStateRef.current !== "active"
      ) {
        return;
      }

      try {
        const ready = await recoverSelectedTransport(generation);
        if (!ready || generation !== transportOperationGenerationRef.current) {
          return;
        }
      } catch (error) {
        if (generation !== transportOperationGenerationRef.current) return;
        const displayUrl = getDisplayServerUrl();
        const message = markTransportFailed(error);
        if (!displayUrl) return;
        await promptNetworkMode(displayUrl, message);
      }

      if (
        generation === transportOperationGenerationRef.current &&
        appStateRef.current === "active"
      ) {
        setIsLoading(false);
        if (isAuthenticated) {
          await validatePersistedSession();
        }
      }
    })();

    foregroundRecoveryRef.current = recovery;
    const clearRecovery = () => {
      if (foregroundRecoveryRef.current === recovery) {
        foregroundRecoveryRef.current = null;
      }
    };
    void recovery.then(clearRecovery, clearRecovery);
    return recovery;
  }, [
    isAuthenticated,
    markTransportFailed,
    promptNetworkMode,
    recoverSelectedTransport,
    validatePersistedSession,
  ]);

  useEffect(() => {
    if (initializationStartedRef.current) return;
    initializationStartedRef.current = true;

    const initializeApp = async () => {
      const generation = ++transportOperationGenerationRef.current;
      const canPublishTransport = () =>
        generation === transportOperationGenerationRef.current &&
        appStateRef.current === "active";
      let resolveInitialConfiguration!: () => void;
      initialConfigurationReadyRef.current = new Promise<void>((resolve) => {
        resolveInitialConfiguration = resolve;
      });

      blockServerTransportRequests();
      setTransportState("recovering");
      try {
        setIsLoading(true);
        try {
          await initializeServerConfig({
            rehydrateTailscale: false,
            detect: false,
          });
        } finally {
          // Foreground recovery may have started while storage was loading. It
          // must not inspect transport metadata until this initial read settles.
          resolveInitialConfiguration();
        }

        const serverConfig = await AsyncStorage.getItem("serverConfig");
        const legacyServer = await AsyncStorage.getItem("server");
        const serverConfigured = !!(serverConfig || legacyServer);
        setHasServerConfigured(serverConfigured);
        setSelectedServer(
          serverConfigured
            ? {
                name: "Server",
                ip: getDisplayServerUrl() || getCurrentServerUrl() || "Server",
              }
            : null,
        );

        if (serverConfigured) {
          const displayUrl = getDisplayServerUrl() || getCurrentServerUrl();
          const config = getServerConfigMeta();
          const tsConfigured = await isTailscaleConfigured();
          let transportCommitted = false;

          if (displayUrl && config?.viaTailscale) {
            const live = await getLiveTransportUrl(displayUrl);
            if (live && canPublishTransport()) {
              await setRuntimeTransportUrl(live, { detect: false });
              if (canPublishTransport()) {
                await detectServerRoutes();
              }
              if (canPublishTransport()) {
                markTransportReady();
                resolveNetworkModePrompt("tailscale");
                transportCommitted = true;
              }
            }
          }

          if (
            !transportCommitted &&
            displayUrl &&
            (tsConfigured || config?.viaTailscale) &&
            canPublishTransport()
          ) {
            // Keep the route tree behind the loading screen. The provider-level
            // Modal remains visible and resolves only after a transport succeeds.
            await promptNetworkMode(displayUrl);
            transportCommitted = canPublishTransport();
          }

          if (!transportCommitted && canPublishTransport()) {
            await detectServerRoutes();
            if (canPublishTransport()) {
              markTransportReady();
              transportCommitted = true;
            }
          }

          const jwtToken = await AsyncStorage.getItem("jwt");
          if (jwtToken) {
            const validationPromise = getUserInfo();
            const validationResult = await Promise.race([
              validationPromise.then(
                (user) => ({ type: "user" as const, user }),
                (error) => ({ type: "error" as const, error }),
              ),
              new Promise<{ type: "timeout" }>((resolve) => {
                setTimeout(() => resolve({ type: "timeout" }), 1500);
              }),
            ]);

            if (validationResult.type === "user") {
              setAuthenticated(
                !!(
                  validationResult.user?.username &&
                  validationResult.user.data_unlocked !== false
                ),
              );
            } else if (
              validationResult.type === "error" &&
              isUnauthorizedError(validationResult.error)
            ) {
              clearCachedUserId();
              await clearAuth();
              setAuthenticated(false);
            } else {
              setAuthenticated(true);
              if (validationResult.type === "timeout") {
                void validationPromise
                  .then((user) => {
                    setAuthenticated(
                      !!(user?.username && user.data_unlocked !== false),
                    );
                  })
                  .catch(async (error) => {
                    if (isUnauthorizedError(error)) {
                      clearCachedUserId();
                      await clearAuth();
                      setAuthenticated(false);
                    }
                  });
              }
            }
          } else {
            setAuthenticated(false);
          }

          void getVersionInfo().catch((error) => {
            console.warn("[AppContext] Version check failed:", error);
          });
        } else {
          if (canPublishTransport()) {
            markTransportReady();
          }
          setAuthenticated(false);
          openAuthFlow("server");
        }

        void checkShouldShowUpdateScreen().then(setShowUpdateScreen);
      } catch (error) {
        const displayUrl = getDisplayServerUrl() || getCurrentServerUrl();
        setHasServerConfigured(!!displayUrl);
        setSelectedServer(
          displayUrl ? { name: "Server", ip: displayUrl } : null,
        );
        setAuthenticated(false);

        if (canPublishTransport()) {
          if (displayUrl) {
            const message = markTransportFailed(error);
            await promptNetworkMode(displayUrl, message);
          } else {
            markTransportReady();
            openAuthFlow("server");
          }
        }
        console.error("[AppContext] Failed to initialize app:", error);
      } finally {
        if (canPublishTransport()) {
          setIsLoading(false);
        }
      }
    };

    void initializeApp();
  }, [
    checkShouldShowUpdateScreen,
    markTransportFailed,
    markTransportReady,
    openAuthFlow,
    promptNetworkMode,
    resolveNetworkModePrompt,
  ]);

  useEffect(() => {
    setAuthStateCallback((authed: boolean) => {
      if (!authed) {
        setAuthenticated(false);
        clearCachedUserId();
        void clearAuth();
      }
    });
  }, []);

  useEffect(() => {
    const handleAppStateChange = (nextAppState: AppStateStatus) => {
      appStateRef.current = nextAppState;

      if (nextAppState !== "active") {
        transportOperationGenerationRef.current += 1;
        foregroundRecoveryRef.current = null;
        blockServerTransportRequests();
        setTransportState("recovering");
        return;
      }

      void runForegroundRecovery();
    };

    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange,
    );
    return () => subscription.remove();
  }, [runForegroundRecovery]);

  // Keep hasServerConfigured in sync whenever the auth flow closes (the user
  // may have just added or changed a server inside it).
  useEffect(() => {
    if (!authFlowVisible) {
      setHasServerConfigured(!!getCurrentServerUrl());
    }
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
        serverLabel={networkModeServerLabel}
        errorMessage={networkModeError}
        onChoose={(mode) => {
          void handleNetworkModeChoice(mode);
        }}
        onDismiss={handleNetworkModeDismiss}
      />
    </AppContext.Provider>
  );
};
