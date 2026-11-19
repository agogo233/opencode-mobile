package cc.agentlabs.opencode

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.os.Build
import com.facebook.react.ReactPackage
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod
import com.facebook.react.bridge.WritableNativeMap
import com.facebook.react.uimanager.ViewManager
import mobiletsnet.Forwarder
import mobiletsnet.Mobiletsnet
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException
import java.util.concurrent.atomic.AtomicBoolean

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

    // Atomic: the enrollment thread and the executor can both reach the
    // watcher register/unregister paths, and destroy runs on its own thread;
    // compareAndSet keeps the flag and the actual callback registration in
    // step without a lock.
    private val networkWatcherRegistered = AtomicBoolean(false)

    // Set once the RN context is gone. The keyless-enrollment thread does not
    // run on the executor (which is shut down on destroy), so every start
    // task checks this flag first; combined with the Go-side refusal to
    // connect a closed forwarder it prevents reviving the node after destroy.
    @Volatile
    private var destroyed = false
    // Identity of the last start() so a repeated call with the same config can
    // skip the expensive close + reconnect (tsnet bring-up can take seconds).
    // Volatile: a keyless enrollment runs on its own thread while the shared
    // executor keeps serving other methods.
    @Volatile
    private var startedControlUrl: String? = null

    @Volatile
    private var startedAuthKey: String? = null

    @Volatile
    private var startedHostname: String? = null

    @Volatile
    private var startedEphemeral: Boolean = false

    override fun getName() = "Tailscale"

    override fun onCatalystInstanceDestroy() {
        destroyed = true
        unregisterNetworkWatcher()
        executor.execute {
            forwarder.close()
            clearStartedIdentity(keepAllowlist = false)
        }
        // Graceful shutdown: the queued close task above still runs, but no
        // further work can be submitted after the catalyst instance is gone.
        executor.shutdown()
    }

    // keepAllowlist=false wipes the direct-connect target registry too; that
    // is only right when the RN context itself is gone. An explicit stop()
    // keeps the registry so a restart routes the already-registered targets
    // immediately instead of stranding active direct connections. The
    // allowlist is not identity material (host:port only), so keeping it
    // across stops does not widen the exposure.
    private fun clearStartedIdentity(keepAllowlist: Boolean) {
        startedControlUrl = null
        startedAuthKey = null
        startedHostname = null
        startedEphemeral = false
        TailscaleProxyState.socksPort = 0
        if (!keepAllowlist) {
            TailscaleProxyState.directHosts.clear()
            runCatching { forwarder.clearSocksTargets() }
        }
    }

    // Runs a task on the bridge executor. After the catalyst instance is
    // destroyed the executor is shut down; a late RN-bridge dispatch would
    // otherwise throw RejectedExecutionException at the call site and leave
    // the JS promise pending forever, so reject it explicitly instead.
    private fun dispatch(promise: Promise, task: () -> Unit) {
        try {
            executor.execute(task)
        } catch (_: RejectedExecutionException) {
            promise.reject("TS_SHUTDOWN", "Tailscale module destroyed", null)
        }
    }

    @ReactMethod
    fun start(controlUrl: String, authKey: String, hostname: String, ephemeral: Boolean, promise: Promise) {
        val task: () -> Unit = {
            if (destroyed) {
                promise.reject("TS_SHUTDOWN", "Tailscale module destroyed", null)
                return@task
            }
            try {
                // Interface info must be supplied before tsnet boots: Android
                // denies Go's netlink interface enumeration on API 30+.
                injectNetworkInterfaces()
                registerNetworkWatcher()
                val sameIdentity = forwarder.getPhase() == "connected" &&
                    startedControlUrl == controlUrl &&
                    startedAuthKey == authKey &&
                    startedHostname == hostname &&
                    startedEphemeral == ephemeral
                if (!sameIdentity) {
                    forwarder.close() // idempotent reset so a new config always applies
                    TailscaleProxyState.socksPort = 0
                    val stateDir = File(reactContext.filesDir, "tailscale").absolutePath
                    forwarder.configureControl(authKey, controlUrl, hostname, stateDir)
                    forwarder.setEphemeral(ephemeral)
                    startedControlUrl = controlUrl
                    startedAuthKey = authKey
                    startedHostname = hostname
                    startedEphemeral = ephemeral
                    forwarder.connect()
                }
                ensureSocks5Proxy()
                promise.resolve(statusMap())
            } catch (e: Exception) {
                promise.reject("TS_START", e.message, e)
            }
        }
        if (authKey.isBlank()) {
            // Keyless interactive enrollment blocks for minutes while the user
            // approves the node in the control server's web UI. Keep the shared
            // executor free so status()/forward() keep answering meanwhile.
            Thread(task, "tailscale-enroll").start()
        } else {
            dispatch(promise, task)
        }
    }

    @ReactMethod
    fun stop(promise: Promise) {
        dispatch(promise) {
            try {
                forwarder.close()
                // Don't keep the identity (incl. the auth key) in memory once
                // the user explicitly stopped the node; the direct-connect
                // target registry survives so a restart reconnects instantly.
                clearStartedIdentity(keepAllowlist = true)
                promise.resolve(statusMap())
            } catch (e: Exception) {
                promise.reject("TS_STOP", e.message, e)
            }
        }
    }

    @ReactMethod
    fun status(promise: Promise) {
        dispatch(promise) {
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
        dispatch(promise) {
            try {
                val id = forwarder.startForwardAuto(targetUrl, 0)
                val map = WritableNativeMap()
                map.putString("id", id)
                // gomobile maps Go int to Java long; JS wants a Number port.
                map.putInt("port", forwarder.getForwardLocalPort(id).toInt())
                promise.resolve(map)
            } catch (e: Exception) {
                promise.reject("TS_FORWARD", e.message, e)
            }
        }
    }

    @ReactMethod
    fun stopForward(id: String, promise: Promise) {
        dispatch(promise) {
            try {
                forwarder.stopForward(id)
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("TS_STOP_FORWARD", e.message, e)
            }
        }
    }

    // Precise liveness check: the forward with this exact ID is still
    // registered (and therefore its loopback port is being served).
    @ReactMethod
    fun isForwardAlive(id: String, promise: Promise) {
        dispatch(promise) {
            try {
                promise.resolve(forwarder.getForwardLocalPort(id) != 0L)
            } catch (e: Exception) {
                promise.reject("TS_FORWARD_ALIVE", e.message, e)
            }
        }
    }

    // The JS store owns the node's only forward; this lets it retire
    // everything (including leftovers from a dev-time reload) before opening
    // the one it needs.
    @ReactMethod
    fun stopAllForwards(promise: Promise) {
        dispatch(promise) {
            try {
                forwarder.stopAll()
                promise.resolve(null)
            } catch (e: Exception) {
                promise.reject("TS_STOP_ALL", e.message, e)
            }
        }
    }

    // Direct-connect mode: one loopback SOCKS5 proxy serves every registered
    // target through the global OkHttp proxy selector. Rebuilt on every start
    // (the Go side replaces the listener, last configuration wins) so the
    // cached port can never point at a dead listener. Non-fatal: the node is
    // up either way, direct mode just stays unavailable (socksPort stays 0).
    // doStart flips directMode before starting the node, so this reflects the
    // mode the upcoming connections will use. Relay mode keeps no listener at
    // all, matching the pre-direct-connect behavior.
    private fun ensureSocks5Proxy() {
        if (!TailscaleProxyState.directMode) {
            if (TailscaleProxyState.socksPort != 0) {
                forwarder.stopSocks5()
                TailscaleProxyState.socksPort = 0
            }
            return
        }
        runCatching {
            TailscaleProxyState.socksPort = forwarder.startSocks5(0).toInt()
        }.onFailure {
            // Never leave a stale port behind: the selector would route into
            // a dead listener. Fail closed instead (socksPort stays 0).
            TailscaleProxyState.socksPort = 0
        }
    }

    // ---- Direct-connect mode: routing switch + target allowlist ----

    @ReactMethod
    fun setDirectMode(enabled: Boolean, promise: Promise) {
        TailscaleProxyState.directMode = enabled
        promise.resolve(null)
    }

    // Registers a canonical "host:port" target for direct mode. The same
    // allowlist is mirrored into the Go proxy as a second gate; the Go side
    // is written first so a bridge failure can never leave the Java selector
    // allowing a target the Go gate would reject.
    @ReactMethod
    fun registerDirectHost(target: String, promise: Promise) {
        dispatch(promise) {
            val normalized = target.trim().lowercase()
            forwarder.allowSocksTarget(normalized)
            TailscaleProxyState.directHosts.add(normalized)
            promise.resolve(null)
        }
    }

    @ReactMethod
    fun unregisterDirectHost(target: String, promise: Promise) {
        dispatch(promise) {
            val normalized = target.trim().lowercase()
            forwarder.disallowSocksTarget(normalized)
            TailscaleProxyState.directHosts.remove(normalized)
            promise.resolve(null)
        }
    }

    private fun statusMap(): WritableNativeMap {
        // Use the primitive getters: gomobile struct-returning methods are not
        // usable from Kotlin here, and these map 1:1 onto the State fields.
        val map = WritableNativeMap()
        map.putString("phase", forwarder.getPhase())
        map.putString("hostname", forwarder.getHostname())
        map.putString("error", forwarder.getLastError())
        map.putString("loginUrl", forwarder.getLoginURL())
        map.putInt("forwardCount", forwarder.getForwardCount().toInt())
        map.putInt("socksPort", TailscaleProxyState.socksPort)
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
        if (!networkWatcherRegistered.compareAndSet(false, true)) return
        connectivity().registerDefaultNetworkCallback(networkCallback)
    }

    private fun unregisterNetworkWatcher() {
        if (!networkWatcherRegistered.compareAndSet(true, false)) return
        try {
            connectivity().unregisterNetworkCallback(networkCallback)
        } catch (_: Exception) {
            // callback may already be gone with the process
        }
    }
}
