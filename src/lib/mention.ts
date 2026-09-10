// Pure helpers for @-file mention detection and server-side file:// URLs.
// No React Native imports — unit-testable with node --test.
//
// The opencode server resolves file parts by absolute server path, so a
// mention selected from /find/file results (relative to the project
// root) must be re-anchored to an absolute path before sending.

// stripTrailingSlash is inlined (not imported from ./path-utils) because
// node --test can't resolve that extensionless import and tsc forbids a
// .ts-extension import in app source.

function stripTrailingSlash(dir: string): string {
  return dir.replace(/[\\/]+$/, "") || dir
}

export interface MentionTrigger {
  // Index of the @ character
  startIndex: number
  // Text between @ and the caret
  query: string
}

/**
 * Detect an in-flight @-mention before the caret. Mirrors the web UI's
 * trigger rules: @ must sit at text start or after whitespace, and no
 * whitespace may follow @ before the caret. Returns null otherwise.
 * (An empty query — bare @ just typed — is a trigger too; the caller
 * decides whether to show the menu, which needs at least one character.)
 */
export function detectMentionTrigger(text: string, caret: number): MentionTrigger | null {
  const before = text.slice(0, caret)
  const start = before.lastIndexOf("@")
  if (start < 0) return null
  if (start > 0) {
    const ch = before[start - 1]
    if (ch !== " " && ch !== "\n" && ch !== "\t") return null
  }
  const query = before.slice(start + 1)
  if (/\s/.test(query)) return null
  return { startIndex: start, query }
}

/** Turn an absolute server path into the file:// URL the opencode server accepts in a file part. */
export function toFileUrl(absPath: string): string {
  const p = absPath.replace(/\\/g, "/")
  if (/^[a-zA-Z]:/.test(p)) return `file:///${p}` // Windows drive
  if (p.startsWith("/")) return `file://${p}`
  return `file:///${p}` // defensive: relative should not reach here
}

/**
 * Anchor a /find/file result to the project root. Results are normally
 * relative; if the server already answers with an absolute path (POSIX /
 * or Windows drive), it is used as-is.
 */
export function resolveAbsPath(relOrAbs: string, root: string): string {
  const norm = relOrAbs.replace(/\\/g, "/")
  if (norm.startsWith("/") || /^[a-zA-Z]:/.test(norm)) return norm
  if (norm === "" || norm === ".") return stripTrailingSlash(root)
  return `${stripTrailingSlash(root)}/${norm}`
}
