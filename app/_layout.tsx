import { Stack } from "expo-router";
import { AppProvider, useAppContext } from "./AppContext";
import { TerminalSessionsProvider } from "./contexts/TerminalSessionsContext";
import { TerminalCustomizationProvider } from "./contexts/TerminalCustomizationContext";
import { KeyboardProvider } from "./contexts/KeyboardContext";
import { KeyboardCustomizationProvider } from "./contexts/KeyboardCustomizationContext";
import {
  ThemeProvider,
  useTheme,
  useThemeColor,
} from "./contexts/ThemeContext";
import { AppLockProvider, useAppLock } from "./contexts/AppLockContext";
import { LockScreen } from "@/app/components/LockScreen";
import AuthFlow from "@/app/authentication/AuthFlow";
import { View, Text, ActivityIndicator, TouchableOpacity } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Toaster } from "sonner-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useFonts } from "expo-font";
import { FONT_MAP, MONO_FONT, MONO_FONT_BOLD } from "./constants/fonts";
import "../global.css";
import UpdateRequired from "@/app/authentication/UpdateRequired";

function RootLayoutContent() {
  const {
    authFlowVisible,
    showUpdateScreen,
    isLoading,
    transportState,
    transportError,
    retryTransport,
    cancelTransportRecovery,
    changeServer,
  } = useAppContext();
  const accent = useThemeColor()("accent-brand");

  if ((isLoading || transportState !== "ready") && authFlowVisible) {
    return <AuthFlow />;
  }

  if (isLoading || transportState !== "ready") {
    const failed = transportState === "failed";
    return (
      <View className="flex-1 items-center justify-center bg-background px-8">
        {!failed ? <ActivityIndicator size="large" color={accent} /> : null}
        <Text
          className={`${failed ? "" : "mt-4"} text-center text-base text-foreground`}
          style={{ fontFamily: MONO_FONT }}
        >
          {failed ? "Connection unavailable" : "Initializing…"}
        </Text>
        {transportError ? (
          <Text
            className="mt-3 max-w-md text-center text-xs leading-5 text-muted-foreground"
            style={{ fontFamily: MONO_FONT }}
          >
            {transportError}
          </Text>
        ) : null}
        <View className="mt-6 w-full max-w-xs gap-2.5">
          {failed ? (
            <TouchableOpacity
              onPress={retryTransport}
              className="items-center border border-accent-brand/40 bg-accent-brand/10 px-6 py-3"
            >
              <Text
                className="text-accent-brand"
                style={{ fontFamily: MONO_FONT_BOLD }}
              >
                Retry
              </Text>
            </TouchableOpacity>
          ) : (
            <TouchableOpacity
              onPress={cancelTransportRecovery}
              className="items-center border border-border bg-card px-6 py-3"
            >
              <Text
                className="text-foreground"
                style={{ fontFamily: MONO_FONT_BOLD }}
              >
                Cancel attempt
              </Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity
            onPress={changeServer}
            className="items-center border border-border bg-card px-6 py-3"
          >
            <Text
              className="text-foreground"
              style={{ fontFamily: MONO_FONT_BOLD }}
            >
              Change server
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (showUpdateScreen) return <UpdateRequired />;

  // The tab shell always renders once loaded. When the user isn't connected,
  // the tabs themselves show a "no server connected" empty state. The auth flow
  // is layered on top as a dismissible full-screen overlay.
  return (
    <View className="flex-1 bg-background">
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      </Stack>
      <AppLockGate />
      {authFlowVisible ? (
        <View className="absolute inset-0 bg-background">
          <AuthFlow />
        </View>
      ) : null}
    </View>
  );
}

function AppLockGate() {
  const { enabled, locked } = useAppLock();
  if (!enabled || !locked) return null;
  return <LockScreen />;
}

function ThemedToaster() {
  const { isDark } = useTheme();
  const card = useThemeColor()("card");
  const border = useThemeColor()("border");
  return (
    <Toaster
      theme={isDark ? "dark" : "light"}
      position="top-center"
      toastOptions={{
        style: {
          backgroundColor: card,
          borderWidth: 1,
          borderColor: border,
          borderRadius: 0,
        },
      }}
      richColors={false}
      closeButton
      duration={4000}
    />
  );
}

function ThemedStatusBar() {
  const { isDark } = useTheme();
  return <StatusBar style={isDark ? "light" : "dark"} />;
}

export default function RootLayout() {
  const [fontsLoaded] = useFonts(FONT_MAP);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ThemedStatusBar />
          {!fontsLoaded ? (
            <View className="flex-1 bg-background" />
          ) : (
            <AppLockProvider>
              <AppProvider>
                <TerminalSessionsProvider>
                  <TerminalCustomizationProvider>
                    <KeyboardProvider>
                      <KeyboardCustomizationProvider>
                        <RootLayoutContent />
                        <ThemedToaster />
                      </KeyboardCustomizationProvider>
                    </KeyboardProvider>
                  </TerminalCustomizationProvider>
                </TerminalSessionsProvider>
              </AppProvider>
            </AppLockProvider>
          )}
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
