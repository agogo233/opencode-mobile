import { test } from "node:test"
import assert from "node:assert/strict"
import { mergeFull, mergePaged } from "./message-diff-merge.ts"
import type { Message, MessageWithParts, Part } from "./sdk.ts"

let n = 0
const msg = (id: string, role: "user" | "assistant" = "user", extra: Partial<Message> = {}): Message => ({
  id,
  sessionID: "s1",
  role,
  time: { created: n++ },
  ...extra,
})

const part = (id: string, text: string): Part => ({ id, messageID: "", type: "text", text })
const item = (m: Message, parts: Part[] = []): MessageWithParts => ({ info: m, parts })

test("mergeFull keeps references for unchanged messages and parts", () => {
  const m1 = msg("a"), m2 = msg("b", "assistant")
  const p1 = [part("p1", "hi")]
  const prevMsgs = [m1, m2]
  const prevParts = { a: p1, b: [part("p2", "reply")] }
  const out = mergeFull(prevMsgs, prevParts, [item(m1, p1), item(m2, prevParts.b)])
  // Exact same object references survive — memo will bail.
  assert.equal(out.messages[0], m1)
  assert.equal(out.messages[1], m2)
  assert.equal(out.parts.a, p1)
})

test("mergeFull adopts a changed part and message when content differs", () => {
  const m1 = msg("a")
  const p1 = [part("p1", "hi")]
  const out = mergeFull([m1], { a: p1 }, [item(m1, [part("p1", "hi edited")])])
  assert.notEqual(out.parts.a, p1)
  assert.equal(out.parts.a[0].text, "hi edited")
})

test("mergeFull adopts a revised message field (tokens/cost) via fresh reference", () => {
  const before = msg("a", "assistant")
  const after: Message = { ...before, tokens: { input: 5, output: 9 } }
  const out = mergeFull([before], {}, [item(after)])
  assert.equal(out.messages[0], after)
  assert.notEqual(out.messages[0], before)
})

test("mergeFull strictly deletes a message the server no longer has", () => {
  const m1 = msg("a"), m2 = msg("b")
  const out = mergeFull([m1, m2], { a: [], b: [] }, [item(m1)])
  assert.deepEqual(out.messages.map((m) => m.id), ["a"])
  assert.ok(!("b" in out.parts))
})

test("mergeFull keeps temp messages and orders them last", () => {
  const real = msg("real-1", "assistant")
  const temp = msg("temp-1", "user")
  const out = mergeFull([temp, real], { "temp-1": [] }, [item(real)])
  assert.deepEqual(out.messages.map((m) => m.id), ["real-1", "temp-1"])
})

test("mergePaged never deletes messages outside the refreshed page", () => {
  const m1 = msg("a"), m2 = msg("b"), m3 = msg("c", "assistant")
  const page = [m2, m3] // older a is outside the most-recent page
  const out = mergePaged([m1, m2, m3], { a: [], b: [], c: [] }, [item(m2), item(m3)])
  assert.deepEqual(out.messages.map((m) => m.id), ["a", "b", "c"])
})

test("mergePaged keeps references for unchanged paged messages", () => {
  const m1 = msg("a")
  const p1 = [part("p1", "hi")]
  const out = mergePaged([m1], { a: p1 }, [item(m1, p1)])
  assert.equal(out.messages[0], m1)
  assert.equal(out.parts.a, p1)
})

test("mergePaged appends genuinely new messages from the page (grows result)", () => {
  const m1 = msg("a"), m2 = msg("b", "assistant")
  // b is a brand-new message that arrived while the app was away and sits
  // beyond the previously loaded window — mergePaged must append it (this
  // growth is what lets refreshMessages re-arm loadOlderMessages).
  const out = mergePaged([m1], { a: [] }, [item(m1), item(m2)])
  assert.deepEqual(out.messages.map((m) => m.id), ["a", "b"])
})

test("mergeFull handles an empty refreshed list by dropping all non-temp messages", () => {
  const m1 = msg("a")
  const temp = msg("temp-1", "user")
  const out = mergeFull([m1, temp], { a: [], "temp-1": [] }, [])
  assert.deepEqual(out.messages.map((m) => m.id), ["temp-1"])
})

test("mergeFull detects a revised user model label (message.model)", () => {
  const before = msg("a", "user", { model: { providerID: "p", modelID: "m1" } })
  const after = msg("a", "user", { model: { providerID: "p", modelID: "m2" } })
  const out = mergeFull([before], {}, [item(after)])
  assert.equal(out.messages[0], after)
  assert.equal(out.messages[0].model?.modelID, "m2")
})

test("mergeFull detects a revised part callID", () => {
  const m = msg("a", "assistant")
  const beforeParts = [{ id: "t1", messageID: "a", type: "tool" as const, callID: "c1" }]
  const afterParts = [{ id: "t1", messageID: "a", type: "tool" as const, callID: "c2" }]
  const out = mergeFull([m], { a: beforeParts }, [item(m, afterParts)])
  assert.notEqual(out.parts.a, beforeParts)
  assert.equal(out.parts.a[0].callID, "c2")
})
