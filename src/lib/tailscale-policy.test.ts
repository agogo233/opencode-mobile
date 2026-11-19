import assert from "node:assert/strict"
import { test } from "node:test"
import { canStart, controlUrlGate } from "./tailscale-policy.ts"

test("canStart allows every phase except connecting", () => {
  assert.equal(canStart("new"), true)
  assert.equal(canStart("configured"), true)
  assert.equal(canStart("connecting"), false)
  assert.equal(canStart("connected"), true)
  assert.equal(canStart("error"), true)
  assert.equal(canStart("closed"), true)
})

test("controlUrlGate blocks plaintext unless explicitly allowed", () => {
  assert.equal(controlUrlGate(false, false), "ok")
  assert.equal(controlUrlGate(false, true), "ok")
  assert.equal(controlUrlGate(true, false), "block")
  assert.equal(controlUrlGate(true, true), "confirm")
})
