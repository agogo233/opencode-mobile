// True when a control-plane URL would carry the auth key over plaintext HTTP
// to a destination that is not private/internal. Loopback, dot-less internal
// hostnames, RFC1918, link-local and the tailnet CGNAT range all keep the
// key inside an encrypted (or non-routable) path; anything else over http://
// is worth a warning before the user commits credentials to it.
export function isInsecureControlUrl(url: string): boolean {
  const trimmed = url.trim()
  if (!/^http:\/\//i.test(trimmed)) return false
  let host: string
  try {
    host = new URL(trimmed).hostname
  } catch {
    return true
  }
  const bare = host.replace(/^\[|\]$/g, "")
  if (bare === "::1") return false
  // Other IPv6 literals get the warning too: only the loopback is clearly
  // safe, and the dialog is merely a confirmation, so erring toward warning
  // is the safe direction for public, ULA and link-local addresses alike.
  if (bare.includes(":")) return true
  if (!bare.includes(".")) return false
  if (/^127\./.test(bare)) return false
  if (/^10\./.test(bare)) return false
  if (/^192\.168\./.test(bare)) return false
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(bare)) return false
  if (/^169\.254\./.test(bare)) return false
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(bare)) return false
  return true
}
