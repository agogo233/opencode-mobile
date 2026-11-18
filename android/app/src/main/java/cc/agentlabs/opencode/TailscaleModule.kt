package cc.agentlabs.opencode

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactPackage
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.uimanager.ViewManager
import mobiletsnet.Forwarder
import mobiletsnet.Mobiletsnet
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors

class TailscalePackage : ReactPackage {
    override fun createNativeModules(reactContext: ReactApplicationContext) =
        listOf(TailscaleModule(reactContext))

    override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> = emptyList()
}

// Thin bridge to the embedded tsnet forwarder (mobiletsnet AAR). All work runs
// on a single background executor because tsnet's connect path blocks for up
// to 60s; JS sees promises only.
class TailscaleModule(private val reactContext: ReactApplicationContext) :
    ReactContextBaseJavaModule(reactContext) {

    private val executor = Executors.newSingleThreadExecutor()
    private val forwarder: Forwarder = Mobiletsnet.newForwarder()
    private var networkWatcherRegistered = false
    // Identity of the last start() so a repeated call with the same config can
    // skip the expensive close + reconnect (tsnet bring-up can take seconds).
    private var startedControlUrl: String? = null
    private var startedAuthKey: String? = null
    private var startedHostname: String? = null

    override fun getName() = "Tailscale"

    override fun onCatalystInstanceDestroy() {
        unregisterNetworkWatcher()
        executor.execute {
            forwarder.close()
            startedControlUrl = null
            startedAuthKey = null
            startedHostname = null
        }
    }

    @ReactMethod
    fun start(controlUrl: String, authKey: String, hostname: String, promise: Promise) {
        executor.execute {
            try {
                // Interface info must be supplied before tsnet boots: Android
                // denies Go's netlink interface enumeration on API 30+.
                injectNetworkInterfaces()
                registerNetworkWatcher()
                val state = forwarder.status()
                if (state.phase == "connected" &&
                    startedControlUrl == controlUrl &&
                    startedAuthKey == authKey &&
                    startedHostname == hostname
                ) {
                    promise.resolve(statusMap())
                    return@execute
                }
                forwarder.close() // idempotent reset so a new config always applies
                val stateDir = File(reactContext.filesDir, "tailscale").absolutePath
                forwarder.configureControl(authKey, controlUrl, hostname, stateDir)
                startedControlUrl = controlUrl
                startedAuthKey = authKey
                startedHostname = hostname
                forwarder.connect()
                promise.resolve(statusMap())
            } catch (e: Exception) {
                promise.reject("TS_START", e.message, e)
            }
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        executor.execute {
            try {
                forwarder.close()
                promise.resolve(statusMap())
            } catch (e: Exception) {
                promise.reject("TS_STOP", e.message, e)
            }
        }
    }

    @ReactMethod
    fun status(promise: Promise) {
        executor.execute {
            try {
                promise.resolve(statusMap())
            } catch (e: Exception) {
                promise.reject("TS_STATUS", e.message, e)
            }
        }
    }

    // Opens a loopback forward to the target opencode server. Resolves with
    // { id, port } — the app then talks to http://127.0.0.1:<port>.
    @ReactMethod
    fun forward(targetUrl: String, promise: Promise) {
        executor.execute {
            try {
                val id = forwarder.startForwardAuto(targetUrl, 0)
                val map = WritableNativeMap()
                map.putString("id", id)
                map.putInt("port", forwarder.getForwardLocalPort(id))
                promise.resolve(map)
            } catch (e: Exception) {
                promise.reject("TS_FORWARD", e.message, e)
            }
        }
    }

    @ReactMethod
    fun stopForward(id: String, promise: Promise) {
        executor.execute {
            try {
                forwarder.stopForward(id)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("TS_STOP_FORWARD", e.message, e)
            }
        }
    }

    private fun statusMap(): WritableNativeMap {
        val state = forwarder.status()
        val map = WritableNativeMap()
        map.putString("phase", state.phase)
        map.putString("hostname", state.hostname)
        map.putString("error", state.lastError)
        map.putInt("forwardCount", state.forwardCount)
        val addresses = WritableNativeMap()
        addresses.putString("ipv4", forwarder.getTailscaleIPv4())
        addresses.putString("ipv6", forwarder.getTailscaleIPv6())
        map.putMap("addresses", addresses)
        return map
    }

    // ---- Android network interface injection (tsnet cannot read netlink) ----

    private fun connectivity() =
        reactContext.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager

    private fun injectNetworkInterfaces() {
        val cm = connectivity()
        val payload = JSONArray()
        var defaultIfName = ""
        cm.activeNetwork?.let { network ->
            cm.getLinkProperties(network)?.interfaceName?.let { defaultIfName = it }
        }
        for (network in cm.allNetworks) {
            val props = cm.getLinkProperties(network) ?: continue
            val name = props.interfaceName ?: continue
            val caps = cm.getNetworkCapabilities(network)
            val iface = JSONObject()
            iface.put("name", name)
            iface.put("index", 0)
            iface.put("mtu", if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) props.mtu else 1500)
            iface.put("up", caps != null)
            iface.put("broadcast", true)
            iface.put("loopback", false)
            iface.put("pointToPoint", false)
            iface.put("multicast", true)
            val addrs = JSONArray()
            for (la in props.linkAddresses) {
                val ip = la.address.hostAddress ?: continue
                val addr = JSONObject()
                addr.put("ip", ip)
                addr.put("prefixLen", la.prefixLength)
                addrs.put(addr)
            }
            iface.put("addrs", addrs)
            payload.put(iface)
        }
        forwarder.setAndroidNetworkInterfaces(payload.toString(), defaultIfName)
    }

    private val networkCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onLinkPropertiesChanged(network: Network, linkProperties: LinkProperties) {
            // Underlying network changed (Wi-Fi <-> data): re-feed the snapshot
            // so tsnet's magicsock re-binds to the new default interface.
            try {
                injectNetworkInterfaces()
            } catch (_: Exception) {
                // best effort; the next callback will retry
            }
        }
    }

    private fun registerNetworkWatcher() {
        if (networkWatcherRegistered) return
        connectivity().registerDefaultNetworkCallback(networkCallback)
        networkWatcherRegistered = true
    }

    private fun unregisterNetworkWatcher() {
        if (!networkWatcherRegistered) return
        try {
            connectivity().unregisterNetworkCallback(networkCallback)
        } catch (_: Exception) {
            // callback may already be gone with the process
        }
        networkWatcherRegistered = false
    }
}
