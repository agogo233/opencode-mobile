import type { Message, MessageWithParts, Part } from "./sdk"

/**
 * Stable signatures for diffing refreshed server data against what's already
 * in the store.
 *
 * Why signatures instead of object identity: every fetch produces brand-new
 * objects, so identity comparison always reports "changed" — that's what made
 * the old refresh replace the ENTIRE messages/parts tables (breaking
 * MessageBubble's memo and re-rendering every bubble). A signature built from
 * the fields the server can actually revise lets an unchanged message keep its
 * exact old reference, so unchanged bubbles never re-render.
 */
function messageSig(m: Message): string {
  return JSON.stringify([
    m.time?.created,
    m.time?.completed,
    m.agent,
    m.model,
    m.modelID,
    m.providerID,
    m.cost,
    m.tokens,
    m.error,
    m.finish,
  ])
}

// Exported so stores can dedupe identical re-pushed parts cheaply
// (see sessions.ts handleEvent): a part whose signature matches the already
// stored one is a duplicate, not a change.
export function partSig(p: Part): string {
  return JSON.stringify([p.id, p.type, p.text, p.tool, p.callID, p.state, p.time, p.mime, p.url, p.filename])
}

/** Two messages are "the same content" if id, role and every revisable field match. */
function messageSame(a: Message, b: Message): boolean {
  return a.id === b.id && a.role === b.role && messageSig(a) === messageSig(b)
}

/** Two part arrays are "the same content" (order + signatures). */
function partsSame(a: Part[] | undefined, b: Part[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (partSig(a[i]) !== partSig(b[i])) return false
  return true
}

export interface DiffResult {
  messages: Message[]
  parts: Record<string, Part[]>
}

/**
 * Full refresh merge — the authoritative variant used by refreshMessages()
 * (the no-limit fetch that mirrors the whole timeline).
 *
 * Server is authoritative, but references are preserved for anything that
 * didn't actually change, so the chat list only re-renders real updates:
 * - unchanged (id + content) messages keep their old object/parts references;
 * - genuinely changed messages adopt the fresh server object;
 * - messages present locally but absent server-side are REMOVED (strict delete
 *   sync) — the server is the truth for a full timeline, and this is what
 *   reconciles deletions missed while offline (revert cleanup, message.removed);
 * - optimistic `temp-` messages are always kept (the server hasn't echoed them
 *   yet) and always sort last, matching the rest of the store's ordering.
 */
export function mergeFull(
  prevMessages: Message[],
  prevParts: Record<string, Part[]>,
  refreshed: MessageWithParts[],
): DiffResult {
  const prevById = new Map(prevMessages.map((m) => [m.id, m]))
  const temp = prevMessages.filter((m) => m.id.startsWith("temp-"))

  const messages: Message[] = []
  const parts: Record<string, Part[]> = {}

  for (const item of refreshed || []) {
    const server = item.info
    const prev = prevById.get(server.id)
    // Content-identical message keeps its old parts reference when those parts
    // also match — otherwise adopt the fresh server parts (real change).
    const keptUnchanged =
      prev &&
      messageSame(prev, server) &&
      partsSame(prevParts[server.id], item.parts)
    if (keptUnchanged) {
      messages.push(prev!)
      parts[server.id] = prevParts[server.id]
    } else {
      messages.push(server)
      parts[server.id] = item.parts || []
    }
  }

  for (const t of temp) {
    messages.push(t)
    parts[t.id] = prevParts[t.id] || []
  }

  return { messages, parts }
}

/**
 * Paged refresh merge — the non-destructive variant used by selectSession()
 * when re-focusing the session already on screen.
 *
 * A paged fetch returns only the most recent page, so we must NOT treat
 * "absent from this page" as "deleted": older messages the user already loaded
 * live outside the window. Merge is additive/update-only — update changed
 * messages, append genuinely new ones, keep everything already loaded, never
 * delete. References are preserved for unchanged content exactly like mergeFull.
 */
export function mergePaged(
  prevMessages: Message[],
  prevParts: Record<string, Part[]>,
  refreshed: MessageWithParts[],
): DiffResult {
  const refreshById = new Map((refreshed || []).map((r) => [r.info.id, r]))
  const seen = new Set(prevMessages.map((m) => m.id))

  const messages: Message[] = []
  const parts: Record<string, Part[]> = { ...prevParts }

  // Walk the already-loaded list in order — nothing here is ever dropped, even
  // when the fresh page doesn't cover it (older messages live outside the page).
  for (const prev of prevMessages) {
    const item = refreshById.get(prev.id)
    if (!item) {
      messages.push(prev)
      continue
    }
    const server = item.info
    const sameMessage = messageSame(prev, server)
    const sameParts = partsSame(prevParts[prev.id], item.parts)
    // Prefer the local reference whenever content matches on both sides so the
    // memo holds; only adopt the server object/parts on a real change.
    if (sameMessage) {
      messages.push(prev)
      parts[prev.id] = sameParts ? prevParts[prev.id] : item.parts || []
    } else {
      messages.push(server)
      parts[prev.id] = item.parts || []
    }
  }

  // Append genuinely-new messages from the page that we didn't already have.
  for (const item of refreshed || []) {
    const server = item.info
    if (seen.has(server.id)) continue
    seen.add(server.id)
    messages.push(server)
    parts[server.id] = item.parts || []
  }

  return { messages, parts }
}
