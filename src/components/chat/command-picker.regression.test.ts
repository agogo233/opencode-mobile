import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

// Regression guard for the slash-command discoverability fix (2026-11):
//  - the /compact builtin (removed as a no-op in 42fa36f) is back and now
//    really compacts: v1 servers via POST /session/:id/summarize, v2 via
//    POST /api/session/:id/compact
//  - the session screen shows a "command" chip next to the reasoning-effort
//    chip, opening a CommandPicker bottom sheet that fills the input
//  - custom commands come from the server catalog, so the session screen must
//    fall back to catalog.load() when the tab screen never ran
// This repo's runtime is React Native, so (same as wide-content-wrap) these
// assertions read the actual sources and check the markers that would prove a
// regression.

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (rel: string) => readFileSync(path.join(here, rel), "utf8")
const readScreen = () => read("../../../app/session/[id].tsx")

test("session screen renders the command chip and picker", () => {
  const screen = readScreen()
  assert.ok(screen.includes('testID="command-chip"'), "command chip must exist next to the variant chip")
  assert.ok(screen.includes("<CommandPicker"), "CommandPicker must be rendered")
  assert.ok(screen.includes("commands={allCommands}"), "picker must receive the merged command list")
  assert.ok(screen.includes("onSelect={handleSlashSelect}"), "picker selection must reuse the slash handler")
  assert.ok(screen.includes("commandSheetRef.current?.expand()"), "chip must open the picker sheet")
})

test("selecting a custom command fills and focuses the input", () => {
  const screen = readScreen()
  assert.ok(screen.includes('setInput(`/${cmd.trigger} `)'), "custom command must fill the input")
  assert.ok(screen.includes("chatInputRef.current?.focus()"), "input must be focused after filling")
})

test("compact is a real builtin command that compacts the session", () => {
  const screen = readScreen()
  assert.ok(screen.includes('trigger: "compact"'), "compact must be in the builtin command list")
  assert.ok(screen.includes('case "compact":'), "compact must have a dedicated handler")
  assert.ok(screen.includes(".compact(currentSession.id,"), "handler must call session.compact")
})

test("both transports implement compact", () => {
  const v1 = read("../../lib/sdk-v1.ts")
  const v2 = read("../../lib/sdk.ts")
  assert.ok(v1.includes("/session/${sessionID}/summarize"), "v1 must compact via summarize")
  assert.ok(v1.includes("COMPACT_TIMEOUT_MS"), "v1 summarize needs the extended timeout")
  assert.ok(v2.includes("/api/session/${sessionID}/compact"), "v2 must use the compact endpoint")
  assert.ok(
    v1.includes("compact requires the currently selected model"),
    "v1 compact must guard the missing model",
  )
})

test("session screen reloads the catalog when it was never loaded", () => {
  const screen = readScreen()
  assert.ok(screen.includes("!catalog.loaded"), "catalog fallback must check loaded")
  assert.ok(screen.includes("catalog.load()"), "catalog fallback must call load")
})

test("i18n catalogs carry every new key in both languages", () => {
  for (const rel of ["../../lib/i18n/en.json", "../../lib/i18n/zh-Hans.json"]) {
    const catalog = JSON.parse(read(rel))
    assert.ok(catalog.session.toolbar.command, `${rel} session.toolbar.command`)
    assert.ok(catalog.session.slash.compact.title, `${rel} session.slash.compact.title`)
    assert.ok(catalog.session.slash.compact.description, `${rel} session.slash.compact.description`)
    assert.ok(catalog.session.alerts.modelRequired, `${rel} session.alerts.modelRequired`)
    assert.ok(catalog.session.alerts.compactFailed, `${rel} session.alerts.compactFailed`)
    assert.ok(catalog.chat.commandPicker.title, `${rel} chat.commandPicker.title`)
  }
})
