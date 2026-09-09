// Pure helpers for the sessions list: which sessions look "active" right now,
// and the active-first ordering that floats them to the top of the list (and
// of their directory group). No React Native imports — unit-testable with
// node --test, same pattern as status-labels.ts / session-grouping.ts.
//
// `status` mirrors the sessionStatus union in stores/events.ts (which owns the
// SSE-driven copy); declared structurally here so this module stays testable
// without importing the RN-only store.

export interface ActivityStatus {
  type: "idle" | "busy" | "retry"
  attempt?: number
}

export interface ActivitySignals {
  status?: ActivityStatus
  // Optimistic send flag (stores/sessions.ts) — bridges the gap between the
  // user tapping send and the SSE busy event arriving.
  sending?: boolean
  // Count of pending permission + question requests for the session.
  pending?: number
}

export function isActive(signals: ActivitySignals): boolean {
  if ((signals.pending ?? 0) > 0) return true
  if (signals.status && signals.status.type !== "idle") return true
  // SSE status is the source of truth: sending only counts while the server
  // has not reported a status yet — same rule StatusIndicator uses. The
  // documented trade-off: a second send on a session whose status is already
  // "idle" has no marker until the busy event lands (<1s), exactly like the
  // chat-screen indicator does.
  return !!signals.sending && !signals.status
}

// Lower = shown first. Needs-attention outranks a merely-working run so a
// session blocked on the user is never one that merely "looks busy".
export function activePriority(signals: ActivitySignals): number {
  if ((signals.pending ?? 0) > 0) return 1
  if (signals.status?.type === "retry") return 2
  if (isActive(signals)) return 3
  return 4
}

// Stable active-first ordering: priority decides, original position breaks
// ties (Hermes' Array#sort is not guaranteed stable, so index-decorate rather
// than relying on spec stability).
export function orderActiveFirst<T extends { id: string }>(
  items: T[],
  signalsOf: (id: string) => ActivitySignals,
): T[] {
  return items
    .map((item, index) => ({ item, index, priority: activePriority(signalsOf(item.id)) }))
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .map((entry) => entry.item)
}
