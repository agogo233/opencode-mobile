import type { ConnectionType } from "./types"

// Thrown when a tailscale-type connection cannot get its loopback forward.
// Callers must fail closed: silently falling back to the configured URL would
// send traffic (and basic-auth credentials) outside the encrypted tunnel.
export class TailscaleUnavailableError extends Error {
  constructor(message = "Tailscale is not connected") {
    super(message)
    this.name = "TailscaleUnavailableError"
  }
}

// Resolve the URL a client should actually talk to. Tailscale-type
// connections go through the embedded tsnet forwarder on loopback; every
// other type connects to the configured URL directly. `ensureForward` is
// injected to keep this pure and unit-testable.
export async function resolveBaseUrl(
  connection: Pick<{ type: ConnectionType; url: string }, "type" | "url">,
  ensureForward: (targetUrl: string) => Promise<number | null>,
): Promise<string> {
  if (connection.type !== "tailscale") return connection.url
  const port = await ensureForward(connection.url)
  if (!port) throw new TailscaleUnavailableError()
  return `http://127.0.0.1:${port}`
}
