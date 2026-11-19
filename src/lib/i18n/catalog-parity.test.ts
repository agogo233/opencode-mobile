// Guards against locale drift. This fork ships English + Simplified Chinese
// and keeps those two catalogs in lockstep (missing copy silently falls back
// to the key path at runtime). ru.json is carried from upstream as a
// best-effort fallback catalog and is deliberately not held to strict parity.
// Run with plain `node --test` — no i18next/expo-localization imports needed,
// same as locale-resolve.test.ts.
import { test } from "node:test"
import assert from "node:assert/strict"
import en from "./en.json" with { type: "json" }
import ru from "./ru.json" with { type: "json" }
import zhHans from "./zh-Hans.json" with { type: "json" }

// Flattens a nested translation object into dotted leaf-key paths, e.g.
// { settings: { language: { label: "..." } } } -> ["settings.language.label"]
function flattenKeys(obj: unknown, prefix = ""): string[] {
  if (typeof obj !== "object" || obj === null) return [prefix]
  const keys: string[] = []
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof value === "object" && value !== null) {
      keys.push(...flattenKeys(value, path))
    } else {
      keys.push(path)
    }
  }
  return keys
}

test("en.json and zh-Hans.json expose identical translation keys", () => {
  const enKeys = new Set(flattenKeys(en))
  const zhKeys = new Set(flattenKeys(zhHans))

  const missingFromZh = [...enKeys].filter((k) => !zhKeys.has(k)).sort()
  const missingFromEn = [...zhKeys].filter((k) => !enKeys.has(k)).sort()

  assert.deepEqual(missingFromZh, [], `keys present in en.json but missing from zh-Hans.json: ${missingFromZh.join(", ")}`)
  assert.deepEqual(missingFromEn, [], `keys present in zh-Hans.json but missing from en.json: ${missingFromEn.join(", ")}`)
})

test("no translation value is an empty string", () => {
  for (const [name, catalog] of [["en", en], ["ru", ru], ["zh-Hans", zhHans]] as const) {
    const keys = flattenKeys(catalog)
    for (const key of keys) {
      const value = key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], catalog)
      assert.notEqual(value, "", `${name}.json: "${key}" is an empty string`)
    }
  }
})
