package cc.agentlabs.opencode

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI
import java.util.concurrent.CopyOnWriteArraySet

// Shared state between the Tailscale bridge (writer) and the OkHttp proxy
// selector (reader). socksPort 0 means the direct-connect proxy is not
// running; directMode is the user-facing switch; directHosts holds the
// registered "host:port" targets in canonical form (lowercase, explicit
// port, IPv6 bracketed in the joined form).
object TailscaleProxyState {
    @Volatile
    var socksPort: Int = 0

    @Volatile
    var directMode: Boolean = false

    val directHosts: MutableSet<String> = CopyOnWriteArraySet()
}

// Routes OkHttp traffic in direct mode: only registered server targets go
// through the embedded tsnet SOCKS5 proxy; everything else (crash reporting,
// update checks, non-tailscale connections) connects directly. The Go side
// enforces the same allowlist as a second gate, so the exposure matches the
// per-target relay mode.
class TailscaleProxySelector : ProxySelector() {
    override fun select(uri: URI?): List<Proxy> {
        if (uri == null || !TailscaleProxyState.directMode) return listOf(Proxy.NO_PROXY)
        val port = TailscaleProxyState.socksPort
        if (port == 0) return listOf(Proxy.NO_PROXY)
        val target = normalizeTarget(uri) ?: return listOf(Proxy.NO_PROXY)
        if (!TailscaleProxyState.directHosts.contains(target)) return listOf(Proxy.NO_PROXY)
        return listOf(Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", port)))
    }

    override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) {
        // OkHttp fails the request itself; the proxy lifecycle is owned by
        // the Tailscale module, so there is nothing to recover here.
    }

    companion object {
        // Canonical "host:port" for comparison: lowercase host, explicit
        // port (scheme default), IPv6 bracketed in the joined form — matching
        // the JS registration and the Go allowlist normalization.
        fun normalizeTarget(uri: URI): String? {
            val scheme = uri.scheme?.lowercase() ?: return null
            if (scheme != "http" && scheme != "https") return null
            val host = uri.host?.lowercase()?.trim('[', ']') ?: return null
            if (host.isEmpty()) return null
            val port = if (uri.port != -1) uri.port else if (scheme == "https") 443 else 80
            val hostPart = if (host.contains(":")) "[$host]" else host
            return "$hostPart:$port"
        }
    }
}
