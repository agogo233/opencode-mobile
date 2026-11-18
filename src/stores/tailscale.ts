import { create } from "zustand"
import * as SecureStore from "expo-secure-store"
import i18n from "../lib/i18n/config"
import {
  tailscaleNative,
  TAILSCALE_STORAGE_KEYS,
  type TailscalePhase,
  type TailscaleStatus,
} from "../lib/tailscale"

export interface TailscaleConfig {
  controlUrl: string
  authKey: string
  hostname: string
}

interface TailscaleState {
  phase: TailscalePhase
  hostname: string
  ipv4: string
  ipv6: string
  error: string
  // Persisted identity config (SecureStore)
  controlUrl: string
  authKey: string
  deviceName: string
  configLoaded: boolean
  // Active loopback forward to the opencode server
  forwardId: string | null
  forwardPort: number | null
  forwardTarget: string | null
  // Start/stop in flight
  busy: boolean

  loadConfig: () => Promise<void>
  saveConfig: (config: TailscaleConfig) => Promise<void>
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
  const { controlUrl, authKey, deviceName } = useTailscale.getState()
  if (!authKey) {
    useTailscale.setState({ phase: "error", error: i18n.t("settings.tailscale.page.errors.authKeyRequired") })
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
    const status = await native.start(controlUrl, authKey, deviceName)
    useTailscale.setState(applyStatus(status))
    return status.phase === "connected"
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
  const { authKey } = useTailscale.getState()
  let status = await native.status().catch(() => null)
  if (!status || status.phase !== "connected") {
    if (!authKey) return null
    const ok = await doStart()
    if (!ok) return null
    status = await native.status().catch(() => null)
  }
  // Reuse the existing forward only when the node still reports it alive. A
  // forward whose accept loop died (or that vanished with a restarted node)
  // would otherwise be served from stale store state forever.
  const forwardAlive = !!status && status.phase === "connected" && status.forwardCount > 0
  const state = useTailscale.getState()
  if (state.forwardTarget === targetUrl && state.forwardPort && forwardAlive) return state.forwardPort
  if (state.forwardId) await native.stopForward(state.forwardId).catch(() => {})
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
  }
}

export const useTailscale = create<TailscaleState>((set) => ({
  phase: "new",
  hostname: "",
  ipv4: "",
  ipv6: "",
  error: "",
  controlUrl: "",
  authKey: "",
  deviceName: "",
  configLoaded: false,
  forwardId: null,
  forwardPort: null,
  forwardTarget: null,
  busy: false,

  loadConfig: async () => {
    const [controlUrl, authKey, hostname] = await Promise.all([
      SecureStore.getItemAsync(TAILSCALE_STORAGE_KEYS.controlUrl),
      SecureStore.getItemAsync(TAILSCALE_STORAGE_KEYS.authKey),
      SecureStore.getItemAsync(TAILSCALE_STORAGE_KEYS.hostname),
    ])
    set({
      controlUrl: controlUrl ?? "",
      authKey: authKey ?? "",
      deviceName: hostname ?? "",
      configLoaded: true,
    })
  },

  saveConfig: async (config) => {
    const deviceName = config.hostname.trim() || randomDeviceName()
    await Promise.all([
      SecureStore.setItemAsync(TAILSCALE_STORAGE_KEYS.controlUrl, config.controlUrl.trim()),
      SecureStore.setItemAsync(TAILSCALE_STORAGE_KEYS.authKey, config.authKey.trim()),
      SecureStore.setItemAsync(TAILSCALE_STORAGE_KEYS.hostname, deviceName),
    ])
    set({ controlUrl: config.controlUrl.trim(), authKey: config.authKey.trim(), deviceName })
  },

  refresh: async () => {
    const native = tailscaleNative()
    if (!native) return
    const status = await native.status().catch(() => null)
    if (status) set(applyStatus(status))
  },

  start: () => enqueue(() => doStart()),

  stop: () => enqueue(() => doStop()),

  ensureForward: (targetUrl) => enqueue(() => doEnsureForward(targetUrl)),

  releaseForward: () => enqueue(() => doReleaseForward()),
}))
