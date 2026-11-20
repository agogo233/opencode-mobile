import { create } from "zustand"
import * as SecureStore from "expo-secure-store"
import * as Crypto from "expo-crypto"
import type { ServerConnection, ConnectionType } from "../lib/types"
import { createClient, probeServer, type Client, type Project } from "../lib/sdk"
import type { ServerApi } from "../lib/api-detect"
import { buildAuth } from "../lib/auth"
import { stripTrailingSlash } from "../lib/path-utils"
import i18n from "../lib/i18n/config"
import { resolveBaseUrl as resolveClientBaseUrl, TailscaleUnavailableError } from "../lib/resolve-base-url"
import { directTargetFromUrl } from "../lib/direct-target"
import { tailscaleNative } from "../lib/tailscale"
import { useTailscale } from "./tailscale"
import { shouldAwaitNodeRetry } from "../lib/tailscale-policy"

const CONNECTIONS_KEY = "opencode_connections"
const PASSWORDS_PREFIX = "opencode_password_"
const RECENT_DIRS_KEY = "opencode_recent_dirs"
const MAX_RECENT_DIRS = 10
// A bad IP (unreachable host, wrong port) otherwise hangs for the full 30s
// general request timeout before the user sees a "connection failed" error —
// a first-run bounce driver. The interactive connect flow can afford to fail
// faster since a real server responds to /global/health in well under a
// second; this does NOT affect the timeout used for real session traffic.
const CONNECTION_TEST_TIMEOUT_MS = 12_000
// Cold-start client builds race the node's first connect (keyless approval
// can legitimately take a while). Bound how long a failed build waits for
// the node before reporting the tunnel as unavailable. Aligned with the Go
// side's enrollment connect window (enrollmentConnectTimeout) so a pending
// keyless approval is not given up on early. Waiting is safe: it only
// observes native status, and a user-driven start/stop interrupts it via the
// reported phase.
const NODE_CONNECT_WAIT_MS = 900_000

// Cached auth so we can create directory-scoped clients without async SecureStore lookups
interface ClientBase {
  baseUrl: string
  auth?: { username: string; password: string }
  api?: ServerApi
}

interface ConnectionsState {
  connections: ServerConnection[]
  activeConnection: ServerConnection | null
  client: Client | null
  clientBase: ClientBase | null
  currentProject: Project | null
  serverHome: string | null // Home directory on the server machine (for ~ expansion)
  recentDirectories: string[]
  isLoading: boolean
  // True while the active tailscale connection waits for the embedded node
  // and its loopback forward to come up (first paint must not block on it).
  tailscaleConnecting: boolean
  error: string | null

  // Actions
  loadConnections: () => Promise<void>
  addConnection: (connection: Omit<ServerConnection, "id">, password?: string) => Promise<void>
  removeConnection: (id: string) => Promise<void>
  setActiveConnection: (id: string) => Promise<void>
  testConnection: (connection: ServerConnection, password?: string) => Promise<{ ok: boolean; api?: ServerApi; serverVersion?: string; error?: string; probeUrl?: string }>
  updateConnection: (id: string, updates: Partial<ServerConnection>, password?: string) => Promise<void>
  refreshProject: () => Promise<void>
  // Create a one-off client pointing at a specific directory (for cross-project operations).
  // Pass undefined to get a directory-less client that queries the server without project scope.
  clientForDirectory: (directory?: string) => Client | null
  // Switch the active connection's directory and reload
  switchDirectory: (directory?: string) => Promise<void>
  // Record a directory as recently used
  addRecentDirectory: (directory: string) => Promise<void>
}

function generateId(): string {
  return Crypto.randomUUID().replace(/-/g, "").slice(0, 16)
}

// Resolve the URL a client should actually talk to. Tailscale-type
// connections go through the embedded tsnet node (auto-starting it when
// needed); every other type connects to the configured URL directly.
// Fails closed: when the tunnel is unavailable the caller gets a
// TailscaleUnavailableError (localized) instead of a direct, untunneled URL.
async function resolveBaseUrl(connection: Pick<ServerConnection, "type" | "url">): Promise<string> {
  const tailscale = useTailscale.getState()
  if (connection.type === "tailscale" && tailscale.directMode) {
    // Direct-connect mode: talk to the server URL itself; the native network
    // stack routes this registered target through the embedded node. The
    // registration lands before the first request rides this connection.
    const ok = await tailscale.ensureDirectTarget(connection.url)
    if (!ok) throw new TailscaleUnavailableError(i18n.t("errors.tailscaleUnavailable"))
    return connection.url
  }
  try {
    return await resolveClientBaseUrl(connection, useTailscale.getState().ensureForward)
  } catch (error) {
    if (error instanceof TailscaleUnavailableError) {
      throw new TailscaleUnavailableError(i18n.t("errors.tailscaleUnavailable"))
    }
    throw error
  }
}

function buildClient(
  url: string,
  directory?: string,
  auth?: { username: string; password: string },
  api?: ServerApi,
): { client: Client; base: ClientBase } {
  const base: ClientBase = { baseUrl: url, auth, api }
  const client = createClient({ baseUrl: url, directory, auth, api })
  return { client, base }
}

// Decide which transport a connection needs. A recorded probe is reused; a
// connection saved before this existed (or saved while the server was down) is
// probed once here and the answer is written back onto the stored record. When
// the probe cannot classify the server we keep the previous behaviour (v2)
// instead of refusing to load a connection the user can still see and edit.
async function resolveApi(
  connection: ServerConnection,
  auth?: { username: string; password: string },
  baseUrl?: string,
): Promise<{ api?: ServerApi; resolved: boolean }> {
  if (connection.api) return { api: connection.api, resolved: false }
  try {
    const identity = await probeServer({ baseUrl: baseUrl ?? connection.url, directory: connection.directory, auth })
    connection.api = identity.api
    connection.serverVersion = identity.version
    return { api: identity.api, resolved: true }
  } catch {
    return { api: undefined, resolved: false }
  }
}

// Fetch /project/current + /path AFTER the client is published to the store,
// so the SSE stream (which keys off `client` appearing) is not serialized
// behind two metadata requests it doesn't need (#189). `isCurrent` guards
// against a stale response clobbering state after a server switch mid-fetch:
// the metadata only lands if this client is still the active one.
async function fetchMetadataBehind(
  client: Client,
  isCurrent: () => boolean,
  apply: (project: Project | null, home: string | null) => void,
): Promise<void> {
  try {
    const [proj, paths] = await Promise.all([
      client.project.current().catch(() => null),
      client.path.get().catch(() => null),
    ])
    if (!isCurrent()) return
    apply(proj, paths?.home ?? null)
  } catch {
    // Server might be offline — metadata stays null, the client still works.
  }
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  connections: [],
  activeConnection: null,
  client: null,
  clientBase: null,
  serverHome: null,
  currentProject: null,
  recentDirectories: [],
  isLoading: true,
  tailscaleConnecting: false,
  error: null,

  loadConnections: async () => {
    try {
      set({ isLoading: true, error: null })
      const [stored, recentRaw] = await Promise.all([
        SecureStore.getItemAsync(CONNECTIONS_KEY),
        SecureStore.getItemAsync(RECENT_DIRS_KEY),
      ])
      const connections: ServerConnection[] = stored ? JSON.parse(stored) : []
      const recentDirectories: string[] = recentRaw ? JSON.parse(recentRaw) : []

      // Find active connection
      const active = connections.find((c) => c.active) || null

      // A tailscale active connection must not block first paint on node
      // bring-up (which can take up to a minute when the tailnet is slow or
      // unreachable). Render immediately with an explicit "connecting via
      // Tailscale" indicator; the client is built in the background once the
      // loopback forward is ready.
      if (active?.type === "tailscale") {
        const buildTailscaleClient = async (allowNodeWait: boolean = true) => {
          try {
            // Auto-start needs the persisted identity; loadConfig may still
            // be in flight on cold start, so make sure it has run.
            const ts = useTailscale.getState()
            if (!ts.configLoaded) await ts.loadConfig()
            const password = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${active.id}`)
            const auth = buildAuth(active.username, password)
            const baseUrl = await resolveBaseUrl(active)
            // The bring-up window can last a minute or more; the user may have
            // edited or switched connections in the meantime. Only proceed if
            // the stored record still matches what this build was started for.
            const current = get().connections.find((c) => c.id === active.id)
            if (!current || current.url !== active.url || current.directory !== active.directory) return
            const { api, resolved } = await resolveApi(current, auth, baseUrl)
            const built = buildClient(baseUrl, current.directory, auth, api)
            if (resolved) {
              // Merge only this connection's probe fields into the latest
              // stored list — a whole-list write-back of the cold-start
              // snapshot would roll back edits made while the node came up.
              const raw = await SecureStore.getItemAsync(CONNECTIONS_KEY)
              const latest: ServerConnection[] = raw ? JSON.parse(raw) : connections
              const idx = latest.findIndex((c) => c.id === current.id)
              if (idx >= 0) {
                latest[idx] = { ...latest[idx], api: current.api, serverVersion: current.serverVersion }
                await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(latest))
              }
            }
            let project: Project | null = null
            let home: string | null = null
            try {
              const [proj, paths] = await Promise.all([
                built.client.project.current().catch(() => null),
                built.client.path.get().catch(() => null),
              ])
              project = proj
              home = paths?.home || null
            } catch {
              // Server might be offline
            }
            // The user may have switched connections while the node was coming
            // up; only apply results that still belong to the active one.
            if (get().activeConnection?.id !== active.id) return
            set({
              client: built.client,
              clientBase: built.base,
              currentProject: project,
              serverHome: home,
              tailscaleConnecting: false,
            })
          } catch (error) {
            if (get().activeConnection?.id !== active.id) return
            // A cold start races the node's first connect: the build fails
            // while the node is still "connecting" (keyless approval, slow
            // tailnet) and, without this wait, the client would stay null
            // forever — nothing re-triggers loadConnections after it returns,
            // so the home session list would never load until the next app
            // launch. Wait for the node once, then rebuild. Everything else
            // (user stop, node error, missing config) reports as before.
            if (allowNodeWait && error instanceof TailscaleUnavailableError) {
              const status = await tailscaleNative()?.status().catch(() => null)
              if (shouldAwaitNodeRetry(status?.phase)) {
                set({ tailscaleConnecting: true, error: null })
                const connected = await useTailscale.getState().waitForConnected(NODE_CONNECT_WAIT_MS)
                if (get().activeConnection?.id === active.id) {
                  if (connected) return buildTailscaleClient(false)
                  set({
                    client: null,
                    clientBase: null,
                    tailscaleConnecting: false,
                    error: error.message,
                  })
                }
                return
              }
            }
            set({
              client: null,
              clientBase: null,
              tailscaleConnecting: false,
              error: error instanceof TailscaleUnavailableError ? error.message : "errors.loadConnections",
            })
          }
        }
        set({
          connections,
          activeConnection: active,
          client: null,
          clientBase: null,
          currentProject: null,
          serverHome: null,
          recentDirectories,
          isLoading: false,
          tailscaleConnecting: true,
        })
        void buildTailscaleClient()
        return
      }

      // Create client for active connection
      let client: Client | null = null
      let base: ClientBase | null = null
      if (active) {
        const password = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${active.id}`)
        const auth = buildAuth(active.username, password)
        // resolveBaseUrl() maps a Tailscale connection to its local forwarder
        // URL (no-op for direct URLs). The resolveApi() probe stays BEFORE
        // the publish: it chooses which client to build, so #189's split
        // starts after the client exists.
        const baseUrl = await resolveBaseUrl(active)
        const { api, resolved } = await resolveApi(active, auth, baseUrl)
        const built = buildClient(baseUrl, active.directory, auth, api)
        client = built.client
        base = built.base
        // Persist a probe that was only just discovered, so the next launch
        // picks the same transport without probing again.
        if (resolved) await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
      }

      // Publish the client immediately — the SSE stream starts off this, and
      // must not wait on the metadata fetches below (#189).
      set({
        connections,
        activeConnection: active,
        client,
        clientBase: base,
        currentProject: null,
        serverHome: null,
        recentDirectories,
        isLoading: false,
        tailscaleConnecting: false,
      })

      // Metadata fills in behind the publish, guarded so a stale response
      // can't clobber state after a server switch mid-fetch.
      if (active && client) {
        const requestClient = client
        void fetchMetadataBehind(requestClient, () => get().client === requestClient, (proj, home) =>
          set({ currentProject: proj, serverHome: home }),
        )
      }
    } catch (error) {
      set({ error: "errors.loadConnections", isLoading: false, tailscaleConnecting: false })
    }
  },

  addConnection: async (connection, password) => {
    const id = generateId()
    const newConnection: ServerConnection = {
      ...connection,
      id,
      active: get().connections.length === 0, // First connection is active
    }

    const connections = [...get().connections, newConnection]

    // Store password separately if provided
    if (password) {
      await SecureStore.setItemAsync(`${PASSWORDS_PREFIX}${id}`, password)
    }

    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))

    // If this is the first/active connection, create client
    let client = get().client
    let base = get().clientBase
    let activeConnection = get().activeConnection

    let project = get().currentProject
    let serverHome = get().serverHome

    if (newConnection.active) {
      activeConnection = newConnection
      try {
        const auth = buildAuth(newConnection.username, password)
        const baseUrl = await resolveBaseUrl(newConnection)
        const { api } = await resolveApi(newConnection, auth, baseUrl)
        const built = buildClient(baseUrl, newConnection.directory, auth, api)
        client = built.client
        base = built.base

        // Fetch server metadata so loadSessions can use clientForDirectory(serverHome)
        // immediately after the connection is added (same as setActiveConnection does).
        try {
          const [proj, paths] = await Promise.all([
            client.project.current().catch(() => null),
            client.path.get().catch(() => null),
          ])
          project = proj
          serverHome = paths?.home || null
        } catch {
          // Server might be unreachable; proceed without metadata
        }
      } catch (error) {
        // The connection is already persisted at this point — keep it and let
        // the UI show the tunnel problem instead of failing the save (which
        // would invite a duplicate retry).
        if (!(error instanceof TailscaleUnavailableError)) throw error
        client = null
        base = null
        project = null
        serverHome = null
      }
    }

    set({
      connections,
      activeConnection,
      client,
      clientBase: base,
      currentProject: project,
      serverHome,
      ...(newConnection.active ? { tailscaleConnecting: false } : {}),
    })
  },

  removeConnection: async (id) => {
    const removed = get().connections.find((c) => c.id === id)
    const connections = get().connections.filter((c) => c.id !== id)

    // Drop the removed server from the direct-connect allowlist so deleted
    // targets stop routing through the embedded node — unless another
    // connection still points at the same target.
    if (removed?.type === "tailscale") {
      const target = directTargetFromUrl(removed.url)
      if (target && !connections.some((c) => c.type === "tailscale" && directTargetFromUrl(c.url) === target)) {
        void tailscaleNative()?.unregisterDirectHost(target).catch(() => {})
      }
    }

    // Remove stored password
    await SecureStore.deleteItemAsync(`${PASSWORDS_PREFIX}${id}`)
    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))

    // If removing active connection, clear client
    const wasActive = get().activeConnection?.id === id
    if (wasActive) {
      const newActive = connections[0] || null
      if (newActive) {
        // Mark new connection as active
        newActive.active = true
        await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
        try {
          const password = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${newActive.id}`)
          const auth = buildAuth(newActive.username, password)
          const baseUrl = await resolveBaseUrl(newActive)
          const { api, resolved } = await resolveApi(newActive, auth, baseUrl)
          const built = buildClient(baseUrl, newActive.directory, auth, api)
          if (resolved) await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
          set({ connections, activeConnection: newActive, client: built.client, clientBase: built.base, tailscaleConnecting: false })
        } catch (error) {
          if (!(error instanceof TailscaleUnavailableError)) throw error
          set({
            connections,
            activeConnection: newActive,
            client: null,
            clientBase: null,
            currentProject: null,
            serverHome: null,
            tailscaleConnecting: false,
          })
        }
      } else {
        set({ connections, activeConnection: null, client: null, clientBase: null, tailscaleConnecting: false })
      }
      // Switching away from the embedded node: drop the now-unused loopback
      // forward so it does not linger for the lifetime of the node.
      if (newActive?.type !== "tailscale") void useTailscale.getState().releaseForward()
    } else {
      set({ connections })
    }
  },

  setActiveConnection: async (id) => {
    const connections = get().connections.map((c) => ({
      ...c,
      active: c.id === id,
    }))

    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))

    const active = connections.find((c) => c.id === id) || null
    let client: Client | null = null
    let base: ClientBase | null = null
    let project: Project | null = null
    let home: string | null = null

    if (active) {
      const password = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${active.id}`)
      const auth = buildAuth(active.username, password)
      try {
        const baseUrl = await resolveBaseUrl(active)
        const { api } = await resolveApi(active, auth, baseUrl)
        const built = buildClient(baseUrl, active.directory, auth, api)
        client = built.client
        base = built.base

        try {
          const [proj, paths] = await Promise.all([
            client.project.current().catch(() => null),
            client.path.get().catch(() => null),
          ])
          project = proj
          home = paths?.home || null
        } catch {
          // Server might be offline
        }
      } catch (error) {
        // Selecting a tailscale connection while its tunnel is down: keep the
        // selection (banner/diagnostics will explain) instead of crashing the
        // tap handler with an unhandled rejection.
        if (!(error instanceof TailscaleUnavailableError)) throw error
      }

      // Update last connected time
      active.lastConnected = Date.now()
      await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
    }

    if (active?.type !== "tailscale") void useTailscale.getState().releaseForward()

    set({
      connections,
      activeConnection: active,
      client,
      clientBase: base,
      currentProject: project,
      serverHome: home,
      tailscaleConnecting: false,
    })
    if (active && client) {
      const requestClient = client
      void fetchMetadataBehind(requestClient, () => get().client === requestClient, (proj, home) => {
        set({ currentProject: proj, serverHome: home })
      })
    }
  },

  testConnection: async (connection, password) => {
    try {
      const auth = buildAuth(connection.username, password)
      // Tailscale-type connections probe the loopback forward (auto-starting
      // the embedded node); everything else probes the configured URL.
      const baseUrl = await resolveBaseUrl(connection)
      // Probe before anything else. Against a v1 server the v2 health route is not
      // a route at all — it falls through to the web SPA and answers 200 with HTML,
      // which used to read as "connected" and then failed on every real request.
      const identity = await probeServer({ baseUrl, directory: connection.directory, auth })
      const client = createClient({
        baseUrl,
        directory: connection.directory,
        auth,
        api: identity.api,
      })

      await client.global.health(CONNECTION_TEST_TIMEOUT_MS)
      return { ok: true, api: identity.api, serverVersion: identity.version, probeUrl: baseUrl }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message }
    }
  },

  updateConnection: async (id, updates, password) => {
    const previous = get().connections.find((c) => c.id === id)
    const connections = get().connections.map((c) => {
      if (c.id !== id) return c
      const merged = { ...c, ...updates }
      // A different URL is a different server: drop the recorded probe so the
      // next client build re-detects the transport instead of reusing the
      // previous server's answer.
      if (updates.url !== undefined && updates.url !== c.url) {
        merged.api = undefined
        merged.serverVersion = undefined
      }
      return merged
    })

    await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))

    // A different URL is a different direct-connect target: retire the old
    // one from the allowlist (the new URL registers on next use) unless
    // another connection still points at it.
    if (
      previous?.type === "tailscale" &&
      updates.url !== undefined &&
      updates.url !== previous.url
    ) {
      const oldTarget = directTargetFromUrl(previous.url)
      if (oldTarget && !connections.some((c) => c.type === "tailscale" && directTargetFromUrl(c.url) === oldTarget)) {
        void tailscaleNative()?.unregisterDirectHost(oldTarget).catch(() => {})
      }
    }

    // Persist a new password only when one was entered. The edit form loads the
    // password field blank (passwords aren't read back for security), so an
    // empty value means "keep the existing password", not "clear it". Written
    // before the active-client rebuild below so the rebuilt client picks it up.
    if (password) {
      await SecureStore.setItemAsync(`${PASSWORDS_PREFIX}${id}`, password)
    }

    // If updating active connection, recreate client
    if (get().activeConnection?.id === id) {
      const active = connections.find((c) => c.id === id)!
      const password = await SecureStore.getItemAsync(`${PASSWORDS_PREFIX}${id}`)
      const auth = buildAuth(active.username, password)
      try {
        const baseUrl = await resolveBaseUrl(active)
        const { api, resolved } = await resolveApi(active, auth, baseUrl)
        const built = buildClient(baseUrl, active.directory, auth, api)
        if (resolved) await SecureStore.setItemAsync(CONNECTIONS_KEY, JSON.stringify(connections))
        try {
          const [project, paths] = await Promise.all([
            built.client.project.current().catch(() => null),
            built.client.path.get().catch(() => null),
          ])
          set({
            connections,
            activeConnection: active,
            client: built.client,
            clientBase: built.base,
            currentProject: project,
            serverHome: paths?.home || null,
            tailscaleConnecting: false,
          })
        } catch {
          set({
            connections,
            activeConnection: active,
            client: built.client,
            clientBase: built.base,
            currentProject: null,
            tailscaleConnecting: false,
          })
        }
      } catch (error) {
        // Edits to a tailscale connection are saved even when its tunnel is
        // down; the rebuilt client simply waits for the node to come back.
        if (!(error instanceof TailscaleUnavailableError)) throw error
        set({
          connections,
          activeConnection: active,
          client: null,
          clientBase: null,
          currentProject: null,
          serverHome: null,
          tailscaleConnecting: false,
        })
      }
    } else {
      set({ connections })
    }
  },

  refreshProject: async () => {
    const client = get().client
    if (!client) return

    try {
      const project = await client.project.current()
      set({ currentProject: project })
    } catch {
      set({ currentProject: null })
    }
  },

  clientForDirectory: (directory) => {
    const base = get().clientBase
    if (!base) return null
    // Reuse current client if directory matches
    const active = get().activeConnection
    if (active?.directory === directory) return get().client
    return createClient({ baseUrl: base.baseUrl, directory, auth: base.auth, api: base.api })
  },

  switchDirectory: async (directory) => {
    const active = get().activeConnection
    if (!active) return
    // Update connection directory and recreate client. Normalize trailing
    // slashes so "/home/user" and "/home/user/" don't diverge (recent-dir
    // duplicates + a mismatched "current directory" highlight).
    const trimmed = directory?.trim()
    const dir = trimmed ? stripTrailingSlash(trimmed) : undefined
    await get().updateConnection(active.id, { directory: dir })
    // Record in recents if it's a real directory
    if (dir) await get().addRecentDirectory(dir)
  },

  addRecentDirectory: async (directory) => {
    const current = get().recentDirectories
    // Normalize trailing slashes so the same dir entered as ".../x" and
    // ".../x/" dedups to one recent-list entry instead of two.
    directory = stripTrailingSlash(directory.trim())
    // Move to front, dedup, cap at MAX
    const updated = [directory, ...current.filter((d) => d !== directory)].slice(0, MAX_RECENT_DIRS)
    set({ recentDirectories: updated })
    await SecureStore.setItemAsync(RECENT_DIRS_KEY, JSON.stringify(updated))
  },
}))