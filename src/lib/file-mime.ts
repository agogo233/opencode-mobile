// Pure path → mime/language helpers for workspace file preview and
// @-mention file attachments. No React Native imports — unit-testable
// with node --test.
//
// Server-returned mime is authoritative when present (see FileContent);
// these helpers are the fallback used by attachment chips and previews
// when only a filename is known.

const IMAGE_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
}

// Known text/code extensions, keyed by the code language label passed to
// CodeBlock. Anything not listed here is treated as binary/unknown.
const TEXT_LANG: Record<string, string> = {
  ".txt": "text",
  ".log": "text",
  ".ts": "ts",
  ".tsx": "tsx",
  ".mts": "ts",
  ".cts": "ts",
  ".js": "js",
  ".jsx": "jsx",
  ".mjs": "js",
  ".cjs": "js",
  ".json": "json",
  ".md": "md",
  ".markdown": "md",
  ".rst": "rst",
  ".py": "py",
  ".pyi": "py",
  ".rs": "rs",
  ".go": "go",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cc": "cpp",
  ".java": "java",
  ".kt": "kt",
  ".swift": "swift",
  ".sh": "sh",
  ".bash": "sh",
  ".zsh": "sh",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".ini": "ini",
  ".env": "text",
  ".html": "html",
  ".htm": "html",
  ".vue": "html",
  ".css": "css",
  ".scss": "css",
  ".less": "css",
  ".sql": "sql",
  ".xml": "xml",
  ".lock": "text",
  ".gradle": "groovy",
  ".php": "php",
  ".rb": "rb",
  ".lua": "lua",
  ".r": "r",
  ".dart": "dart",
  ".zig": "zig",
  ".proto": "proto",
  ".graphql": "graphql",
  ".gql": "graphql",
}

/** Lowercased file extension including the dot (".ts"), or "" for none.
 * Dotfiles like ".env" count as their own extension. */
export function extOf(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? ""
  const dot = base.lastIndexOf(".")
  if (dot > 0) return base.slice(dot).toLowerCase()
  if (dot === 0 && base.length > 1) return base.toLowerCase()
  return ""
}

/** Best-effort mime for a path: image/*, text/plain, or application/octet-stream. */
export function mimeForPath(path: string): string {
  const ext = extOf(path)
  const image = IMAGE_EXT[ext]
  if (image) return image
  if (TEXT_LANG[ext]) return "text/plain"
  return "application/octet-stream"
}

/** Code language hint for CodeBlock, or undefined when unknown/binary. */
export function langForPath(path: string): string | undefined {
  return TEXT_LANG[extOf(path)]
}

/** Whether the mime describes an image (the only type the composer previews as a thumbnail). */
export function isImageMime(mime?: string): boolean {
  return !!mime && mime.startsWith("image/")
}

/**
 * Whether an attachment/message part can be rendered as an on-device
 * thumbnail. Server-side `file://` references (workspace files mentioned
 * via @) point at the server's filesystem, which RN cannot decode — those
 * must fall back to the plain filename chip instead of a broken image box.
 * Accepts either the composer attachment shape (`uri`) or the message part
 * shape (`url`).
 */
export function isDeviceLoadableImage(att: { uri?: string; url?: string; mime?: string }): boolean {
  const src = att.uri ?? att.url ?? ""
  if (!isImageMime(att.mime)) return false
  return !src.startsWith("file://")
}
