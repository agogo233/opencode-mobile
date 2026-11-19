import { create } from "zustand"
import * as SecureStore from "expo-secure-store"
import i18n from "../lib/i18n/config"
import {
  tailscaleNative,
  TAILSCALE_STORAGE_KEYS,
  type TailscalePhase,
  type TailscaleStatus,
} from "../lib/tailscale"
import { autoRetryAllowed, canStart, controlUrlGate } from "../lib/tailscale-policy"
import { isInsecureControlUrl } from "../lib/control-url"

export interface TailscaleConfig {
  controlUrl: string
  authKey: string
  hostname: string
  // Register as an ephemeral node: the device leaves the tailnet shortly
  // after going offline instead of persisting. Keep false for keyless
  // enrollments, which would need re-approval on every start.
  ephemeral: boolean
}

interface TailscaleState {
  phase: TailscalePhase
  hostname: string
  ipv4: string
  ipv6: string
  error: string
  // Approval link while a keyless enrollment is pending; empty otherwise.
  loginUrl: string
  // Persisted identity config (SecureStore)
  controlUrl: string
  authKey: string
  deviceName: string
  configLoaded: boolean
  // Escape hatch for plaintext (http://) control servers. Default false:
  // insecure URLs are rejected outright until the user opts in.
  allowInsecureControl: boolean
  // Ephemeral node registration (see TailscaleConfig). Default false.
  ephemeral: boolean
  // Active loopback forward to the opencode server
  forwardId: string | null
  forwardPort: number | null
  forwardTarget: string | null
  // Start/stop in flight
  busy: boolean

  loadConfig: () => Promise<void>
  saveConfig: (config: TailscaleConfig) => Promise<void>
  setAllowInsecureControl: (value: boolean) => Promise<void>
  refresh: () => Promise<void>
  start: () => Promise<boolean>
  stop: () => Promise<void>
  // Ensure the node is connected and a loopback forward points at targetUrl.
  // Returns the local proxy port, or null when unavailable (not configured,
  // native module missing, or start failed). Starts the node automatically.
  ensureForward: (targetUrl: string) => Promise<number | null>
  // Stop the active loopback forward, if any. Used when the app switches to a
  // connection that does not ride the embedded node.
  releaseForward: () => Promise<void>
}

function randomDeviceName(): string {
  return `opencode-${Math.random().toString(36).slice(2, 6)}`
}

// Serialize ALL mutating ops (ensureForward / start / stop / releaseForward)
// so concurrent client builds can neither create duplicate loopback forwards
// nor race a user-triggered stop/reconfigure mid-flight.
let opChain: Promise<unknown> = Promise.resolve()

// Timestamp of the last failed AUTOMATIC start attempt (the ensureForward
// path). Navigation-triggered client builds must not stack another blocking
// connect onto every build while the tailnet is down; user-initiated starts
// reset it so the banner/settings button always retries immediately.
let lastAutoFailAt = 0

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = opChain.then(task)
  opChain = run.then(
    () => {},
    () => {},
  )
  return run
}

// Raw (unserialized) implementations — call these from inside the chain only.
// Public start()/stop() wrap them with enqueue(); calling the public versions
// from within a chained task would deadlock on itself.

async function doStart(): Promise<boolean> {
  const native = tailscaleNative()
  if (!native) {
    useTailscale.setState({ phase: "error", error: i18n.t("settings.tailscale.page.errors.moduleUnavailable") })
    return false
  }
  // An enrollment or connect attempt is already in flight; a second start
  // would tear it down and reset the approval window. Status polling drives
  // the UI instead.
  if (!canStart(useTailscale.getState().phase)) return false
  const { controlUrl, authKey, deviceName, allowInsecureControl, ephemeral } = useTailscale.getState()
  if (!authKey && !controlUrl) {
    useTailscale.setState({ phase: "error", error: i18n.t("settings.tailscale.page.errors.configRequired") })
    return false
  }
  // Default-deny for plaintext control servers on EVERY start path, not just
  // the settings page: auto-starts via ensureForward must honor the consent
  // flag too. With consent granted there is no interactive step on reconnect,
  // so the stored URL is used as-is.
  if (controlUrl && controlUrlGate(isInsecureControlUrl(controlUrl), allowInsecureControl) === "block") {
    useTailscale.setState({ phase: "error", error: i18n.t("settings.tailscale.page.insecureControlBlockedMessage") })
    return false
  }
  // Starting (re)creates the node: any existing loopback forward dies with
  // the old node. Drop the stale forward state and release the old listener
  // explicitly so it cannot leak when the native side skips the rebuild.
  const staleForwardId = useTailscale.getState().forwardId
  useTailscale.setState({ forwardId: null, forwardPort: null, forwardTarget: null })
  if (staleForwardId) void native.stopForward(staleForwardId).catch(() => {})
  useTailscale.setState({ busy: true, error: "" })
  try {
    if (authKey) {
      const status = await native.start(controlUrl, authKey, deviceName, ephemeral)
      useTailscale.setState(applyStatus(status))
      return status.phase === "connected"
    }
    // Keyless interactive enrollment blocks the native call for minutes while
    // the user approves the node in the control server's web UI. Fire and
    // forget so the serial op chain stays free; progress is tracked via the
    // status polling (phase "connecting" + loginUrl). Flip the phase
    // optimistically so a rapid double-tap hits the canStart gate before the
    // first native call even lands.
    useTailscale.setState({ phase: "connecting", error: "" })
    void native
      .start(controlUrl, "", deviceName, ephemeral)
      .then((status) => {
        useTailscale.setState(applyStatus(status))
      })
      .catch(() => {
        // Surface the native side's final state (error or stopped) instead of
        // the raw rejection text.
        void useTailscale.getState().refresh().catch(() => {})
      })
    return true
  } catch (error) {
    useTailscale.setState({ phase: "error", error: error instanceof Error ? error.message : String(error) })
    return false
  } finally {
    useTailscale.setState({ busy: false })
  }
}

async function doStop(): Promise<void> {
  const native = tailscaleNative()
  if (!native) return
  useTailscale.setState({ busy: true })
  try {
    const status = await native.stop()
    useTailscale.setState(applyStatus(status))
    useTailscale.setState({ forwardId: null, forwardPort: null, forwardTarget: null })
  } catch (error) {
    useTailscale.setState({ error: error instanceof Error ? error.message : String(error) })
  } finally {
    useTailscale.setState({ busy: false })
  }
}

async function doReleaseForward(): Promise<void> {
  const native = tailscaleNative()
  if (!native) return
  const { forwardId } = useTailscale.getState()
  if (!forwardId) return
  await native.stopForward(forwardId).catch(() => {})
  useTailscale.setState({ forwardId: null, forwardPort: null, forwardTarget: null })
}

async function doEnsureForward(targetUrl: string): Promise<number | null> {
  const native = tailscaleNative()
  if (!native) return null
  const { authKey, controlUrl } = useTailscale.getState()
  let status = await native.status().catch(() => null)
  if (!status || status.phase !== "connected") {
    // An enrollment or connect attempt is already in flight; let it finish
    // (status polling drives the UI) instead of stacking another start.
    if (status?.phase === "connecting") return null
    if (!authKey && !controlUrl) return null
    if (!autoRetryAllowed(lastAutoFailAt, Date.now())) return null
    const ok = await doStart()
    if (!ok) {
      lastAutoFailAt = Date.now()
      return null
    }
    status = await native.status().catch(() => null)
    if (!status || status.phase !== "connected") {
      // Covers a failed connect as well as a keyless enrollment still inside
      // its approval window (which ensureForward cannot serve yet anyway).
      lastAutoFailAt = Date.now()
      return null
    }
  }
  // Reuse the existing forward only when THIS forward is still registered. A
  // forward whose accept loop died (or that vanished with a restarted node)
  // would otherwise be served from stale store state forever; counting all
  // forwards is not enough when unrelated pipes survive.
  const state = useTailscale.getState()
  if (state.forwardTarget === targetUrl && state.forwardPort && state.forwardId) {
    const forwardAlive = await native.isForwardAlive(state.forwardId).catch(() => false)
    if (forwardAlive) return state.forwardPort
  }
  // The store owns the node's only forward: retire everything (including any
  // leftover from a dev-time reload) before opening the one we need, and drop
  // the stale ids from the state so a failed open cannot leave a dead port
  // behind.
  await native.stopAllForwards().catch(() => {})
  useTailscale.setState({ forwardId: null, forwardPort: null, forwardTarget: null })
  try {
    const forward = await native.forward(targetUrl)
    useTailscale.setState({ forwardId: forward.id, forwardPort: forward.port, forwardTarget: targetUrl })
    return forward.port
  } catch (error) {
    useTailscale.setState({ error: error instanceof Error ? error.message : String(error) })
    return null
  }
}

function applyStatus(status: TailscaleStatus) {
  return {
    phase: status.phase,
    hostname: status.hostname,
    ipv4: status.addresses?.ipv4 ?? "",
    ipv6: status.addresses?.ipv6 ?? "",
    error: status.error ?? "",
    loginUrl: status.loginUrl ?? "",
  }
}

export const useTailscale = create<TailscaleState>((set) => ({
  phase: "new",
  hostname: "",
  ipv4: "",
  ipv6: "",
  error: "",
  loginUrl: "",
  controlUrl: "",
  authKey: "",
  deviceName: "",
  configLoaded: false,
  allowInsecureControl: false,
  ephemeral: false,
  forwardId: null,
  forwardPort: null,
  forwardTarget: null,
  busy: false,

  loadConfig: async () => {
    const [controlUrl, authKey, hostname, allowInsecureControl, ephemeral] = await Promise.all([
      SecureStore.getItemAsync(TAILSCALE_STORAGE_KEYS.controlUrl),
      SecureStore.getItemAsync(TAILSCALE_STORAGE_KEYS.authKey),
      SecureStore.getItemAsync(TAILSCALE_STORAGE_KEYS.hostname),
      SecureStore.getItemAsync(TAILSCALE_STORAGE_KEYS.allowInsecureControl),
      SecureStore.getItemAsync(TAILSCALE_STORAGE_KEYS.ephemeral),
    ])
    set({
      controlUrl: controlUrl ?? "",
      authKey: authKey ?? "",
      deviceName: hostname ?? "",
      allowInsecureControl: allowInsecureControl === "true",
      ephemeral: ephemeral === "true",
      configLoaded: true,
    })
  },

  setAllowInsecureControl: async (value) => {
    await SecureStore.setItemAsync(TAILSCALE_STORAGE_KEYS.allowInsecureControl, value ? "true" : "false")
    set({ allowInsecureControl: value })
  },

  saveConfig: async (config) => {
    const deviceName = config.hostname.trim() || randomDeviceName()
    await Promise.all([
      SecureStore.setItemAsync(TAILSCALE_STORAGE_KEYS.controlUrl, config.controlUrl.trim()),
      SecureStore.setItemAsync(TAILSCALE_STORAGE_KEYS.authKey, config.authKey.trim()),
      SecureStore.setItemAsync(TAILSCALE_STORAGE_KEYS.hostname, deviceName),
      SecureStore.setItemAsync(TAILSCALE_STORAGE_KEYS.ephemeral, config.ephemeral ? "true" : "false"),
    ])
    set({
      controlUrl: config.controlUrl.trim(),
      authKey: config.authKey.trim(),
      deviceName,
      ephemeral: config.ephemeral,
    })
  },

  refresh: async () => {
    const native = tailscaleNative()
    if (!native) return
    const status = await native.status().catch(() => null)
    if (status) set(applyStatus(status))
  },

  // User-initiated start: always allowed, clears the auto-retry cooldown.
  start: () =>
    enqueue(() => {
      lastAutoFailAt = 0
      return doStart()
    }),

  stop: () => enqueue(() => doStop()),

  ensureForward: (targetUrl) => enqueue(() => doEnsureForward(targetUrl)),

  releaseForward: () => enqueue(() => doReleaseForward()),
}))
