// Pure decision helpers for the embedded Tailscale node. Kept free of
// react-native imports so node --test can exercise them directly.
import type { TailscalePhase } from "./tailscale"

// A start request must not stack onto an in-flight connect or keyless
// enrollment: the native side would tear down the pending attempt and reset
// the approval window. Only "connecting" is blocked — every other phase may
// begin (or retry) a connect.
export function canStart(phase: TailscalePhase): boolean {
  return phase !== "connecting"
}

export type ControlUrlDecision = "ok" | "confirm" | "block"

// Gate for plaintext (http://) control servers: blocked by default, upgraded
// to a confirmation prompt once the user explicitly allows plaintext via the
// hidden switch.
export function controlUrlGate(isInsecure: boolean, allowInsecure: boolean): ControlUrlDecision {
  if (!isInsecure) return "ok"
  return allowInsecure ? "confirm" : "block"
}
