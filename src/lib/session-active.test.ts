import { test } from "node:test"
import assert from "node:assert/strict"
import { isActive, activePriority, orderActiveFirst } from "./session-active.ts"

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
