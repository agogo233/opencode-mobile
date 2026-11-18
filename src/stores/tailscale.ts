import { create } from "zustand"
import * as SecureStore from "expo-secure-store"
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
}

function randomDeviceName(): string {
  return `opencode-${Math.random().toString(36).slice(2, 6)}`
}

// Serializes concurrent ensureForward calls for the same target so two
// interleaved client builds cannot create duplicate loopback forwards.
let inflightForward: { target: string; promise: Promise<number | null> } | null = null

async function doEnsureForward(targetUrl: string): Promise<number | null> {
  const native = tailscaleNative()
  if (!native) return null
  const { controlUrl, authKey, deviceName } = useTailscale.getState()
  const status = await native.status().catch(() => null)
  if (!status || status.phase !== "connected") {
    if (!authKey) return null
    const ok = await useTailscale.getState().start()
    if (!ok) return null
  }
  const state = useTailscale.getState()
  if (state.forwardTarget === targetUrl && state.forwardPort) return state.forwardPort
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

export const useTailscale = create<TailscaleState>((set, get) => ({
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

  start: async () => {
    const native = tailscaleNative()
    if (!native) {
      set({ phase: "error", error: "Tailscale module unavailable on this platform" })
      return false
    }
    const { controlUrl, authKey, deviceName } = get()
    if (!authKey) {
      set({ phase: "error", error: "auth key required" })
      return false
    }
    set({ busy: true, error: "" })
    try {
      const status = await native.start(controlUrl, authKey, deviceName)
      set(applyStatus(status))
      return status.phase === "connected"
    } catch (error) {
      set({ phase: "error", error: error instanceof Error ? error.message : String(error) })
      return false
    } finally {
      set({ busy: false })
    }
  },

  stop: async () => {
    const native = tailscaleNative()
    if (!native) return
    set({ busy: true })
    try {
      const status = await native.stop()
      set(applyStatus(status))
      set({ forwardId: null, forwardPort: null, forwardTarget: null })
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    } finally {
      set({ busy: false })
    }
  },

  ensureForward: (targetUrl) => {
    if (get().forwardTarget === targetUrl && get().forwardPort) return Promise.resolve(get().forwardPort)
    if (inflightForward?.target === targetUrl) return inflightForward.promise
    const promise = doEnsureForward(targetUrl).finally(() => {
      if (inflightForward?.promise === promise) inflightForward = null
    })
    inflightForward = { target: targetUrl, promise }
    return promise
  },
}))
