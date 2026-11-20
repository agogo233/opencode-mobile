// Pure decision helpers for the embedded Tailscale node. Kept free of
// react-native imports so node --test can exercise them directly.
import type { TailscalePhase, TailscaleStatus } from "./tailscale"

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

// After an automatic start attempt fails, hold off on stacking another
// blocking connect onto every client build (each attempt can block for up to
// a minute). User-initiated starts bypass the cooldown entirely — the store
// resets the timestamp whenever the user presses start/reconnect.
export const AUTO_RETRY_COOLDOWN_MS = 60_000

export function autoRetryAllowed(lastFailAt: number, now: number): boolean {
  return now - lastFailAt >= AUTO_RETRY_COOLDOWN_MS
}

// Whether a failed client build is worth pausing on: the node is either
// already connected (a race just missed it) or still connecting (keyless
// approval, first connect after a cold start) and will serve traffic soon.
// Every other phase means the node needs user action — waiting is pointless.
export function shouldAwaitNodeRetry(phase: TailscalePhase | null | undefined): boolean {
  return phase === "connecting" || phase === "connected"
}

export interface PollUntilConnectedOptions {
  intervalMs: number
  timeoutMs: number
  // Injectable timer so tests run without real waiting.
  delayFn?: (ms: number) => Promise<void>
  // Observes every poll result (store sync / UI refresh).
  onStatus?: (status: TailscaleStatus) => void
}

// Poll a status source until the node reports connected. A failed query is a
// transient hiccup, not a verdict — keep polling until the timeout. An
// explicit error/closed phase ends the wait early: the node will not come up
// on its own. A "new" phase keeps polling: the native stop path reports
// "closed", so a user stop still interrupts the wait; "new" only appears
// before the first start.
export async function pollUntilConnected(
  getStatus: () => Promise<TailscaleStatus | null>,
  options: PollUntilConnectedOptions,
): Promise<boolean> {
  const { intervalMs, timeoutMs, delayFn = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)), onStatus } =
    options
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await getStatus().catch(() => null)
    if (status && onStatus) onStatus(status)
    if (status?.phase === "connected") return true
    if (status?.phase === "error" || status?.phase === "closed") return false
    if (Date.now() >= deadline) return false
    await delayFn(intervalMs)
  }
}
