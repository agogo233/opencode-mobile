import { useEffect, useRef } from "react"
import { Stack, router } from "expo-router"
import { StatusBar } from "expo-status-bar"
import { useColorScheme, View, Text, ActivityIndicator, AppState, StyleSheet } from "react-native"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { GestureHandlerRootView } from "react-native-gesture-handler"
import { BottomSheetModalProvider } from "@gorhom/bottom-sheet"
import { I18nextProvider, useTranslation } from "react-i18next"
import { KeyboardProvider } from "react-native-keyboard-controller"
import i18n from "../src/lib/i18n/config"
import { useAuth } from "../src/stores/auth"
import { useConnections } from "../src/stores/connections"
import { useEvents } from "../src/stores/events"
import { useCatalog } from "../src/stores/catalog"
import { useSettings } from "../src/stores/settings"
import { useTailscale } from "../src/stores/tailscale"
import { AuthGate } from "../src/components/AuthGate"
import { ErrorBoundary } from "../src/components/ErrorBoundary"
import * as notifications from "../src/lib/notifications"

const queryClient = new QueryClient()

// Global indicator shown while the active tailscale connection waits for the
// embedded node and its loopback forward to come up. Renders on every screen
// so a slow/unreachable tailnet never looks like a frozen app.
function TailscaleConnectingBanner() {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const { t } = useTranslation()
  const tailscaleConnecting = useConnections((s) => s.tailscaleConnecting)
  if (!tailscaleConnecting) return null
  return (
    <View style={[styles.tsBanner, isDark && styles.tsBannerDark]}>
      <ActivityIndicator size="small" color={isDark ? "#ffffff" : "#0a0a0a"} />
      <Text style={[styles.tsBannerText, isDark && styles.tsBannerTextDark]}>
        {t("connectionsList.tailscaleConnecting")}
      </Text>
    </View>
  )
}

function RootLayout() {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const { t } = useTranslation()

  const { initialize: initAuth, isLoading: authLoading } = useAuth()
  const { loadConnections, isLoading: connectionsLoading, client } = useConnections()
  const sseStarted = useRef(false)
  const notifPermissionRequested = useRef(false)

  useEffect(() => {
    initAuth()
    loadConnections()
    useSettings.getState().load()
    useTailscale.getState().loadConfig()

    // Connect notification preferences to the notification module
    notifications.configure(() => useSettings.getState().notifications)

    // Navigate to session when user taps a notification. Connection-drop
    // notifications carry no sessionId (they aren't about a session) — route
    // to the home tab instead of "/session/" (an empty, dead-end route).
    const unsubNotifications = notifications.onTap((data) => {
      if (data.sessionId) router.push(`/session/${data.sessionId}`)
      else router.push("/")
    })

    return unsubNotifications
  }, [])

  // Re-arm the biometric app-lock when the app leaves the foreground. Without
  // this, "Require Biometric to Open" is bypassable: authenticate() sets
  // isAuthenticated=true once at cold start and nothing ever resets it, so the
  // app stays unlocked for the whole JS-process lifetime — anyone with brief
  // physical access can reopen a backgrounded app straight into session
  // history and connection details. lock() flips isAuthenticated back to false
  // so AuthGate shows the lock screen (and re-prompts) on next foreground.
  // Fire on "background" only (not the transient "inactive" that the biometric
  // prompt / app switcher / control center produce) to avoid spurious re-locks.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "background" && useAuth.getState().settings.requireBiometric) {
        useAuth.getState().lock()
      }
    })
    return () => sub.remove()
  }, [])

  // Android freezes JS timers and usually drops the SSE socket while the app
  // sits in the background (Doze/app standby), and the server may close idle
  // streams too. On return to foreground, re-establish the stream immediately
  // instead of waiting out the reconnect backoff (whose timers were frozen),
  // and resync messages/permissions missed while away. reconnectNow() is
  // idempotent, so an "active" fired by a transient "inactive" (biometric
  // prompt, app switcher) is harmless.
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && sseStarted.current) {
        useEvents.getState().reconnectNow()
        // The embedded node may have been torn down while backgrounded; pull
        // a fresh status so the disconnected banner reflects reality. Note
        // the Go side caches its phase, so this catches store/node state
        // divergence, not silent tailnet drops.
        useTailscale.getState().refresh()
      }
    })
    return () => sub.remove()
  }, [])

  // Connect/disconnect SSE and load catalog when client changes
  useEffect(() => {
    if (client && !sseStarted.current) {
      sseStarted.current = true
      useEvents.getState().connect()
      useCatalog.getState().load()
      // Request OS notification permission once we have a live connection —
      // the in-context moment the user will start running agent tasks they'll
      // want to be pinged about. Previously this was only ever requested when
      // a user manually toggled a notification switch off→on in Settings; since
      // most categories default on, that path never fired for typical users
      // and send() silently no-op'd on every notification (permission stayed
      // "undetermined"). setup() is idempotent — it won't re-prompt once the
      // OS has a decision — so the ref just avoids redundant calls per session.
      if (!notifPermissionRequested.current) {
        notifPermissionRequested.current = true
        void notifications.setup()
      }
    } else if (!client && sseStarted.current) {
      sseStarted.current = false
      useEvents.getState().disconnect()
    }
    return () => {
      if (sseStarted.current) {
        sseStarted.current = false
        useEvents.getState().disconnect()
      }
    }
  }, [client])

  const isLoading = authLoading || connectionsLoading

  if (isLoading) {
    return (
      <View
        style={{
          flex: 1,
          justifyContent: "center",
          alignItems: "center",
          backgroundColor: isDark ? "#0a0a0a" : "#ffffff",
        }}
      >
        <ActivityIndicator size="large" color={isDark ? "#ffffff" : "#0a0a0a"} />
      </View>
    )
  }

  return (
    <ErrorBoundary>
      <I18nextProvider i18n={i18n}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <KeyboardProvider>
        <BottomSheetModalProvider>
          <QueryClientProvider client={queryClient}>
            <AuthGate>
            <View style={styles.flex}>
              <TailscaleConnectingBanner />
              <Stack
                screenOptions={{
                  headerStyle: {
                    backgroundColor: isDark ? "#0a0a0a" : "#ffffff",
                  },
                  headerTintColor: isDark ? "#ffffff" : "#0a0a0a",
                  contentStyle: {
                    backgroundColor: isDark ? "#0a0a0a" : "#ffffff",
                  },
                }}
              >
                <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
                <Stack.Screen
                  name="session/[id]"
                  options={{
                    title: t("session.titleFallback"),
                    presentation: "card",
                  }}
                />
                <Stack.Screen
                  name="connection/add"
                  options={{
                    title: t("nav.addConnectionTitle"),
                    presentation: "modal",
                  }}
                />
                <Stack.Screen
                  name="connection/[id]"
                  options={{
                    title: t("nav.editConnectionTitle"),
                    presentation: "modal",
                  }}
                />
                <Stack.Screen name="file-browser" options={{ title: t("fileBrowser.title") }} />
                <Stack.Screen name="file-preview" options={{ title: t("filePreview.title") }} />
                <Stack.Screen name="settings/tailscale" options={{ title: t("settings.tailscale.page.title") }} />
              </Stack>
            </View>
              <StatusBar style={isDark ? "light" : "dark"} />
            </AuthGate>
          </QueryClientProvider>
        </BottomSheetModalProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
      </I18nextProvider>
    </ErrorBoundary>
  )
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  tsBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 8,
    paddingHorizontal: 16,
    backgroundColor: "#fffbeb",
    borderBottomWidth: 1,
    borderBottomColor: "#fde68a",
  },
  tsBannerDark: {
    backgroundColor: "#2a2110",
    borderBottomColor: "#4a3b15",
  },
  tsBannerText: {
    fontSize: 13,
    color: "#92400e",
    flex: 1,
  },
  tsBannerTextDark: {
    color: "#fbbf24",
  },
})

export default RootLayout
