import { useEffect, useState } from "react"
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  useColorScheme,
  Platform,
  Alert,
  Linking,
} from "react-native"
import { KeyboardAvoidingView } from "react-native-keyboard-controller"
import { Ionicons } from "@expo/vector-icons"
import { useTranslation } from "react-i18next"
import * as Clipboard from "expo-clipboard"
import { useTailscale } from "../../src/stores/tailscale"
import { tailscaleNative } from "../../src/lib/tailscale"
import { isInsecureControlUrl } from "../../src/lib/control-url"

const PHASE_COLORS: Record<string, string> = {
  connected: "#22c55e",
  connecting: "#3b82f6",
  error: "#ef4444",
}

export default function TailscaleSettingsScreen() {
  const colorScheme = useColorScheme()
  const isDark = colorScheme === "dark"
  const { t } = useTranslation()

  const { phase, ipv4, ipv6, error, loginUrl, controlUrl, authKey, deviceName, busy, loadConfig, saveConfig, start, stop, refresh } =
    useTailscale()

  const [controlUrlInput, setControlUrlInput] = useState("")
  const [authKeyInput, setAuthKeyInput] = useState("")
  const [hostnameInput, setHostnameInput] = useState("")
  const [showKey, setShowKey] = useState(false)
  const [hydrated, setHydrated] = useState(false)
  const [copied, setCopied] = useState(false)
  const [loginCopied, setLoginCopied] = useState(false)

  useEffect(() => {
    loadConfig()
  }, [])

  // Hydrate the fields from the persisted config exactly once, so typing
  // doesn't fight the store.
  useEffect(() => {
    if (hydrated || !useTailscale.getState().configLoaded) return
    setControlUrlInput(controlUrl)
    setAuthKeyInput(authKey)
    setHostnameInput(deviceName)
    setHydrated(true)
  }, [controlUrl, authKey, deviceName, hydrated])

  // Cheap status poll while the page is open (the Go side has no event bus).
  useEffect(() => {
    const id = setInterval(() => {
      refresh()
    }, 3000)
    return () => clearInterval(id)
  }, [])

  // The control URL is optional: an empty value targets the official
  // Tailscale coordination server. The auth key is optional too: leave it
  // empty to approve the node interactively in the control server's web UI.
  const configured = authKeyInput.trim() !== "" || controlUrlInput.trim() !== ""
  const connected = phase === "connected"
  const dotColor = PHASE_COLORS[phase] ?? (isDark ? "#666666" : "#999999")

  const confirmInsecureControl = () =>
    new Promise<boolean>((resolve) => {
      Alert.alert(
        t("settings.tailscale.page.insecureControlTitle"),
        t("settings.tailscale.page.insecureControlMessage"),
        [
          { text: t("common.cancel"), style: "cancel", onPress: () => resolve(false) },
          { text: t("common.ok"), onPress: () => resolve(true) },
        ],
      )
    })

  const handleToggle = async () => {
    if (connected) {
      await stop()
      return
    }
    if (!configured) {
      Alert.alert(t("settings.tailscale.page.notConfiguredTitle"), t("settings.tailscale.page.notConfigured"))
      return
    }
    if (isInsecureControlUrl(controlUrlInput) && !(await confirmInsecureControl())) return
    await saveConfig({ controlUrl: controlUrlInput, authKey: authKeyInput, hostname: hostnameInput })
    await start()
  }

  const copyAddress = async () => {
    const value = ipv4 || ipv6
    if (!value) return
    try {
      await Clipboard.setStringAsync(value)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      // clipboard optional
    }
  }

  const copyLoginUrl = async () => {
    if (!loginUrl) return
    try {
      await Clipboard.setStringAsync(loginUrl)
      setLoginCopied(true)
      setTimeout(() => setLoginCopied(false), 1500)
    } catch {
      // clipboard optional
    }
  }

  const buttonLabel = busy
    ? connected
      ? t("settings.tailscale.page.stopping")
      : t("settings.tailscale.page.starting")
    : connected
      ? t("settings.tailscale.page.stop")
      : phase === "error"
        ? t("settings.tailscale.page.retry")
        : t("settings.tailscale.page.start")

  return (
    <KeyboardAvoidingView
      style={[styles.container, isDark && styles.containerDark]}
      behavior="padding"
      automaticOffset={Platform.OS === "android"}
      keyboardVerticalOffset={Platform.OS === "ios" ? 90 : 0}
    >
      <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
        {/* Status */}
        <Text style={[styles.sectionTitle, isDark && styles.textDark]}>{t("settings.tailscale.page.statusTitle")}</Text>
        <View style={[styles.card, isDark && styles.cardDark]}>
          <View style={styles.statusRow}>
            <View style={[styles.dot, { backgroundColor: dotColor }]} />
            <Text style={[styles.statusText, isDark && styles.textDark]}>
              {tailscaleNative()
                ? t(`settings.tailscale.page.phase.${phase}`)
                : t("settings.tailscale.page.unavailable")}
            </Text>
          </View>
          {(ipv4 || ipv6) && (
            <View style={styles.addressRow}>
              <Text style={[styles.addressLabel, isDark && styles.metaDark]}>
                {t("settings.tailscale.page.localAddress")}
              </Text>
              <Text style={[styles.addressValue, isDark && styles.textDark]}>{ipv4 || ipv6}</Text>
              <TouchableOpacity onPress={copyAddress} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
                <Text style={styles.copyText}>
                  {copied ? t("settings.tailscale.page.copied") : t("settings.tailscale.page.copy")}
                </Text>
              </TouchableOpacity>
            </View>
          )}
          {hostnameInput.trim() !== "" && (
            <View style={styles.addressRow}>
              <Text style={[styles.addressLabel, isDark && styles.metaDark]}>
                {t("settings.tailscale.page.deviceName")}
              </Text>
              <Text style={[styles.addressValue, isDark && styles.textDark]}>{hostnameInput}</Text>
            </View>
          )}
          {error !== "" && <Text style={styles.errorText}>{error}</Text>}
        </View>

        {/* Pending keyless enrollment: surface the approval link */}
        {phase === "connecting" && loginUrl !== "" && (
          <View style={[styles.card, styles.loginCard, isDark && styles.cardDark]}>
            <Text style={[styles.label, isDark && styles.labelDark]}>
              {t("settings.tailscale.page.loginPendingTitle")}
            </Text>
            <Text style={[styles.hint, isDark && styles.hintDark]}>
              {t("settings.tailscale.page.loginPendingHint")}
            </Text>
            <Text style={[styles.loginUrl, isDark && styles.textDark]} numberOfLines={1} ellipsizeMode="middle">
              {loginUrl}
            </Text>
            <View style={styles.loginActions}>
              <TouchableOpacity
                style={styles.loginButton}
                onPress={() => {
                  Linking.openURL(loginUrl).catch(() => {})
                }}
              >
                <Text style={styles.loginButtonText}>{t("settings.tailscale.page.loginOpen")}</Text>
              </TouchableOpacity>
              <TouchableOpacity style={[styles.loginButton, styles.loginButtonSecondary]} onPress={copyLoginUrl}>
                <Text style={[styles.loginButtonText, styles.loginButtonTextSecondary, isDark && styles.textDark]}>
                  {loginCopied ? t("settings.tailscale.page.copied") : t("settings.tailscale.page.loginCopy")}
                </Text>
              </TouchableOpacity>
            </View>
          </View>
        )}

        {/* Identity */}
        <Text style={[styles.sectionTitle, isDark && styles.textDark]}>{t("settings.tailscale.page.identityTitle")}</Text>
        <View style={[styles.card, isDark && styles.cardDark]}>
          <Text style={[styles.label, isDark && styles.labelDark]}>
            {t("settings.tailscale.page.controlUrl")}
          </Text>
          <TextInput
            style={[styles.input, isDark && styles.inputDark]}
            placeholder="https://headscale.example.com"
            placeholderTextColor={isDark ? "#666666" : "#999999"}
            value={controlUrlInput}
            onChangeText={setControlUrlInput}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
          <Text style={[styles.hint, isDark && styles.hintDark]}>{t("settings.tailscale.page.controlUrlHint")}</Text>

          <Text style={[styles.label, isDark && styles.labelDark]}>{t("settings.tailscale.page.authKey")}</Text>
          <View style={styles.keyRow}>
            <TextInput
              style={[styles.input, styles.keyInput, isDark && styles.inputDark]}
              placeholder="tskey-auth-..."
              placeholderTextColor={isDark ? "#666666" : "#999999"}
              value={authKeyInput}
              onChangeText={setAuthKeyInput}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!showKey}
            />
            <TouchableOpacity onPress={() => setShowKey(!showKey)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
              <Ionicons name={showKey ? "eye-off" : "eye"} size={20} color={isDark ? "#888888" : "#666666"} />
            </TouchableOpacity>
          </View>
          <Text style={[styles.hint, isDark && styles.hintDark]}>{t("settings.tailscale.page.authKeyHint")}</Text>

          <Text style={[styles.label, isDark && styles.labelDark]}>{t("settings.tailscale.page.hostnameLabel")}</Text>
          <TextInput
            style={[styles.input, isDark && styles.inputDark]}
            placeholder="opencode-phone"
            placeholderTextColor={isDark ? "#666666" : "#999999"}
            value={hostnameInput}
            onChangeText={setHostnameInput}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <Text style={[styles.hint, isDark && styles.hintDark]}>{t("settings.tailscale.page.hostnameHint")}</Text>
        </View>

        {/* Primary action */}
        <TouchableOpacity
          style={[styles.actionButton, isDark && styles.actionButtonDark, connected && styles.actionButtonStop]}
          onPress={handleToggle}
          disabled={busy}
        >
          <Text
            style={[
              styles.actionButtonText,
              isDark && styles.actionButtonTextDark,
              connected && styles.actionButtonTextStop,
            ]}
          >
            {buttonLabel}
          </Text>
        </TouchableOpacity>

        <Text style={[styles.help, isDark && styles.hintDark]}>{t("settings.tailscale.page.help")}</Text>
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#ffffff",
  },
  containerDark: {
    backgroundColor: "#0a0a0a",
  },
  content: {
    padding: 16,
    paddingBottom: 32,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: "600",
    color: "#666666",
    textTransform: "uppercase",
    marginTop: 16,
    marginBottom: 8,
  },
  card: {
    backgroundColor: "#f5f5f5",
    borderRadius: 12,
    padding: 16,
    gap: 10,
  },
  cardDark: {
    backgroundColor: "#1a1a1a",
  },
  statusRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
  },
  statusText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#0a0a0a",
  },
  addressRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  addressLabel: {
    fontSize: 13,
    color: "#666666",
    width: 90,
  },
  addressValue: {
    fontSize: 14,
    color: "#0a0a0a",
    flex: 1,
  },
  copyText: {
    fontSize: 13,
    color: "#6366f1",
    fontWeight: "600",
  },
  errorText: {
    fontSize: 13,
    color: "#ef4444",
  },
  loginCard: {
    borderWidth: 1,
    borderColor: "#3b82f6",
  },
  loginUrl: {
    fontSize: 12,
    color: "#0a0a0a",
    fontFamily: "monospace",
  },
  loginActions: {
    flexDirection: "row",
    gap: 8,
  },
  loginButton: {
    flex: 1,
    alignItems: "center",
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderRadius: 8,
    backgroundColor: "#3b82f6",
  },
  loginButtonSecondary: {
    backgroundColor: "#e0e7ff",
  },
  loginButtonText: {
    fontSize: 13,
    fontWeight: "600",
    color: "#ffffff",
  },
  loginButtonTextSecondary: {
    color: "#1e40af",
  },
  label: {
    fontSize: 14,
    fontWeight: "600",
    color: "#0a0a0a",
    marginTop: 4,
    marginBottom: 6,
  },
  labelDark: {
    color: "#ffffff",
  },
  input: {
    backgroundColor: "#ffffff",
    borderRadius: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    fontSize: 16,
    color: "#0a0a0a",
  },
  inputDark: {
    backgroundColor: "#0a0a0a",
    color: "#ffffff",
  },
  keyRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  keyInput: {
    flex: 1,
  },
  hint: {
    fontSize: 12,
    color: "#888888",
    marginTop: 4,
  },
  textDark: {
    color: "#ffffff",
  },
  metaDark: {
    color: "#888888",
  },
  hintDark: {
    color: "#888888",
  },
  actionButton: {
    alignItems: "center",
    justifyContent: "center",
    padding: 16,
    borderRadius: 12,
    backgroundColor: "#0a0a0a",
    marginTop: 24,
  },
  actionButtonDark: {
    backgroundColor: "#ffffff",
  },
  actionButtonStop: {
    backgroundColor: "#fef2f2",
    borderWidth: 1,
    borderColor: "#ef4444",
  },
  actionButtonText: {
    fontSize: 16,
    fontWeight: "600",
    color: "#ffffff",
  },
  actionButtonTextDark: {
    color: "#0a0a0a",
  },
  actionButtonTextStop: {
    color: "#ef4444",
  },
  help: {
    fontSize: 13,
    color: "#666666",
    lineHeight: 20,
    marginTop: 16,
  },
})
