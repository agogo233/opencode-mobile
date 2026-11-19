package cc.agentlabs.opencode

import java.io.IOException
import java.net.InetSocketAddress
import java.net.Proxy
import java.net.ProxySelector
import java.net.SocketAddress
import java.net.URI

// Shared state between the Tailscale bridge (writer) and the OkHttp proxy
// selector (reader). Zero means the direct-connect proxy is not running.
object TailscaleProxyState {
    @Volatile
    var socksPort: Int = 0
}

// Routes OkHttp traffic: destinations inside the Tailscale address space go
// through the embedded tsnet SOCKS5 proxy, everything else connects directly.
// Spike scope: IPv4 literals in the Tailscale CGNAT block. MagicDNS hostnames
// are not routed yet.
class TailscaleProxySelector : ProxySelector() {
    override fun select(uri: URI?): List<Proxy> {
        val port = TailscaleProxyState.socksPort
        if (uri == null || port == 0) return listOf(Proxy.NO_PROXY)
        val host = uri.host ?: return listOf(Proxy.NO_PROXY)
        if (!isTailscaleIPv4(host)) return listOf(Proxy.NO_PROXY)
        val proxy = Proxy(Proxy.Type.SOCKS, InetSocketAddress("127.0.0.1", port))
        return listOf(proxy)
    }

    override fun connectFailed(uri: URI?, sa: SocketAddress?, ioe: IOException?) {
        // OkHttp fails the request itself; the proxy lifecycle is owned by
        // the Tailscale module, so there is nothing to recover here.
    }

    private fun isTailscaleIPv4(host: String): Boolean {
        val parts = host.split(".")
        if (parts.size != 4) return false
        val octets = parts.map { it.toIntOrNull() ?: return false }
        if (octets.any { it < 0 || it > 255 }) return false
        // 100.64.0.0/10 — the CGNAT block Tailscale assigns node addresses from.
        return octets[0] == 100 && octets[1] in 64..127
    }
}
