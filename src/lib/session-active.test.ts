import { test } from "node:test"
import assert from "node:assert/strict"
import { isActive, activePriority, orderActiveFirst, inferredActiveFromTime, planActivityInference } from "./session-active.ts"
import { sessionLooksBusy } from "./session-status-reconcile.ts"
import type { Message, Session } from "./sdk.ts"

function session(overrides: Partial<Session> & { id: string }): Session {
  return {
    slug: overrides.id,
    projectID: "p",
    directory: "/tmp",
    title: overrides.id,
    version: "1.0.0",
    time: { created: 0, updated: 0 },
    ...overrides,
  } as Session
}

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

test("isActive: inferred guess stays active even over a stale idle record", () => {
  assert.equal(isActive({ inferred: true }), true)
  assert.equal(activePriority({ inferred: true }), 3)
  // The guess is written precisely when the local record may be stale (a
  // busy event lost to a dropped connection) — an idle record must not
  // suppress it. Any real status event retires the guess instead.
  assert.equal(isActive({ inferred: true, status: { type: "idle" } }), true)
  assert.equal(isActive({ inferred: false, status: { type: "idle" } }), false)
})

test("planActivityInference: v2 time hint infers actives; idle records don't block", () => {
  const sessions = [
    session({ id: "running", time: { created: 0, updated: 200, idle: 100 } }),
    session({ id: "done", time: { created: 0, updated: 100, idle: 200 } }),
    session({ id: "busy", time: { created: 0, updated: 300, idle: 100 } }),
  ]
  const statusOf = (id: string) => (id === "busy" ? { type: "busy" as const } : { type: "idle" as const })
  const { inferred, probe } = planActivityInference(sessions, statusOf)
  assert.deepEqual(inferred, { running: true })
  assert.equal(probe.length, 0)
})

test("planActivityInference: v1 sessions without time.idle go to the probe list", () => {
  const sessions = [
    session({ id: "newer", time: { created: 0, updated: 300 } }),
    session({ id: "older", time: { created: 0, updated: 100 } }),
  ]
  const { inferred, probe } = planActivityInference(sessions, () => undefined)
  assert.deepEqual(inferred, {})
  assert.deepEqual(probe.map((s) => s.id), ["newer", "older"])
})

test("planActivityInference: never guesses over busy/retry, even with fresh activity", () => {
  const sessions = [session({ id: "retrying", time: { created: 0, updated: 999, idle: 100 } })]
  const { inferred, probe } = planActivityInference(sessions, () => ({ type: "retry", attempt: 1 }))
  assert.deepEqual(inferred, {})
  assert.equal(probe.length, 0)
})

test("planActivityInference: busy/retry keeps v1 sessions out of the probe list too", () => {
  const sessions = [session({ id: "v1busy", time: { created: 0, updated: 999 } })]
  const { inferred, probe } = planActivityInference(sessions, () => ({ type: "busy" }))
  assert.deepEqual(inferred, {})
  assert.equal(probe.length, 0)
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
