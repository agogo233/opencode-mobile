import { create } from "zustand"
import { useConnections } from "./connections"
import { useSessions, abortedSessions, scheduleRefreshMessages, pageSize } from "./sessions"
import { mergePaged } from "../lib/message-diff-merge"
import { send as notify } from "../lib/notifications"
import { sanitizeBody } from "../lib/notify-format"
import { statusFromPart } from "../lib/status-labels"
import { recordSuccessfulSession } from "../lib/store-review"
import { isAuthError } from "../lib/api-error"
import { isSessionActuallyIdle, sessionLooksBusy } from "../lib/session-status-reconcile"
import { inferredActiveFromTime } from "../lib/session-active"
import i18n from "../lib/i18n/config"
import { AppState } from "react-native"
import { mergePendingPermissions, normalizePendingPermission, normalizePermissionEvent, type PendingPermission } from "../lib/permissions"
import type { Client, Part, Session, Message } from "../lib/sdk"

// Session status from the server
type SessionStatus = { type: "idle" } | { type: "busy" } | { type: "retry"; attempt: number; message: string }

interface EventsState {
  connected: boolean
  // Set when the last connection attempt failed with 401/403 — the server
  // rejected our credentials, not a transient network issue. The reconnect
  // loop stops retrying in this case (see connect()) since hammering a
  // fixed-credential auth failure forever just drains the battery with no
  // path to recovery (issue #76). Cleared on the next connect() attempt,
  // e.g. after the user fixes their credentials on the connection edit screen.
  authError: boolean
  reconnectAttempts: number
  lastDisconnectAt: number | null
  sessionStatus: Record<string, SessionStatus>
  statusText: Record<string, string>
  // Cold-start "possibly running" guesses (loadSessions computes them from
  // v2 time.idle hints / v1 message-tail probes). SSE never replays the busy
  // event of a session that started before the app opened, so this is the
  // only marker those sessions get until their next real status event —
  // which retires the guess (see the session.status case).
  inferredActive: Record<string, boolean>
  // Permissions & questions (pending per session)
  permissions: Record<string, PendingPermission[]>
  questions: Record<
    string,
    Array<{
      id: string
      sessionID: string
      questions: Array<{
        question: string
        header: string
        options: Array<{ label: string; description: string }>
        multiple?: boolean
        custom?: boolean
      }>
      tool?: { messageID: string; callID: string }
    }>
  >

  connect: () => void
  disconnect: () => void
  // Replace the cold-start inference map wholesale. Computed by loadSessions
  // after each list fetch; entries are filtered against sessionStatus so a
  // status event that landed while the caller was computing always wins.
  setInferredActive: (map: Record<string, boolean>) => void
  // Force an immediate reconnect + full resync, bypassing the backoff loop.
  // Called when the app returns to the foreground: Android freezes JS timers
  // and usually kills the SSE socket while backgrounded, so the backoff
  // timers that were scheduled never ran and the stream is stale.
  reconnectNow: () => void
}

let controller: AbortController | null = null
let reconnectTimer: ReturnType<typeof setTimeout> | null = null

// Sessions that emitted session.error since they last went busy. SessionStatus
// has no error variant — an errored session still ends with a busy -> idle
// transition — so without this mark an errored run would count as a success
// toward the once-ever store review prompt.
const erroredSessions = new Set<string>()

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000] as const
const STABLE_CONNECTION_MS = 10_000
const PROLONGED_DISCONNECT_MS = 30_000
// Message-tail probes per inference pass — one bounded request per candidate.
const PROBE_LIMIT = 10

// Re-fetch pending permissions and questions from the server for a session.
// Called when entering a session to recover from missed SSE events or failed
// optimistic removals.
export async function refreshPending(client: Client, sessionID: string) {
  try {
    // v2 permission/form lists are session-scoped — pass the session so
    // pending prompts are found regardless of the server's active location.
    const [perms, questions] = await Promise.all([client.permission.list(sessionID), client.question.list(sessionID)])
    const sessionPerms = (perms || []).map(normalizePendingPermission).filter((p): p is PendingPermission => !!p && p.sessionID === sessionID)
    const sessionQuestions = (questions || []).filter((q: Record<string, unknown>) => q.sessionID === sessionID)
    useEvents.setState((state) => ({
      permissions: { ...state.permissions, [sessionID]: mergePendingPermissions([], sessionPerms) },
      questions: { ...state.questions, [sessionID]: sessionQuestions as any },
    }))
  } catch (err) {
    console.warn("[Events] Failed to refresh pending:", err)
  }
}

async function refreshAllPending() {
  const connectionState = useConnections.getState()
  const clients = new Set<Client>()
  if (connectionState.client) clients.add(connectionState.client)
  for (const session of useSessions.getState().sessions) {
    if (!session.directory) continue
    const client = connectionState.clientForDirectory(session.directory)
    if (client) clients.add(client)
  }
  await Promise.all([...clients].map(async (client) => {
    try {
      const pending = await client.permission.list()
      const grouped = new Map<string, PendingPermission[]>()
      for (const value of pending || []) {
        const normalized = normalizePendingPermission(value)
        if (normalized) grouped.set(normalized.sessionID, [...(grouped.get(normalized.sessionID) || []), normalized])
      }
      useEvents.setState((state) => {
        const permissions = { ...state.permissions }
        for (const [sessionID, items] of grouped) permissions[sessionID] = mergePendingPermissions(permissions[sessionID] || [], items)
        return { permissions }
      })
    } catch (err) {
      console.warn("[Events] Failed to reconcile pending permissions:", err)
    }
  }))
}

// Re-sync any session currently marked "busy" against the server after an
// SSE reconnect. sessionStatus/sending are SSE-driven and there is normally
// no other path to idle — if the server's busy -> idle `session.status`
// event fired while the network was down, SSE reconnect resumes the stream
// from "now" (it does not replay missed events), so without this the busy
// flag would never clear and the UI would show a stuck 'processing' spinner
// forever (issue #123).
//
// Only ever CLEARS a busy flag the server confirms is stale via
// isSessionActuallyIdle — it never marks a session busy, so it can't
// clobber a genuinely still-busy session. Also re-checks sessionStatus right
// before writing, so a real session.status event that lands while the fetch
// is in flight (e.g. the session went busy again) wins over this resync.
async function resyncBusySessions() {
  const busySessionIDs = Object.entries(useEvents.getState().sessionStatus)
    .filter(([, status]) => status.type === "busy")
    .map(([sessionID]) => sessionID)
  if (busySessionIDs.length === 0) return

  await Promise.all(
    busySessionIDs.map(async (sessionID) => {
      try {
        const sessionsState = useSessions.getState()
        const session =
          sessionsState.sessions.find((s) => s.id === sessionID) ??
          (sessionsState.currentSession?.id === sessionID ? sessionsState.currentSession : undefined)
        const connState = useConnections.getState()
        const client = session?.directory
          ? connState.clientForDirectory(session.directory) ?? connState.client
          : connState.client
        if (!client) return

        // Only the tail matters for the idle check, and a bounded page is all
        // the merge below needs — fetching the whole timeline here would race
        // the later foreground refresh and stall returning to the app.
        const response = await client.session.messages(sessionID, { limit: Math.max(1, pageSize()) })
        const info = (response || []).map((m) => m.info)
        if (!isSessionActuallyIdle(info)) return // server says still busy - leave it alone

        // A fresh session.status event may have landed on the SSE stream
        // while this fetch was in flight — that's authoritative, don't
        // stomp on it.
        if (useEvents.getState().sessionStatus[sessionID]?.type !== "busy") return

        useEvents.setState((state) => ({
          sessionStatus: { ...state.sessionStatus, [sessionID]: { type: "idle" } },
          statusText: { ...state.statusText, [sessionID]: "" },
        }))
        useSessions.setState((state) => ({ sending: { ...state.sending, [sessionID]: false } }))
        // This session is the one on screen — fold the page we already fetched
        // in so the idle transition is reflected immediately rather than only
        // after the coalesced refresh reconnectNow already scheduled. Non-current
        // sessions have nothing to merge: their messages aren't held in the
        // store anyway.
        if (useSessions.getState().currentSession?.id === sessionID) {
          useSessions.setState((state) => {
            const { messages, parts } = mergePaged(state.messages, state.parts, response || [])
            return { messages, parts }
          })
        }
      } catch (err) {
        console.warn("[Events] Failed to resync session status for", sessionID, err)
      }
    }),
  )
}

// Cold-start "possibly running" inference for sessions SSE never spoke for.
// The stream starts at "now" — a session that went busy before the app opened
// (desktop/CLI start, or the app was killed mid-run) never delivers its busy
// event, so the sessions list showed no marker at all. Called by loadSessions
// after each list fetch:
//   * v2 timestamps answer most sessions for free (`updated > idle` hints a
//     run may still be in progress — same inference as the opencode web UI);
//   * the rest (v1 servers, or a v2 session without time.idle) get a
//     message-tail probe, bounded to the most recently updated few since a
//     running session keeps time.updated fresh.
// SSE remains authoritative: entries are retired by the first real
// session.status event, and setInferredActive never stamps over a session
// SSE has already reported on.
export async function inferActiveSessions(sessions: Session[]) {
  const inferred: Record<string, boolean> = {}
  const probe: Session[] = []
  for (const session of sessions) {
    if (session.id in useEvents.getState().sessionStatus) continue
    if (session.time.idle !== undefined) {
      if (inferredActiveFromTime(session.time.updated, session.time.idle)) {
        inferred[session.id] = true
      }
      continue
    }
    probe.push(session)
  }

  const connState = useConnections.getState()
  await Promise.all(
    probe
      .sort((a, b) => b.time.updated - a.time.updated)
      .slice(0, PROBE_LIMIT)
      .map(async (session) => {
        try {
          const client = session.directory
            ? connState.clientForDirectory(session.directory) ?? connState.client
            : connState.client
          if (!client) return
          const response = await client.session.messages(session.id, { limit: 1 })
          if (sessionLooksBusy((response || []).map((m) => m.info))) {
            inferred[session.id] = true
          }
        } catch (err) {
          // A failed probe just means no marker — SSE stays the source of truth.
          console.warn("[Events] Failed to probe session tail for", session.id, err)
        }
      }),
  )
  useEvents.getState().setInferredActive(inferred)
}

export const useEvents = create<EventsState>((set, get) => ({
  connected: false,
  authError: false,
  reconnectAttempts: 0,
  lastDisconnectAt: null,
  sessionStatus: {},
  statusText: {},
  inferredActive: {},
  permissions: {},
  questions: {},

  connect: () => {
    controller?.abort()
    controller = null
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }

    const client = useConnections.getState().client
    if (!client) return

    controller = new AbortController()
    const currentController = controller
    set({ connected: true, authError: false })
    console.log("[SSE] Connecting to event stream...")

    // Run in background
    ;(async () => {
      let reconnectScheduled = false
      // True if this connect() call is resuming after a prior disconnect —
      // gates the one-time busy-session resync below so a cold app start
      // (sessionStatus is always empty then) never triggers it, and a run of
      // failed retries can't re-arm the check on every attempt.
      const isReconnect = get().reconnectAttempts > 0
      let resyncedAfterReconnect = false
      const stableTimer = setTimeout(() => {
        if (!currentController.signal.aborted) {
          set({ reconnectAttempts: 0, lastDisconnectAt: null })
        }
      }, STABLE_CONNECTION_MS)

      const scheduleReconnect = (reason: unknown) => {
        if (reconnectScheduled || currentController.signal.aborted) return
        reconnectScheduled = true
        const state = get()
        const reconnectAttempts = state.reconnectAttempts + 1
        const lastDisconnectAt = state.lastDisconnectAt ?? Date.now()
        const disconnectedFor = Date.now() - lastDisconnectAt
        set({ connected: false, reconnectAttempts, lastDisconnectAt })

        if (disconnectedFor >= PROLONGED_DISCONNECT_MS) {
          notify({
            category: "connection",
            title: i18n.t("notifications.messages.connectionInterrupted"),
            body: sanitizeBody(undefined, i18n.t("notifications.messages.reconnectingFallback")),
            sessionId: "",
            dedupeKey: "sse-prolonged-disconnect",
            dedupeCooldownMs: 60_000,
          })
        }

        const baseDelay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempts - 1, RECONNECT_DELAYS_MS.length - 1)]
        const jitteredDelay = Math.min(15_000, Math.round(baseDelay * (0.75 + Math.random() * 0.5)))
        console.warn(`[SSE] Connection lost, reconnecting in ${jitteredDelay}ms:`, reason)
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null
          get().connect()
        }, jitteredDelay)
      }

      try {
        for await (const event of client.global.events(currentController.signal)) {
          if (currentController.signal.aborted) break

          // The stream is genuinely live again (we're actually receiving
          // data, not just optimistically marked "connected") — resync once
          // per reconnect, not on every event.
          if (isReconnect && !resyncedAfterReconnect) {
            resyncedAfterReconnect = true
            void resyncBusySessions()
            void refreshAllPending()
          }

          const payload = (event as any).payload || event
          const type = payload.type as string
          const props = payload.properties || {}

          switch (type) {
            case "session.status": {
              const sessionID = props.sessionID as string
              const status = props.status as SessionStatus
              if (!sessionID) break

              // Detect busy → idle transition for completion notification
              const previous = get().sessionStatus[sessionID]
              const completed = previous?.type === "busy" && status.type === "idle"

              // A new run starts — forget any error/abort from the previous one
              if (status.type === "busy") {
                erroredSessions.delete(sessionID)
                abortedSessions.delete(sessionID)
              }

              set((state) => {
                // A real status event is authoritative — retire the cold-start
                // guess for this session, if any. The record is only copied
                // when a guess exists, so sessions without one keep the same
                // reference (no screen-level re-render).
                const guessed = state.inferredActive
                const inferredActive = sessionID in guessed
                  ? Object.fromEntries(Object.entries(guessed).filter(([id]) => id !== sessionID))
                  : guessed
                return {
                  sessionStatus: { ...state.sessionStatus, [sessionID]: status },
                  // Clear status text when idle
                  statusText: status.type === "idle" ? { ...state.statusText, [sessionID]: "" } : state.statusText,
                  inferredActive,
                }
              })

              // SSE is the source of truth — update sending state unconditionally
              if (status.type === "idle") {
                useSessions.setState((state) => ({
                  sending: { ...state.sending, [sessionID]: false },
                }))
                // Refresh messages if this is the session the user is viewing
                const sessions = useSessions.getState()
                if (sessions.currentSession?.id === sessionID) {
                  scheduleRefreshMessages()
                }
              }

              if (completed) {
                // A user-cancelled run also ends busy -> idle; it is not a
                // review-worthy success.
                const aborted = abortedSessions.has(sessionID)
                // Only notify "Task completed" for a genuine completion — a
                // user-cancelled run didn't complete, and an errored run
                // already fired its own "Session error" notification (session.error
                // doesn't touch sessionStatus, so an errored session still lands
                // here via busy→idle). Without this guard the user gets a
                // misleading — or duplicate, contradictory — completion push.
                if (!aborted && !erroredSessions.has(sessionID)) {
                  const match = useSessions.getState().sessions.find((s) => s.id === sessionID)
                  notify({
                    category: "completed",
                    title: i18n.t("notifications.messages.taskCompleted"),
                    body: sanitizeBody(match?.title, i18n.t("notifications.messages.taskCompletedFallback")),
                    sessionId: sessionID,
                  })
                }
                // Genuinely positive moment — count it toward the one-time
                // store review prompt, but only if this run never errored
                // (session.error doesn't touch sessionStatus, so an errored
                // session still lands here via busy -> idle) and wasn't aborted.
                if (!aborted && !erroredSessions.has(sessionID)) void recordSuccessfulSession()
              }
              break
            }

            case "message.updated": {
              const info = props.info as Message | undefined
              if (!info) break
              useSessions.getState().handleEvent({ type, properties: { info } } as any)
              break
            }

            case "message.part.updated": {
              const part = props.part as Part | undefined
              if (!part) break

              // Update status text from the latest part
              const sessionID = (part as any).sessionID as string
              if (sessionID) {
                set((state) => ({
                  statusText: { ...state.statusText, [sessionID]: statusFromPart(part) },
                }))
              }

              useSessions.getState().handleEvent({ type, properties: { part } } as any)
              break
            }

            case "session.updated": {
              const info = props.info as Session | undefined
              if (!info) break
              useSessions.getState().handleEvent({ type, properties: { info } } as any)
              break
            }

            case "session.created": {
              const info = props.info as Session | undefined
              if (!info) break
              // Add to sessions list
              useSessions.setState((state) => {
                const exists = state.sessions.some((s) => s.id === info.id)
                if (exists) return {}
                return { sessions: [info, ...state.sessions] }
              })
              break
            }

            case "session.error": {
              const error = props.error as { message?: string } | undefined
              const sessionID = props.sessionID as string
              if (!sessionID) break
              // Mark so the eventual busy -> idle transition is not counted
              // as a success for the store review prompt
              erroredSessions.add(sessionID)
              // Clear sending state unconditionally — SSE is truth
              useSessions.setState((state) => ({
                sending: { ...state.sending, [sessionID]: false },
                // Surface error only if user is viewing this session
                ...(state.currentSession?.id === sessionID
                  ? { error: error?.message || "errors.sessionErrorOccurred" }
                  : {}),
              }))
              if (useSessions.getState().currentSession?.id === sessionID) {
                scheduleRefreshMessages()
              }
              notify({
                category: "errors",
                title: i18n.t("notifications.messages.sessionError"),
                body: sanitizeBody(error?.message, i18n.t("notifications.messages.sessionErrorFallback")),
                sessionId: sessionID,
              })
              break
            }

            case "permission.asked":
            case "permission.v2.asked": {
              const req = normalizePermissionEvent({ type, properties: props })
              if (!req) break
              const existing = get().permissions[req.sessionID] || []
              if (existing.some((item) => item.id === req.id)) break
              set((state) => ({
                permissions: {
                  ...state.permissions,
                  [req.sessionID]: mergePendingPermissions(state.permissions[req.sessionID] || [], [req]),
                },
              }))
              notify({
                category: "permissions",
                title: i18n.t("notifications.messages.approvalNeeded"),
                body: sanitizeBody(
                  req.permission
                    ? req.patterns?.length
                      ? `${req.permission}: ${req.patterns.join(", ")}`
                      : req.permission
                    : req.patterns?.join(", "),
                  i18n.t("notifications.messages.approvalNeededFallback"),
                ),
                sessionId: req.sessionID,
                dedupeKey: `perm-${req.id}`,
                dedupeCooldownMs: 60_000,
              })
              break
            }

            case "permission.replied":
            case "permission.v2.replied": {
              const sessionID = props.sessionID as string
              const requestID = props.requestID as string
              if (!sessionID || !requestID) break
              set((state) => ({
                permissions: {
                  ...state.permissions,
                  [sessionID]: (state.permissions[sessionID] || []).filter((p) => p.id !== requestID),
                },
              }))
              break
            }

            case "question.asked": {
              const req = props as any
              if (!req.id || !req.sessionID) break
              const existing = get().questions[req.sessionID] || []
              if (existing.some((item) => item.id === req.id)) break
              set((state) => ({
                questions: {
                  ...state.questions,
                  [req.sessionID]: [...(state.questions[req.sessionID] || []), req],
                },
              }))
              notify({
                category: "questions",
                title: req.questions?.[0]?.header || i18n.t("notifications.messages.inputNeeded"),
                body: sanitizeBody(req.questions?.[0]?.question, i18n.t("notifications.messages.questionFallback")),
                sessionId: req.sessionID,
                dedupeKey: `question-${req.id}`,
                dedupeCooldownMs: 60_000,
              })
              break
            }

            case "question.replied":
            case "question.rejected": {
              const sessionID = props.sessionID as string
              const requestID = props.requestID as string
              if (!sessionID || !requestID) break
              set((state) => ({
                questions: {
                  ...state.questions,
                  [sessionID]: (state.questions[sessionID] || []).filter((q) => q.id !== requestID),
                },
              }))
              break
            }
          }
        }

        scheduleReconnect(new Error("Event stream closed"))
      } catch (err) {
        if (isAuthError(err) && !currentController.signal.aborted) {
          // Bad credentials, not a transient failure — retrying forever just
          // drains the battery with zero path to recovery (issue #76). Stop
          // and surface a distinct state instead; the sessions screen offers
          // a link to fix credentials, which reconnects via connect() once
          // saved.
          console.warn("[SSE] Authentication failed — stopping reconnect loop:", err)
          set({ connected: false, authError: true })
        } else {
          scheduleReconnect(err)
        }
      } finally {
        clearTimeout(stableTimer)
        if (currentController.signal.aborted) {
          console.log("[SSE] Disconnected (aborted)")
        }
      }
    })()
  },

  reconnectNow: () => {
    const connState = useConnections.getState()
    if (!connState.client) return
    console.log("[SSE] Foreground reconnect — re-establishing event stream")
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    controller?.abort()
    controller = null
    // Reset backoff state first: connect() gates its post-reconnect busy
    // resync on reconnectAttempts > 0, and a foreground resume must resync
    // even from a previously "stable" (but actually dead) connection — so we
    // run the resync explicitly below instead.
    set({ reconnectAttempts: 0, lastDisconnectAt: null })
    get().connect()
    void resyncBusySessions()
    const sessions = useSessions.getState()
    if (sessions.currentSession) {
      scheduleRefreshMessages()
      const session = sessions.currentSession
      const client = session.directory
        ? connState.clientForDirectory(session.directory) ?? connState.client
        : connState.client
      if (client) void refreshPending(client, session.id)
    }
  },

  setInferredActive: (map) => {
    // A status event that landed while the caller was computing is
    // authoritative — never stamp a guess over a session SSE has spoken for.
    const authoritative = get().sessionStatus
    const filtered = Object.fromEntries(Object.entries(map).filter(([id]) => !(id in authoritative)))
    set({ inferredActive: filtered })
  },

  disconnect: () => {
    console.log("[SSE] Disconnecting")
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    controller?.abort()
    controller = null
    erroredSessions.clear()
    abortedSessions.clear()
    // `sending` lives in the sessions store but is equally SSE-sourced: with
    // sessionStatus cleared here, a leftover optimistic flag would render a
    // phantom busy row in the active-first sessions list until the next
    // selectSession resets it.
    useSessions.setState({ sending: {} })
    set({
      connected: false,
      authError: false,
      reconnectAttempts: 0,
      lastDisconnectAt: null,
      sessionStatus: {},
      statusText: {},
      inferredActive: {},
      permissions: {},
      questions: {},
    })
  },
}))

AppState.addEventListener("change", (state) => {
  if (state === "active") void refreshAllPending()
})