import test from "node:test"
import assert from "node:assert/strict"
import { resolveBaseUrl, TailscaleUnavailableError } from "./resolve-base-url.ts"

test("non-tailscale connections use the configured URL directly", async () => {
  const url = await resolveBaseUrl({ type: "local", url: "http://192.168.1.10:4096" }, async () => {
    throw new Error("ensureForward must not be called for non-tailscale connections")
  })
  assert.equal(url, "http://192.168.1.10:4096")
})

test("tailscale connections route through the loopback forward port", async () => {
  let requested = ""
  const url = await resolveBaseUrl({ type: "tailscale", url: "http://100.64.0.5:4096" }, async (target) => {
    requested = target
    return 45678
  })
  assert.equal(requested, "http://100.64.0.5:4096")
  assert.equal(url, "http://127.0.0.1:45678")
})

test("tailscale connections fail closed when no forward is available", async () => {
  await assert.rejects(
    resolveBaseUrl({ type: "tailscale", url: "http://100.64.0.5:4096" }, async () => null),
    (error: unknown) => error instanceof TailscaleUnavailableError,
  )
})
