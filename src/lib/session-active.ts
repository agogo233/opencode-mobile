// Pure helpers for the sessions list: which sessions look "active" right now,
// and the active-first ordering that floats them to the top of the list (and
// of their directory group). No React Native imports — unit-testable with
// node --test, same pattern as status-labels.ts / session-grouping.ts.
//
// `status` mirrors the sessionStatus union in stores/events.ts (which owns the
// SSE-driven copy); declared structurally here so this module stays testable
// without importing the RN-only store.
import type { Session } from "./sdk"

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
  // "Possibly running" guess computed from SERVER data (v2 time.idle hint or
  // a message-tail probe): cold start, or a reconnect resync after a busy
  // event was lost to a dropped connection. Deliberately NOT suppressed by an
  // existing idle record — that record is exactly what may be stale in the
  // lost-busy scenario. Any real status event retires the guess (stores/events.ts).
  inferred?: boolean
}

export function isActive(signals: ActivitySignals): boolean {
  if ((signals.pending ?? 0) > 0) return true
  if (signals.status && signals.status.type !== "idle") return true
  // Server-data guess: lights the row even over an idle record, because the
  // guess is only written when that record is suspected stale. Misfires are
  // bounded: a real status event retires the guess, and the next list load
  // recomputes it wholesale.
  if (signals.inferred) return true
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

// v2 cold-start heuristic: the server stamps `time.idle` at the last idle
// transition, so activity after it (`updated > idle`) means the session may
// still be running — the same inference the opencode web UI makes. Absent
// `idle` (v1 servers, or a v2 session that never ran) stays false: this
// signals "possibly running", so a missing hint must never read as busy.
export function inferredActiveFromTime(updated: number, idle: number | undefined): boolean {
  return idle !== undefined && updated > idle
}

// Split a session list into directly-inferred actives (v2 time hint) and the
// candidates that need a message-tail probe (v1 servers, or a v2 session
// without time.idle). Busy/retry records are SSE-authoritative and never
// guessed over; an idle record does NOT disqualify a session — its busy event
// may have been lost to a dropped connection, which is exactly what this
// inference recovers (both cold start and post-reconnect resync).
export function planActivityInference(
  sessions: Session[],
  statusOf: (id: string) => ActivityStatus | undefined,
): { inferred: Record<string, boolean>; probe: Session[] } {
  const inferred: Record<string, boolean> = {}
  const probe: Session[] = []
  for (const session of sessions) {
    const status = statusOf(session.id)
    if (status && status.type !== "idle") continue
    if (session.time.idle !== undefined) {
      if (inferredActiveFromTime(session.time.updated, session.time.idle)) {
        inferred[session.id] = true
      }
      continue
    }
    probe.push(session)
  }
  return { inferred, probe }
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
