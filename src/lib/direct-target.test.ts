import test from "node:test"
import assert from "node:assert/strict"
import { directTargetFromUrl } from "./direct-target.ts"

test("ipv4 targets normalize to lowercase host with explicit port", () => {
  assert.equal(directTargetFromUrl("http://100.64.0.5:4096"), "100.64.0.5:4096")
  assert.equal(directTargetFromUrl("HTTP://100.64.0.5:4096"), "100.64.0.5:4096")
})

test("scheme defaults fill in the port", () => {
  assert.equal(directTargetFromUrl("http://100.64.0.5"), "100.64.0.5:80")
  assert.equal(directTargetFromUrl("https://100.64.0.5"), "100.64.0.5:443")
})

test("magicdns hostnames are accepted and lowercased", () => {
  assert.equal(directTargetFromUrl("http://Node.Tailnet:8443"), "node.tailnet:8443")
})

test("ipv6 hosts lose their brackets in the host part but keep them joined", () => {
  assert.equal(directTargetFromUrl("http://[fd7a:115c:a1e0::1]:4096"), "[fd7a:115c:a1e0::1]:4096")
})

test("path, query and trailing slash do not change the target", () => {
  assert.equal(directTargetFromUrl("http://100.64.0.5:4096/some/base/path?x=1"), "100.64.0.5:4096")
})

test("non-http schemes and garbage return null", () => {
  assert.equal(directTargetFromUrl("ftp://100.64.0.5:4096"), null)
  assert.equal(directTargetFromUrl("not a url"), null)
  assert.equal(directTargetFromUrl(""), null)
})
