import test from "node:test"
import assert from "node:assert/strict"
import { isInsecureControlUrl } from "./control-url.ts"

test("https URLs are never flagged", () => {
  assert.equal(isInsecureControlUrl("https://headscale.example.com"), false)
  assert.equal(isInsecureControlUrl(""), false)
  assert.equal(isInsecureControlUrl("   "), false)
})

test("http URLs to public hosts are flagged", () => {
  assert.equal(isInsecureControlUrl("http://headscale.example.com"), true)
  assert.equal(isInsecureControlUrl("http://8.8.8.8:8080"), true)
  assert.equal(isInsecureControlUrl("HTTP://HEADSCALE.EXAMPLE.COM"), true)
})

test("http URLs to loopback and private ranges are allowed", () => {
  assert.equal(isInsecureControlUrl("http://localhost:8080"), false)
  assert.equal(isInsecureControlUrl("http://127.0.0.1:8080"), false)
  assert.equal(isInsecureControlUrl("http://[::1]:8080"), false)
  assert.equal(isInsecureControlUrl("http://10.1.2.3:8080"), false)
  assert.equal(isInsecureControlUrl("http://192.168.1.10:8080"), false)
  assert.equal(isInsecureControlUrl("http://172.16.0.1:8080"), false)
  assert.equal(isInsecureControlUrl("http://172.31.255.1:8080"), false)
  assert.equal(isInsecureControlUrl("http://169.254.1.1:8080"), false)
  assert.equal(isInsecureControlUrl("http://100.64.0.9:8080"), false)
  assert.equal(isInsecureControlUrl("http://100.127.255.9:8080"), false)
  assert.equal(isInsecureControlUrl("http://myheadscale"), false)
})

test("http URLs to non-loopback IPv6 literals are flagged", () => {
  assert.equal(isInsecureControlUrl("http://[2001:db8::1]:8080"), true)
  assert.equal(isInsecureControlUrl("http://[fe80::1]:8080"), true)
  assert.equal(isInsecureControlUrl("http://[::1]:8080"), false)
})

test("http URLs just outside the private ranges are flagged", () => {
  assert.equal(isInsecureControlUrl("http://172.32.0.1:8080"), true)
  assert.equal(isInsecureControlUrl("http://100.128.0.1:8080"), true)
  assert.equal(isInsecureControlUrl("http://100.63.0.1:8080"), true)
  assert.equal(isInsecureControlUrl("http://11.0.0.1:8080"), true)
})

test("unparseable http URLs are treated as insecure", () => {
  assert.equal(isInsecureControlUrl("http://"), true)
})
