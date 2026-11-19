import assert from "node:assert/strict"
import { test } from "node:test"
import { canStart } from "./tailscale-policy.ts"

test("canStart allows every phase except connecting", () => {
  assert.equal(canStart("new"), true)
  assert.equal(canStart("configured"), true)
  assert.equal(canStart("connecting"), false)
  assert.equal(canStart("connected"), true)
  assert.equal(canStart("error"), true)
  assert.equal(canStart("closed"), true)
})
