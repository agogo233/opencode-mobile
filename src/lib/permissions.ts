export type PendingPermission = {
  id: string
  sessionID: string
  permission: string
  patterns: string[]
  metadata: Record<string, unknown>
  tool?: { messageID: string; callID: string }
  action?: string
  resources?: string[]
  save?: string[]
  source?: Record<string, unknown>
}

type PermissionEvent = {
  type?: string
  properties?: Record<string, unknown>
}

/** Normalize both generations of server permission request into the prompt model. */
export function normalizePermissionEvent(event: PermissionEvent): PendingPermission | null {
  if (event.type !== "permission.asked" && event.type !== "permission.v2.asked") return null
  const properties = event.properties
  if (!properties || typeof properties.id !== "string" || !properties.id ||
      typeof properties.sessionID !== "string" || !properties.sessionID) return null

  if (event.type === "permission.asked") {
    if (typeof properties.permission !== "string" || !Array.isArray(properties.patterns) ||
        !properties.patterns.every((item) => typeof item === "string")) return null
    return {
      id: properties.id,
      sessionID: properties.sessionID,
      permission: properties.permission,
      patterns: properties.patterns,
      metadata: isRecord(properties.metadata) ? properties.metadata : {},
      ...(isRecord(properties.tool) ? { tool: properties.tool as PendingPermission["tool"] } : {}),
    }
  }

  if (typeof properties.action !== "string" || !Array.isArray(properties.resources) ||
      !properties.resources.every((item) => typeof item === "string")) return null
  return {
    id: properties.id,
    sessionID: properties.sessionID,
    permission: properties.action,
    patterns: properties.resources,
    metadata: isRecord(properties.metadata) ? properties.metadata : {},
    action: properties.action,
    resources: properties.resources,
    ...(Array.isArray(properties.save) && properties.save.every((item) => typeof item === "string")
      ? { save: properties.save as string[] } : {}),
    ...(isRecord(properties.source) ? { source: properties.source } : {}),
  }
}

/** Convert a pending-list API item (which may be from either protocol generation). */
export function normalizePendingPermission(value: unknown): PendingPermission | null {
  if (!isRecord(value)) return null
  return normalizePermissionEvent({
    type: Array.isArray(value.resources) || typeof value.action === "string" ? "permission.v2.asked" : "permission.asked",
    properties: value,
  })
}

/** Field-wise equality for one pending permission. Nested records (metadata,
 * tool, source) are compared via JSON — this runs once per foreground resume
 * (not per streamed token), so stringify cost is fine here and it sidesteps
 * hand-rolling deep-equal for three rarely-changing shapes. */
export function pendingItemSame(a: PendingPermission, b: PendingPermission): boolean {
  return (
    a.id === b.id &&
    a.sessionID === b.sessionID &&
    a.permission === b.permission &&
    a.patterns.length === b.patterns.length &&
    a.patterns.every((v, i) => v === b.patterns[i]) &&
    JSON.stringify(a.metadata) === JSON.stringify(b.metadata) &&
    JSON.stringify(a.tool) === JSON.stringify(b.tool) &&
    JSON.stringify(a.action) === JSON.stringify(b.action) &&
    JSON.stringify(a.resources) === JSON.stringify(b.resources) &&
    JSON.stringify(a.save) === JSON.stringify(b.save) &&
    JSON.stringify(a.source) === JSON.stringify(b.source)
  )
}

/** Array-level content equality (same order, same items). */
export function pendingPermissionsSame(a: PendingPermission[], b: PendingPermission[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (!pendingItemSame(a[i], b[i])) return false
  return true
}

/** Merge incoming permission updates into the current list. Reference-stable:
 * items whose content didn't change keep their exact old object reference, and
 * when nothing at all changes (no new ids, no revised items) the ORIGINAL array
 * reference is returned — so zustand subscribers comparing references (e.g.
 * the session screen's useShallow selectors) see no change and skip re-render.
 * Foreground resume re-fetches the same pending list over and over; without
 * this, every resume allocated fresh arrays and woke both the chat screen and
 * the mounted-but-hidden sessions list. */
export function mergePendingPermissions(
  current: PendingPermission[], incoming: PendingPermission[],
): PendingPermission[] {
  const merged = new Map(current.map((item) => [item.id, item]))
  let changed = false
  for (const item of incoming) {
    const prev = merged.get(item.id)
    if (prev && pendingItemSame(prev, item)) continue
    merged.set(item.id, { ...prev, ...item })
    changed = true
  }
  // No revisions and no new ids (merge never removes) → same content, same
  // order (Map keeps current's insertion order) → hand back the old array.
  if (!changed && merged.size === current.length) return current
  return [...merged.values()]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}
