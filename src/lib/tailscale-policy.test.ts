import assert from "node:assert/strict"
import { test } from "node:test"
import {
  AUTO_RETRY_COOLDOWN_MS,
  autoRetryAllowed,
  canStart,
  controlUrlGate,
} from "./tailscale-policy.ts"

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
