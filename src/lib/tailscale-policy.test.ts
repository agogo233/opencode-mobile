import assert from "node:assert/strict"
import { test } from "node:test"
import {
  AUTO_RETRY_COOLDOWN_MS,
  autoRetryAllowed,
  canStart,
  controlUrlGate,
  pollUntilConnected,
  shouldAwaitNodeRetry,
} from "./tailscale-policy.ts"
import type { TailscalePhase, TailscaleStatus } from "./tailscale.ts"

function statusOf(phase: TailscalePhase): TailscaleStatus {
  return { phase, hostname: "test", error: "", forwardCount: 0, addresses: { ipv4: "100.64.0.1", ipv6: "" } }
}

const noDelay = async () => {}

test("canStart allows every phase except connecting", () => {
  assert.equal(canStart("new"), true)
  assert.equal(canStart("configured"), true)
  assert.equal(canStart("connecting"), false)
  assert.equal(canStart("connected"), true)
  assert.equal(canStart("error"), true)
  assert.equal(canStart("closed"), true)
})

test("autoRetryAllowed blocks within the cooldown and allows afterwards", () => {
  const failedAt = 1_000_000
  assert.equal(autoRetryAllowed(failedAt, failedAt), false)
  assert.equal(autoRetryAllowed(failedAt, failedAt + AUTO_RETRY_COOLDOWN_MS - 1), false)
  assert.equal(autoRetryAllowed(failedAt, failedAt + AUTO_RETRY_COOLDOWN_MS), true)
  assert.equal(autoRetryAllowed(failedAt, failedAt + AUTO_RETRY_COOLDOWN_MS + 1), true)
  // Never-failed sentinel (0) with a realistic clock is always allowed.
  assert.equal(autoRetryAllowed(0, 1_000_000_000_000), true)
})

test("controlUrlGate blocks plaintext unless explicitly allowed", () => {
  assert.equal(controlUrlGate(false, false), "ok")
  assert.equal(controlUrlGate(false, true), "ok")
  assert.equal(controlUrlGate(true, false), "block")
  assert.equal(controlUrlGate(true, true), "confirm")
})

test("shouldAwaitNodeRetry waits only for a live or connecting node", () => {
  assert.equal(shouldAwaitNodeRetry("connecting"), true)
  assert.equal(shouldAwaitNodeRetry("connected"), true)
  assert.equal(shouldAwaitNodeRetry("new"), false)
  assert.equal(shouldAwaitNodeRetry("configured"), false)
  assert.equal(shouldAwaitNodeRetry("error"), false)
  assert.equal(shouldAwaitNodeRetry("closed"), false)
  // A failed status query is not a phase — never wait on it.
  assert.equal(shouldAwaitNodeRetry(null), false)
  assert.equal(shouldAwaitNodeRetry(undefined), false)
})

test("pollUntilConnected resolves true once the node reports connected", async () => {
  const phases: TailscalePhase[] = ["connecting", "connecting", "connected"]
  const seen: TailscaleStatus[] = []
  const ok = await pollUntilConnected(
    () => Promise.resolve(statusOf(phases.shift()!)),
    { intervalMs: 1, timeoutMs: 10_000, delayFn: noDelay, onStatus: (s) => seen.push(s) },
  )
  assert.equal(ok, true)
  assert.deepEqual(seen.map((s) => s.phase), ["connecting", "connecting", "connected"])
})

test("pollUntilConnected bails out early on error or closed", async () => {
  assert.equal(
    await pollUntilConnected(() => Promise.resolve(statusOf("error")), {
      intervalMs: 1,
      timeoutMs: 10_000,
      delayFn: noDelay,
    }),
    false,
  )
  assert.equal(
    await pollUntilConnected(() => Promise.resolve(statusOf("closed")), {
      intervalMs: 1,
      timeoutMs: 10_000,
      delayFn: noDelay,
    }),
    false,
  )
})

test("pollUntilConnected gives up after the timeout", async () => {
  const ok = await pollUntilConnected(() => Promise.resolve(statusOf("connecting")), {
    intervalMs: 1,
    timeoutMs: 0,
    delayFn: noDelay,
  })
  assert.equal(ok, false)
})

test("pollUntilConnected treats failed status queries as transient", async () => {
  let calls = 0
  const ok = await pollUntilConnected(() => {
    calls += 1
    return calls < 3 ? Promise.reject(new Error("hiccup")) : Promise.resolve(statusOf("connected"))
  }, { intervalMs: 1, timeoutMs: 10_000, delayFn: noDelay })
  assert.equal(ok, true)
  assert.equal(calls, 3)
})

test("pollUntilConnected returns true immediately when already connected despite a zero timeout", async () => {
  const ok = await pollUntilConnected(() => Promise.resolve(statusOf("connected")), {
    intervalMs: 1,
    timeoutMs: 0,
    delayFn: noDelay,
  })
  assert.equal(ok, true)
})

test("pollUntilConnected keeps waiting through a new phase until the timeout", async () => {
  const ok = await pollUntilConnected(() => Promise.resolve(statusOf("new")), {
    intervalMs: 1,
    timeoutMs: 0,
    delayFn: noDelay,
  })
  assert.equal(ok, false)
})

test("pollUntilConnected does not report failed queries to onStatus", async () => {
  const seen: TailscaleStatus[] = []
  let calls = 0
  await pollUntilConnected(() => {
    calls += 1
    return calls < 2 ? Promise.reject(new Error("hiccup")) : Promise.resolve(statusOf("connected"))
  }, { intervalMs: 1, timeoutMs: 10_000, delayFn: noDelay, onStatus: (s) => seen.push(s) })
  assert.deepEqual(seen.map((s) => s.phase), ["connected"])
})
