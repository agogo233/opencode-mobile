import { test } from "node:test"
import assert from "node:assert/strict"
import { extOf, mimeForPath, langForPath, isImageMime, isDeviceLoadableImage } from "./file-mime.ts"

test("extOf: last extension of basename, case-insensitive", () => {
  assert.equal(extOf("a/b/c.png"), ".png")
  assert.equal(extOf("C:\\a\\B.PNG"), ".png")
  assert.equal(extOf("noext"), "")
  assert.equal(extOf("a.tar.gz"), ".gz")
  assert.equal(extOf(".env"), ".env") // dotfiles are their own extension
  assert.equal(extOf("."), "")
})

test("mimeForPath: images, known text, unknown binary", () => {
  assert.equal(mimeForPath("x.PNG"), "image/png")
  assert.equal(mimeForPath("x.ts"), "text/plain")
  assert.equal(mimeForPath("x.bin"), "application/octet-stream")
  assert.equal(mimeForPath(".env"), "text/plain")
})

test("langForPath: known code, undefined for unknown", () => {
  assert.equal(langForPath("x.tsx"), "tsx")
  assert.equal(langForPath("x.yaml"), "yaml")
  assert.equal(langForPath("x.bin"), undefined)
  assert.equal(langForPath("README"), undefined)
})

test("isImageMime: image/* only", () => {
  assert.equal(isImageMime("image/svg+xml"), true)
  assert.equal(isImageMime("text/plain"), false)
  assert.equal(isImageMime(undefined), false)
})

test("isDeviceLoadableImage: image mime + device-loadable uri", () => {
  assert.equal(isDeviceLoadableImage({ uri: "data:image/jpeg;base64,AA==", mime: "image/jpeg" }), true)
  // server-side file:// references can't be decoded on-device
  assert.equal(isDeviceLoadableImage({ uri: "file:///workspace/a.png", mime: "image/png" }), false)
  assert.equal(isDeviceLoadableImage({ uri: "file:///workspace/a.ts", mime: "text/plain" }), false)
})
