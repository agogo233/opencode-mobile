import { create } from "zustand"
import { ApiError, type Session, type Message, type Part, type Event, type MessageWithParts, type Client } from "../lib/sdk"
import { useConnections } from "./connections"
import { useSettings } from "./settings"
import { extractPromptFromParts, type PromptFromParts } from "../lib/prompt-from-parts"
import { mergeIncomingMessage } from "../lib/message-merge"
import { mergeFull, mergePaged, partSig } from "../lib/message-diff-merge"
import { isColdSessionLoad, isLiveEventForSession } from "../lib/session-load-reconcile"
import { inferActiveSessions } from "./events"

// Helper to convert API response to our internal format
function parseMessages(response: MessageWithParts[]): { messages: Message[]; parts: Record<string, Part[]> } {
  const messages: Message[] = []
  const parts: Record<string, Part[]> = {}

  for (const item of response || []) {
    messages.push(item.info)
    parts[item.info.id] = item.parts || []
  }

  return { messages, parts }
}

export function pageSize(): number {
  return useSettings.getState().pageSize
}

interface SessionsState {
  sessions: Session[]
  currentSession: Session | null
  messages: Message[]
  parts: Record<string, Part[]>
  isLoading: boolean
  // Per-session optimistic sending flag — bridging gap between user tap and SSE busy
  sending: Record<string, boolean>
  loadingMore: boolean
  hasMore: boolean
  error: string | null

  // Actions
  loadSessions: () => Promise<void>
  selectSession: (sessionID: string, directory?: string) => Promise<void>
  loadOlderMessages: () => Promise<void>
  createSession: (title?: string) => Promise<Session | null>
  deleteSession: (sessionID: string) => Promise<void>
  sendMessage: (
    text: string,
    model?: { providerID: string; modelID: string },
    agent?: string,
    files?: Array<{ uri: string; mime: string; filename?: string; base64?: string }>,
    variant?: string,
  ) => Promise<void>
  abortSession: () => Promise<void>
  refreshMessages: () => Promise<void>

  // Revert (edit sent message) / unrevert (undo the pending revert)
  revertToMessage: (messageID: string) => Promise<RevertResult>
  unrevertSession: () => Promise<void>

  // Event handling
  handleEvent: (event: Event) => void
}

export type RevertResult = ({ ok: true } & PromptFromParts) | { ok: false; reason: "unsupported" | "auth" | "error" }

// Sessions the user aborted since they last went busy. Mirrors events.ts's
// erroredSessions: SessionStatus has no "aborted" variant — an aborted run
// still ends with a busy -> idle transition — so without this mark a
// user-cancelled run would count as a success toward the store review
// prompt. events.ts (which already imports
// this module) clears entries on busy and checks them on busy -> idle.
export const abortedSessions = new Set<string>()

// Monotonic token guarding selectSession against out-of-order resolution: a
// slow fetch for a session the user has already navigated away from must not
// overwrite the messages/currentSession of a newer selection. Each call takes
// the next value and only commits its result if still the latest.
let selectSeq = 0

// Get the right client for a session's directory
function clientFor(directory?: string): Client | null {
  const connState = useConnections.getState()
  if (!directory) return connState.client
  const connDir = connState.activeConnection?.directory
  if (directory !== connDir) return connState.clientForDirectory(directory)
  return connState.client
}

export const useSessions = create<SessionsState>((set, get) => ({
  sessions: [],
  currentSession: null,
  messages: [],
  parts: {},
  isLoading: false,
  sending: {},
  loadingMore: false,
  hasMore: false,
  error: null,

  loadSessions: async () => {
    const connState = useConnections.getState()
    // Use a directory-less client so the server returns sessions from ALL projects,
    // not just the one matching the active connection's directory header.
    const client = connState.clientForDirectory(undefined) || connState.client
    if (!client) {
      set({ error: "errors.noActiveConnection" })
      return
    }

    try {
      set({ isLoading: true, error: null })
      // A directory-less list includes sessions across projects. Each row carries
      // its own directory into the session route so subsequent operations stay scoped.
      const sessions = await client.session.list({ roots: true, limit: 50 })
      set({ sessions, isLoading: false })
      // Fire-and-forget: cold-start marker for sessions that went busy before
      // the app opened — SSE never replays their busy event, so the list
      // infers "possibly running" from list data instead (see events.ts).
      void inferActiveSessions(sessions)
    } catch (error) {
      set({ error: "errors.loadSessions", isLoading: false })
    }
  },

  selectSession: async (sessionID, directory) => {
    // Use directory-specific client if the session belongs to a different project
    const connState = useConnections.getState()
    const client = directory ? connState.clientForDirectory(directory) : connState.client
    if (!client) {
      set({ error: "errors.noActiveConnection" })
      return
    }

    const seq = ++selectSeq
    // Re-selecting the session already shown on screen (e.g. #121's
    // useFocusEffect resync firing again on re-entry) is a background
    // refresh, not a cold load: the screen already has this session's
    // messages, and live SSE updates keep flowing to them the whole time.
    // Forcing isLoading back to true here would hide the entire
    // conversation — including anything streaming in live right now —
    // behind a spinner for as long as this redundant fetch takes, and if it
    // stalls (flaky network), the screen looks permanently stuck "loading"
    // until the user backs out and re-enters (issue #150). Only a
    // genuinely new/different session needs the blocking spinner.
    const isColdLoad = isColdSessionLoad(get().currentSession?.id, sessionID)
    try {
      // Reset optimistic sending — SSE sessionStatus is the source of truth
      set((state) => ({
        isLoading: isColdLoad ? true : state.isLoading,
        error: null,
        hasMore: false,
        loadingMore: false,
        sending: { ...state.sending, [sessionID]: false },
      }))

      const [session, messagesResponse] = await Promise.all([
        client.session.get(sessionID),
        client.session.messages(sessionID, { limit: pageSize() }),
      ])

      // A newer selectSession started while we were fetching — discard this
      // stale result so it can't clobber the newer selection.
      if (seq !== selectSeq) return

      // A warm re-focus re-renders the same session, so merge the fresh page
      // into what's already loaded (update + append, never delete — older
      // messages live outside the page). A cold load replaces outright so no
      // stale messages from a previous selection survive behind the spinner.
      const { messages, parts } = isColdLoad
        ? parseMessages(messagesResponse)
        : mergePaged(get().messages, get().parts, messagesResponse)

      set({
        currentSession: session,
        messages,
        parts,
        isLoading: false,
        // A full page means there are probably more — but only for a cold load.
        // A warm re-focus merges into history the user may have already fully
        // loaded, and re-deriving from this page's length alone would resurrect
        // the "load older" affordance they already exhausted.
        hasMore: isColdLoad
          ? messagesResponse.length >= pageSize()
          : get().hasMore && messagesResponse.length >= pageSize(),
      })
    } catch (err) {
      if (seq !== selectSeq) return
      console.error("Failed to load session:", err)
      set({ error: "errors.loadSession", isLoading: false })
    }
  },

  loadOlderMessages: async () => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) return
    if (get().loadingMore || !get().hasMore) return

    try {
      set({ loadingMore: true })

      // Fetch ALL messages for this session
      const response = await client.session.messages(session.id)
      // mergeFull keeps references for already-loaded messages (so the bubbles
      // that were on screen don't re-render just because older history arrived)
      // and preserves any temp/optimistic messages at the end.
      const { messages, parts } = mergeFull(get().messages, get().parts, response)

      set({
        messages,
        parts,
        loadingMore: false,
        hasMore: false, // We loaded everything
      })
    } catch (error) {
      console.error("Failed to load older messages:", error)
      set({ loadingMore: false })
    }
  },

  createSession: async (title) => {
    const connState = useConnections.getState()
    const client = connState.client
    if (!client) {
      set({ error: "errors.noActiveConnection" })
      return null
    }

    try {
      const created = await client.session.create({ title })
      // Don't optimistically add to sessions list — let loadSessions() handle it
      // to avoid duplicate key errors from race conditions
      set({
        currentSession: created,
        messages: [],
        parts: {},
        hasMore: false,
        loadingMore: false,
      })
      return created
    } catch (error) {
      set({ error: "errors.createSession" })
      return null
    }
  },

  deleteSession: async (sessionID) => {
    const session = get().sessions.find((s) => s.id === sessionID)
    const client = clientFor(session?.directory)
    if (!client) {
      set({ error: "errors.noActiveConnection" })
      return
    }

    try {
      await client.session.delete(sessionID)
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== sessionID),
        currentSession: state.currentSession?.id === sessionID ? null : state.currentSession,
        messages: state.currentSession?.id === sessionID ? [] : state.messages,
        parts: state.currentSession?.id === sessionID ? {} : state.parts,
      }))
    } catch (error) {
      set({ error: "errors.deleteSession" })
    }
  },

  sendMessage: async (text, model, agent, files, variant) => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) {
      set({ error: "errors.noActiveSession" })
      return
    }

    try {
      set((state) => ({ sending: { ...state.sending, [session.id]: true }, error: null }))

      // Add user message optimistically
      const ts = Date.now()
      const userMessage: Message = {
        id: `temp-${ts}`,
        sessionID: session.id,
        role: "user",
        time: { created: ts },
        model,
        agent,
      }
      const optimisticParts: Part[] = []
      if (text) {
        optimisticParts.push({
          id: `temp-part-text-${ts}`,
          messageID: userMessage.id,
          type: "text",
          text,
        })
      }
      if (files) {
        for (let i = 0; i < files.length; i++) {
          const f = files[i]
          optimisticParts.push({
            id: `temp-part-file-${ts}-${i}`,
            messageID: userMessage.id,
            type: "file",
            mime: f.mime,
            url: f.uri,
            filename: f.filename,
          })
        }
      }

      set((state) => ({
        messages: [...state.messages, userMessage],
        parts: { ...state.parts, [userMessage.id]: optimisticParts },
      }))

      // Build prompt parts - images are already converted to JPEG with base64 by toJpeg()
      const promptParts: Array<
        { type: "text"; text: string } | { type: "file"; mime: string; url: string; filename?: string }
      > = []
      if (text) {
        promptParts.push({ type: "text", text })
      }
      if (files) {
        for (const f of files) {
          const url = f.base64 ? `data:${f.mime};base64,${f.base64}` : f.uri
          promptParts.push({ type: "file", mime: f.mime, url, filename: f.filename })
        }
      }

      // Await submission (POST to /prompt_async resolves fast, well before the
      // streamed response) so a failure here can propagate to the caller — SSE
      // events still update messages/parts/status in real-time on success.
      await client.session.prompt(session.id, { parts: promptParts, model, agent, variant })
    } catch (err) {
      console.error("[sendMessage] error:", err)
      const stillCurrent = get().currentSession?.id === session.id
      set((state) => ({
        ...(stillCurrent ? { error: String(err) } : {}),
        sending: { ...state.sending, [session.id]: false },
      }))
      if (stillCurrent) scheduleRefreshMessages()
      throw err
    }
  },

  abortSession: async () => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) return

    try {
      await client.session.abort(session.id)
      // Mark only after the abort request succeeded — if it failed, the run
      // continues and any eventual completion is a genuine response.
      abortedSessions.add(session.id)
      set((state) => ({ sending: { ...state.sending, [session.id]: false } }))
    } catch {
      set({ error: "errors.abortSession" })
    }
  },

  refreshMessages: async () => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) return

    try {
      // Bounded page, not the whole timeline: foreground resumes, busy→idle
      // and error transitions all funnel here, and each of those moments is
      // exactly when the user is peering at the screen. Re-fetching every page
      // of a long history (plus diffing it all synchronously) right then is
      // what used to stall the UI on return to the app. A single recent page
      // is enough to surface what changed while away; the merge is
      // additive/update-only so already-loaded older messages (which live
      // outside this page) are never dropped.
      const response = await client.session.messages(session.id, { limit: Math.max(1, pageSize()) })
      // A degenerate empty response (transient server hiccup, pagination edge)
      // would tell mergePaged to append nothing (harmless) but merging still
      // churns every changed signature on the JS thread for zero gain. Skip
      // rather than churn — the next successful refresh reconciles for real.
      if (!response?.length && get().messages.length > 0) return
      const prevCount = get().messages.length
      const { messages, parts } = mergePaged(get().messages, get().parts, response)
      set({
        messages,
        parts,
        // A paged refresh only ever touches the newest window. If it appended
        // messages the user hasn't loaded yet (a long task finished while the
        // app was away and added more than a page), the gap between the loaded
        // history and this new tail can only be backfilled by loadOlderMessages'
        // full merge — re-arm its trigger instead of leaving a permanent hole
        // under a hasMore that a prior scroll-to-bottom had set false.
        hasMore: messages.length > prevCount ? true : get().hasMore,
      })
    } catch (error) {
      set({ error: "errors.refreshMessages" })
    }
  },

  // Marks messageID (and everything after it) as pending revert, so the
  // user can re-edit and resend it. The server keeps the underlying
  // messages until the next prompt runs cleanup, or unrevertSession() below
  // undoes it — so this only flips session.revert, it doesn't delete
  // anything itself. Returns the reverted message's text/files so the
  // caller can prefill the composer.
  revertToMessage: async (messageID) => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) return { ok: false, reason: "error" }

    try {
      const updated = await client.session.revert(session.id, messageID)
      set((state) => ({
        currentSession: state.currentSession?.id === session.id ? updated : state.currentSession,
      }))
      return { ok: true, ...extractPromptFromParts(get().parts[messageID]) }
    } catch (err) {
      if (err instanceof ApiError) {
        // Older servers (pre session.revert) 404 on this route — degrade
        // gracefully instead of surfacing a generic error.
        if (err.status === 404) return { ok: false, reason: "unsupported" }
        // Expired/invalid credentials — distinct from a generic failure so
        // the caller can point the user at reconnecting rather than "retry".
        if (err.status === 401 || err.status === 403) return { ok: false, reason: "auth" }
      }
      console.error("Failed to revert message:", err)
      set({ error: "errors.revertMessage" })
      return { ok: false, reason: "error" }
    }
  },

  unrevertSession: async () => {
    const client = clientFor(get().currentSession?.directory)
    const session = get().currentSession
    if (!client || !session) return

    try {
      const updated = await client.session.unrevert(session.id)
      set((state) => ({
        currentSession: state.currentSession?.id === session.id ? updated : state.currentSession,
      }))
    } catch (err) {
      console.error("Failed to unrevert session:", err)
      set({ error: "errors.restoreRevertedMessages" })
    }
  },

  handleEvent: (event) => {
    const { currentSession } = get()
    if (!currentSession) return

    const props = (event as any).properties || {}

    switch (event.type) {
      case "message.updated": {
        const message = (props.info || props.message) as Message | undefined
        if (!message || !isLiveEventForSession(message.sessionID, currentSession.id)) return

        set((state) => ({
          messages: mergeIncomingMessage(state.messages, message),
          // A live update for the session on screen is proof it has content
          // to show — clear any stuck spinner even if the initial (or a
          // redundant re-focus) GET hasn't resolved yet, or never does
          // (issue #150). Only ever clears, never sets it back to true.
          isLoading: false,
        }))
        break
      }

      case "message.part.updated": {
        const part = props.part as Part | undefined
        if (!part) return
        // Only handle parts for current session
        if (part.sessionID && part.sessionID !== currentSession.id) return

        set((state) => {
          const messageParts = state.parts[part.messageID] || []
          const existing = messageParts.find((p) => p.id === part.id)

          // Cheap dedup: a re-pushed part whose content is byte-identical to
          // the stored one changes nothing (it happens on reconnect replays /
          // duplicate SSE events). Short-circuit on the cheap scalars first —
          // text grows every token during streaming, and tool parts change
          // callID/status on real updates (their text is always undefined) —
          // so the hot path exits in O(1) without touching partSig's stringify.
          // Only when all cheap fields match do we pay for the full signature
          // comparison. Returning a partial that keeps `parts` reference
          // unchanged means no subscriber re-renders. NOTE: the store's whole
          // sessions-store subscribers still wake (state object is new) but
          // selector-based rows bail on the unchanged parts reference.
          if (
            existing &&
            existing.text === part.text &&
            existing.callID === part.callID &&
            existing.state?.status === part.state?.status &&
            partSig(existing) === partSig(part)
          ) {
            return state.isLoading ? { isLoading: false } : { parts: state.parts }
          }

          return {
            parts: {
              ...state.parts,
              [part.messageID]: existing
                ? messageParts.map((p) => (p.id === part.id ? part : p))
                : [...messageParts, part],
            },
            // See message.updated above — a live part update is just as
            // much proof of life as a message update.
            isLoading: false,
          }
        })
        break
      }

      case "message.removed": {
        const messageID = props.messageID as string
        if (!messageID) return
        set((state) => ({
          messages: state.messages.filter((m) => m.id !== messageID),
          parts: Object.fromEntries(Object.entries(state.parts).filter(([k]) => k !== messageID)),
        }))
        break
      }

      case "session.updated": {
        const session = (props.info || props) as Session | undefined
        if (!session?.id) return

        set((state) => ({
          sessions: state.sessions.map((s) => (s.id === session.id ? session : s)),
          currentSession: state.currentSession?.id === session.id ? session : state.currentSession,
          isLoading: isLiveEventForSession(session.id, state.currentSession?.id) ? false : state.isLoading,
        }))
        break
      }
    }
  },
}))

// Foreground resume fans several refresh triggers into a few hundred
// milliseconds — the SSE reconnect (reconnectNow), the busy-session resync, a
// session.status busy->idle landing, and a session.error. Each one used to fire
// its own full-timeline fetch, so the app could issue 3-4 identical expensive
// requests and replace the message table that many times on a single return to
// the app — a big chunk of the "janky on foreground" feel.
//
// Coalesce them: at most one refresh runs per window, and if a fetch is already
// in flight the window's calls collapse into a single trailing run so whatever
// changed while it was fetching is still picked up (no lost final state).
// Trailing-only keeps it to one request per window; the ~300ms delay is
// imperceptible for a background resync (the on-screen session's live updates
// come from SSE regardless).
const REFRESH_COALESCE_MS = 300
let refreshRunning = false
let refreshQueued = false
let refreshTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleRefreshMessages(): void {
  if (refreshTimer || refreshRunning) {
    refreshQueued = true
    return
  }
  refreshTimer = setTimeout(() => {
    refreshTimer = null
    refreshQueued = false
    refreshRunning = true
    void Promise.resolve()
      .then(() => useSessions.getState().refreshMessages())
      .catch(() => {})
      .then(() => {
        refreshRunning = false
        // Another window's worth of triggers landed while we were fetching.
        if (refreshQueued) scheduleRefreshMessages()
      })
  }, REFRESH_COALESCE_MS)
}
