import { test } from "node:test"
import assert from "node:assert/strict"
import { isActive, activePriority, orderActiveFirst, inferredActiveFromTime } from "./session-active.ts"
import { sessionLooksBusy } from "./session-status-reconcile.ts"
import type { Message } from "./sdk.ts"

test("isActive: no signals at all is inactive", () => {
  assert.equal(isActive({}), false)
  assert.equal(isActive({ status: { type: "idle" } }), false)
})

test("isActive: busy and retry statuses are active", () => {
  assert.equal(isActive({ status: { type: "busy" } }), true)
  assert.equal(isActive({ status: { type: "retry", attempt: 2 } }), true)
})

test("isActive: pending permission/question is active even when idle", () => {
  assert.equal(isActive({ status: { type: "idle" }, pending: 1 }), true)
  assert.equal(isActive({ pending: 2 }), true)
})

test("isActive: optimistic sending bridges the pre-status gap only", () => {
  // Sent, SSE has not reported anything yet → active.
  assert.equal(isActive({ sending: true }), true)
  // SSE confirmed idle → the stale optimistic flag must NOT keep it active.
  assert.equal(isActive({ sending: true, status: { type: "idle" } }), false)
  // SSE busy → active via status; sending adds nothing.
  assert.equal(isActive({ sending: true, status: { type: "busy" } }), true)
})

test("activePriority: needs-attention > retry > busy > inactive", () => {
  assert.equal(activePriority({ pending: 1, status: { type: "busy" } }), 1)
  assert.equal(activePriority({ status: { type: "retry", attempt: 1 } }), 2)
  assert.equal(activePriority({ status: { type: "busy" } }), 3)
  assert.equal(activePriority({ sending: true }), 3)
  assert.equal(activePriority({}), 4)
})

test("isActive: cold-start inferred flag is active and floats like busy", () => {
  assert.equal(isActive({ inferred: true }), true)
  assert.equal(activePriority({ inferred: true }), 3)
  // SSE spoke (idle) → the guess must stand down, same as `sending` below.
  assert.equal(isActive({ inferred: true, status: { type: "idle" } }), false)
  assert.equal(isActive({ inferred: false, status: { type: "idle" } }), false)
})

test("inferredActiveFromTime: activity after the last idle transition hints a run", () => {
  assert.equal(inferredActiveFromTime(200, 100), true)
  // Idle is the newest stamp → not running.
  assert.equal(inferredActiveFromTime(100, 200), false)
  // Equal stamps → the idle transition covers the update → not running.
  assert.equal(inferredActiveFromTime(100, 100), false)
  // No idle stamp (v1 server, or a v2 session that never ran) → no guess.
  assert.equal(inferredActiveFromTime(100, undefined), false)
})

test("sessionLooksBusy: message tail decides, empty tail is never busy", () => {
  const user = { role: "user" } as Message
  const done = { role: "assistant", time: { created: 1, completed: 2 } } as Message
  const streaming = { role: "assistant", time: { created: 1 } } as Message
  const failed = { role: "assistant", time: { created: 1 }, error: { message: "x" } } as Message
  // Last message is a user prompt awaiting a reply → possibly running.
  assert.equal(sessionLooksBusy([done, user]), true)
  // Assistant message without a completed/error stamp → still streaming.
  assert.equal(sessionLooksBusy([user, streaming]), true)
  // Terminated assistant messages → not running.
  assert.equal(sessionLooksBusy([user, done]), false)
  assert.equal(sessionLooksBusy([user, failed]), false)
  // Fresh session with no messages must not light the indicator.
  assert.equal(sessionLooksBusy([]), false)
  assert.equal(sessionLooksBusy(null), false)
})

test("orderActiveFirst: active sessions float up, inactive keep their order", () => {
  const sessions = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]
  const signals: Record<string, { status?: { type: "idle" | "busy" } }> = {
    b: { status: { type: "busy" } },
    d: { status: { type: "busy" } },
  }
  const ordered = orderActiveFirst(sessions, (id) => signals[id] ?? {})
  assert.deepEqual(ordered.map((s) => s.id), ["b", "d", "a", "c"])
})

test("orderActiveFirst: within active sessions, higher priority floats first", () => {
  const sessions = [{ id: "busy" }, { id: "retry" }, { id: "pending" }]
  const signals = {
    busy: { status: { type: "busy" as const } },
    retry: { status: { type: "retry" as const } },
    pending: { pending: 1 },
  }
  const ordered = orderActiveFirst(sessions, (id) => signals[id as keyof typeof signals])
  assert.deepEqual(ordered.map((s) => s.id), ["pending", "retry", "busy"])
})

test("orderActiveFirst: empty input and all-inactive keep everything as-is", () => {
  assert.deepEqual(orderActiveFirst([], () => ({})), [])
  const sessions = [{ id: "a" }, { id: "b" }]
  assert.deepEqual(orderActiveFirst(sessions, () => ({ status: { type: "idle" } })), sessions)
})
