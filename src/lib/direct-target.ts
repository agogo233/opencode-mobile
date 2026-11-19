// Canonical "host:port" for the direct-connect allowlist: lowercase host,
// explicit port (scheme default), IPv6 bracketed in the joined form —
// matching the native selector and Go allowlist normalization. Returns null
// for URLs that are not usable direct-connect targets. Kept free of any
// react-native imports so it stays unit-testable under node.
export function directTargetFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url)
    const scheme = parsed.protocol.replace(":", "").toLowerCase()
    if (scheme !== "http" && scheme !== "https") return null
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "")
    if (!host) return null
    const port = parsed.port || (scheme === "https" ? "443" : "80")
    const hostPart = host.includes(":") ? `[${host}]` : host
    return `${hostPart}:${port}`
  } catch {
    return null
  }
}
