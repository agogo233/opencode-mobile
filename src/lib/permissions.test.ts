import assert from "node:assert/strict"
import test from "node:test"
import { mergePendingPermissions, pendingItemSame, pendingPermissionsSame, normalizePermissionEvent } from "./permissions.ts"

function pending(id: string, extra: Record<string, unknown> = {}) {
  return normalizePermissionEvent({
    type: "permission.asked",
    properties: { id, sessionID: "s1", permission: "bash", patterns: ["printf hi"], metadata: {}, ...extra },
  })!
}

test("normalizes legacy permission asks", () => {
  assert.deepEqual(normalizePermissionEvent({ type: "permission.asked", properties: {
    id: "p1", sessionID: "s1", permission: "bash", patterns: ["printf hi"], metadata: {},
  } }), { id: "p1", sessionID: "s1", permission: "bash", patterns: ["printf hi"], metadata: {} })
})

test("normalizes PermissionV2 action/resources/metadata/source", () => {
  assert.deepEqual(normalizePermissionEvent({ type: "permission.v2.asked", properties: {
    id: "p2", sessionID: "s1", action: "bash", resources: ["printf hi"], metadata: { command: "printf hi" }, source: { tool: "bash" },
  } }), { id: "p2", sessionID: "s1", permission: "bash", patterns: ["printf hi"], action: "bash", resources: ["printf hi"], metadata: { command: "printf hi" }, source: { tool: "bash" } })
})

test("rejects malformed requests and ignores unrelated events", () => {
  assert.equal(normalizePermissionEvent({ type: "permission.v2.asked", properties: { id: "p", sessionID: "s" } }), null)
  assert.equal(normalizePermissionEvent({ type: "other", properties: {} }), null)
})

test("deduplicates replayed IDs and lets the latest request data win", () => {
  const item = normalizePermissionEvent({ type: "permission.v2.asked", properties: {
    id: "p", sessionID: "s", action: "bash", resources: ["safe"],
  } })!
  assert.deepEqual(mergePendingPermissions([item], [item]), [item])
})

test("merge keeps the original array reference when content is unchanged", () => {
  const a = [pending("p1"), pending("p2")]
  // Same ids, same content, same order — even as brand-new objects
  const b = [pending("p1"), pending("p2")]
  assert.notEqual(a[0], b[0]) // distinct objects, equal content
  const merged = mergePendingPermissions(a, b)
  assert.equal(merged, a, "unchanged merge must return the ORIGINAL array")
  assert.equal(merged[0], a[0], "unchanged items keep their old references")
})

test("merge replaces the array when content actually differs", () => {
  const a = [pending("p1")]
  // p1 revised (different patterns) + p2 added
  const merged = mergePendingPermissions(a, [pending("p1", { patterns: ["rm -rf"] }), pending("p2")])
  assert.notEqual(merged, a)
  assert.deepEqual(merged.map((p) => p.id), ["p1", "p2"])
  assert.deepEqual(merged[0].patterns, ["rm -rf"])
})

test("merge of empty into empty returns the original array", () => {
  const empty: ReturnType<typeof pending>[] = []
  assert.equal(mergePendingPermissions(empty, []), empty)
})

test("pendingItemSame compares all content fields", () => {
  const base = pending("p1", { patterns: ["a", "b"], metadata: { command: "x" } })
  assert.ok(pendingItemSame(base, pending("p1", { patterns: ["a", "b"], metadata: { command: "x" } })))
  assert.ok(!pendingItemSame(base, pending("p1", { patterns: ["a"] }))) // patterns length
  assert.ok(!pendingItemSame(base, pending("p1", { patterns: ["a", "c"] }))) // patterns content
  assert.ok(!pendingItemSame(base, pending("p1", { permission: "edit" }))) // permission
  assert.ok(!pendingItemSame(base, pending("p1", { metadata: { command: "y" } }))) // metadata
  assert.ok(!pendingItemSame(base, pending("p1", { sessionID: "s2" }))) // sessionID
})

test("pendingPermissionsSame compares arrays, short-circuiting on identity", () => {
  const a = [pending("p1"), pending("p2")]
  assert.ok(pendingPermissionsSame(a, a)) // identity fast path
  assert.ok(pendingPermissionsSame(a, [pending("p1"), pending("p2")])) // equal content
  assert.ok(!pendingPermissionsSame(a, [pending("p1")])) // length
  assert.ok(!pendingPermissionsSame(a, [pending("p2"), pending("p1")])) // order matters
  assert.ok(!pendingPermissionsSame(a, [pending("p1"), pending("p3")])) // content
})
