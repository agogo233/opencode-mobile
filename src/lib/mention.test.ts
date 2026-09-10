import { test } from "node:test"
import assert from "node:assert/strict"
import { detectMentionTrigger, toFileUrl, resolveAbsPath } from "./mention.ts"

test("detectMentionTrigger: @ at start after whitespace", () => {
  assert.deepEqual(detectMentionTrigger("hello @src/c", 14), { startIndex: 6, query: "src/c" })
  assert.deepEqual(detectMentionTrigger("@a", 2), { startIndex: 0, query: "a" })
  assert.deepEqual(detectMentionTrigger("\n@x", 3), { startIndex: 1, query: "x" })
  assert.deepEqual(detectMentionTrigger("hi @", 4), { startIndex: 3, query: "" })
})

test("detectMentionTrigger: rejects non-trigger @ positions", () => {
  assert.equal(detectMentionTrigger("email@test.com", 14), null) // @ preceded by "l"
  assert.equal(detectMentionTrigger("hello @src com", 14), null) // space after @query
  assert.equal(detectMentionTrigger("hello", 5), null) // no @ at all
})

test("toFileUrl: posix, windows drive, relative fallback", () => {
  assert.equal(toFileUrl("/workspace/project/src/app.ts"), "file:///workspace/project/src/app.ts")
  assert.equal(toFileUrl("C:/repo/app.ts"), "file:///C:/repo/app.ts")
  assert.equal(toFileUrl("C:\\repo\\app.ts"), "file:///C:/repo/app.ts")
  assert.equal(toFileUrl("rel.ts"), "file:///rel.ts")
})

test("resolveAbsPath: relative anchors to root, absolute passes through", () => {
  assert.equal(resolveAbsPath("src/x.ts", "/w"), "/w/src/x.ts")
  assert.equal(resolveAbsPath("src/x.ts", "/w/"), "/w/src/x.ts") // trailing slash on root
  assert.equal(resolveAbsPath("/abs/x.ts", "/w"), "/abs/x.ts")
  assert.equal(resolveAbsPath("C:/a/b.ts", "/w"), "C:/a/b.ts")
  assert.equal(resolveAbsPath(".", "/w/"), "/w")
  assert.equal(resolveAbsPath("", "/w"), "/w")
})
