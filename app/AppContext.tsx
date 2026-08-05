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
  getVersionInfo,
  initializeServerConfig,
  applyServerTransportMode,
  getLatestGitHubRelease,
  setAuthStateCallback,
  getCurrentServerUrl,
  getDisplayServerUrl,
  getUserInfo,
  clearAuth,
  isUnauthorizedError,
} from "./main-axios";
import {
  isTailscaleConfigured,
  getLiveTransportUrl,
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

  const [authFlowVisible, setAuthFlowVisible] = useState(false);
  const [authFlowInitialStep, setAuthFlowInitialStep] =
    useState<AuthStep>("server");
  const [networkModeVisible, setNetworkModeVisible] = useState(false);
  const [networkModeBusy, setNetworkModeBusy] = useState(false);
  const [networkModeServerLabel, setNetworkModeServerLabel] = useState("");
  const networkModeResolverRef = useRef<
    ((choice: NetworkModeChoice | null) => void) | null
  >(null);

  const openAuthFlow = useCallback((step: AuthStep = "server") => {
    setAuthFlowInitialStep(step);
    setAuthFlowVisible(true);
  }, []);

  const closeAuthFlow = useCallback(() => {
    setAuthFlowVisible(false);
  }, []);

  const promptNetworkMode = useCallback(
    (serverLabel: string): Promise<NetworkModeChoice | null> => {
      setNetworkModeServerLabel(serverLabel);
      setNetworkModeBusy(false);
      setNetworkModeVisible(true);
      return new Promise((resolve) => {
        networkModeResolverRef.current = resolve;
      });
    },
    [],
  );

  const handleNetworkModeChoice = useCallback(
    async (choice: NetworkModeChoice) => {
      setNetworkModeBusy(true);
      try {
        const ok = await applyServerTransportMode(choice);
        if (!ok && choice === "tailscale") {
          // Fall back to direct so the user can still try LAN.
          await applyServerTransportMode("direct");
        }
        networkModeResolverRef.current?.(choice);
      } finally {
        networkModeResolverRef.current = null;
        setNetworkModeBusy(false);
        setNetworkModeVisible(false);
      }
    },
    [],
  );

  const handleNetworkModeDismiss = useCallback(() => {
    // Dismiss = prefer direct for this session.
    void handleNetworkModeChoice("direct");
  }, [handleNetworkModeChoice]);

  const checkShouldShowUpdateScreen = async (): Promise<boolean> => {
    try {
      const currentAppVersion = Constants.expoConfig?.version || "1.0.0";

      const latestRelease = await getLatestGitHubRelease();

      if (!latestRelease) {
        return false;
      }

      if (currentAppVersion === latestRelease.version) {
        return false;
      }

      const dismissedVersion = await AsyncStorage.getItem(
        "dismissedUpdateVersion",
      );

      if (dismissedVersion === latestRelease.version) {
        return false;
      }

      return true;
    } catch (error) {
      return false;
    }
  };

  useEffect(() => {
    const initializeApp = async () => {
      try {
        setIsLoading(true);

        // Load config WITHOUT network probes (stored LAN URL is unreachable on
        // cellular) and WITHOUT auto-joining Tailscale — we prompt first.
        await initializeServerConfig({
          rehydrateTailscale: false,
          detect: false,
        });

        const serverConfig = await AsyncStorage.getItem("serverConfig");
        const legacyServer = await AsyncStorage.getItem("server");

        const serverConfigured = !!(serverConfig || legacyServer);
        setHasServerConfigured(serverConfigured);
        setSelectedServer(
          serverConfig || legacyServer
            ? {
                name: "Server",
                ip: getDisplayServerUrl() || getCurrentServerUrl() || "Server",
              }
            : null,
        );

        if (serverConfigured) {
          let displayUrl = getDisplayServerUrl() || getCurrentServerUrl();
          if (!displayUrl && serverConfig) {
            try {
              const parsed = JSON.parse(serverConfig) as {
                displayUrl?: string;
                serverUrl?: string;
              };
              displayUrl = parsed.displayUrl || parsed.serverUrl || null;
            } catch {
              displayUrl = null;
            }
          }

          // If a Tailscale auth key is saved and no live forward exists, ask
          // whether this session should use Tailscale or direct/LAN.
          // This MUST happen before any network calls (getVersionInfo etc.) so
          // cellular users are not blocked by a 30s timeout to an unreachable LAN IP.
          const tsConfigured = await isTailscaleConfigured();
          const live =
            displayUrl && tsConfigured
              ? getLiveTransportUrl(displayUrl)
              : null;
          if (tsConfigured && displayUrl && !live) {
            setIsLoading(false);
            await promptNetworkMode(displayUrl);
            // Choice handler already applied transport mode + re-detected.
            setIsLoading(true);
          }

          // Restore persisted login WITHOUT letting a slow/offline server
          // destroy the session. The Tailscale chooser above happens first so
          // the transport is correct before we validate the JWT.
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
              // A slow/offline server must not destroy the persisted session.
              // If the request is still running, apply its eventual authoritative
              // response after the app has opened.
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

          // Server/version availability must not delay or determine whether
          // local state can be restored on launch.
          void getVersionInfo().catch((error) => {
            console.warn("[AppContext] Version check failed:", error);
          });
        } else {
          // Brand-new install: guide the user, but the flow is dismissible.
          setAuthenticated(false);
          openAuthFlow("server");
        }

        void checkShouldShowUpdateScreen().then(setShowUpdateScreen);
      } catch (error) {
        const serverUrl = getCurrentServerUrl();
        setHasServerConfigured(!!serverUrl);
        setSelectedServer(serverUrl ? { name: "Server", ip: serverUrl } : null);
        setAuthenticated(false);
        if (!serverUrl) {
          openAuthFlow("server");
        }
        console.error("[AppContext] Failed to initialize app:", error);
      } finally {
        setIsLoading(false);
      }
    };

    initializeApp();
  }, [openAuthFlow, promptNetworkMode]);

  useEffect(() => {
    setAuthStateCallback((authed: boolean) => {
      if (!authed) {
        // Critical API 401: clear only the invalid JWT. The configured server
        // remains available so the user sees "Sign in", not "Add server".
        setAuthenticated(false);
        clearCachedUserId();
        void clearAuth();
      }
    });
  }, []);

  const lastValidationTimeRef = useRef<number>(0);
  const validationInProgressRef = useRef<boolean>(false);

  useEffect(() => {
    const handleAppStateChange = async (nextAppState: AppStateStatus) => {
      if (
        nextAppState === "active" &&
        isAuthenticated &&
        !validationInProgressRef.current
      ) {
        const now = Date.now();
        const timeSinceLastValidation = now - lastValidationTimeRef.current;

        if (timeSinceLastValidation < 2000) {
          return;
        }

        validationInProgressRef.current = true;
        lastValidationTimeRef.current = now;

        try {
          const userInfo = await getUserInfo();

          if (
            !userInfo ||
            !userInfo.username ||
            userInfo.data_unlocked === false
          ) {
            setAuthenticated(false);
          }
        } catch (error) {
          // Network blips shouldn't log the user out; the 401 callback handles
          // genuine auth failures.
        } finally {
          validationInProgressRef.current = false;
        }
      }
    };

    const subscription = AppState.addEventListener(
      "change",
      handleAppStateChange,
    );

    return () => {
      subscription.remove();
    };
  }, [isAuthenticated]);

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
        onChoose={(mode) => {
          void handleNetworkModeChoice(mode);
        }}
        onDismiss={handleNetworkModeDismiss}
      />
    </AppContext.Provider>
  );
};
