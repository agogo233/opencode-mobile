// Thin wrapper around the Tailscale native module (android only). All methods
// return null/undefined results when the module is unavailable (iOS, or a
// build without the AAR) so callers can degrade gracefully.
import { NativeModules, Platform } from "react-native"

// Lifecycle phases reported by the Go forwarder (see native/tailscale-go).
export type TailscalePhase = "new" | "configured" | "connecting" | "connected" | "error" | "closed"

export interface TailscaleStatus {
  phase: TailscalePhase
  hostname: string
  error: string
  forwardCount: number
  addresses: { ipv4: string; ipv6: string }
  // Approval link for a pending keyless enrollment (empty otherwise).
  loginUrl?: string
}

export interface TailscaleForward {
  id: string
  port: number
}

interface TailscaleNativeModule {
  start(controlUrl: string, authKey: string, hostname: string, ephemeral: boolean): Promise<TailscaleStatus>
  stop(): Promise<TailscaleStatus>
  status(): Promise<TailscaleStatus>
  forward(targetUrl: string): Promise<TailscaleForward>
  stopForward(id: string): Promise<void>
  // True when the forward with this exact ID is still registered natively.
  isForwardAlive(id: string): Promise<boolean>
  // Stops every native forward; the store owns the node's only forward.
  stopAllForwards(): Promise<void>
  // Direct-connect mode: routing switch plus the target allowlist. The same
  // allowlist is mirrored into the Go proxy as a second gate.
  setDirectMode(enabled: boolean): Promise<void>
  registerDirectHost(target: string): Promise<void>
  unregisterDirectHost(target: string): Promise<void>
}

export function tailscaleNative(): TailscaleNativeModule | null {
  if (Platform.OS !== "android") return null
  const mod = NativeModules.Tailscale as TailscaleNativeModule | undefined
  return mod ?? null
}

export const TAILSCALE_STORAGE_KEYS = {
  controlUrl: "opencode_ts_control_url",
  authKey: "opencode_ts_auth_key",
  hostname: "opencode_ts_hostname",
  allowInsecureControl: "opencode_ts_allow_insecure_control",
  ephemeral: "opencode_ts_ephemeral",
  directMode: "opencode_ts_direct_mode",
} as const
