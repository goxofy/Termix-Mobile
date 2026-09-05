package expo.modules.termixtailscale

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Android bridge for the Termix Tailscale userspace library.
 *
 * The ConnectivityManager monitor is independent of the optional Go library so
 * callers can still make a Direct/Tailscale policy decision in fallback builds.
 */
class TermixTailscaleModule : Module() {
  @Volatile
  private var libraryLoaded = false

  @Volatile
  private var networkMonitorStarted = false

  private val snapshotLock = Any()
  private var latestNetworkSnapshot = NetworkSnapshot.unknown()
  private var hasNetworkSnapshot = false
  private var connectivityManager: ConnectivityManager? = null

  private val networkCallback = object : ConnectivityManager.NetworkCallback() {
    override fun onAvailable(network: Network) = refreshNetworkSnapshot()

    override fun onLost(network: Network) = refreshNetworkSnapshot()

    override fun onCapabilitiesChanged(
      network: Network,
      networkCapabilities: NetworkCapabilities,
    ) = refreshNetworkSnapshot()
  }

  // -- JNI bindings (see src/main/cpp/termix_ts_jni.c) ---------------------
  private external fun nativeConfigure(
    authKey: String,
    hostname: String,
    stateDir: String,
    ephemeral: Boolean,
  ): Int

  private external fun nativeUp(): Int
  private external fun nativeClose(): Int
  private external fun nativeCancelCurrentOperation()
  private external fun nativeStartForward(
    protocol: String,
    remoteHost: String,
    remotePort: Int,
  ): Int

  private external fun nativeStopForward(
    protocol: String,
    remoteHost: String,
    remotePort: Int,
    localPort: Int,
  ): Int

  private external fun nativeStopAllForwards(): Int
  private external fun nativeIsForwardActive(
    protocol: String,
    remoteHost: String,
    remotePort: Int,
    localPort: Int,
  ): Boolean

  private external fun nativeProbeForward(
    protocol: String,
    remoteHost: String,
    remotePort: Int,
    localPort: Int,
  ): Boolean

  private external fun nativeIsUp(): Boolean
  private external fun nativeGetIPs(): String
  private external fun nativeLastError(): String

  override fun definition() = ModuleDefinition {
    Name("TermixTailscale")

    Events("onNetworkChanged")

    OnCreate {
      libraryLoaded = loadNativeLibraries()
      startNetworkMonitor()
    }

    OnDestroy {
      stopNetworkMonitor()
      if (libraryLoaded) nativeCancelCurrentOperation()
    }

    Function("isAvailable") {
      libraryLoaded
    }

    Function("cancelCurrentOperation") {
      if (libraryLoaded) nativeCancelCurrentOperation()
    }

    AsyncFunction("getNetworkSnapshot") {
      synchronized(snapshotLock) { latestNetworkSnapshot.toMap() }
    }

    AsyncFunction("getDefaultStateDir") {
      val base = appContext.reactContext?.filesDir
        ?: throw Exception("No Android filesDir")
      val dir = File(base, "TermixTailscale")
      if (!dir.exists()) dir.mkdirs()
      dir.absolutePath
    }

    AsyncFunction("configure") { options: Map<String, Any?> ->
      ensureLoaded()
      val authKey = options["authKey"] as? String ?: ""
      val hostname = options["hostname"] as? String ?: "termix-mobile"
      val stateDir = options["stateDir"] as? String
        ?: appContext.reactContext?.filesDir?.absolutePath ?: ""
      val ephemeral = options["ephemeral"] as? Boolean ?: false

      val rc = nativeConfigure(authKey, hostname, stateDir, ephemeral)
      if (rc != 0) throw Exception(nativeLastError())
    }

    AsyncFunction("up") {
      ensureLoaded()
      val rc = nativeUp()
      if (rc != 0) throw Exception(nativeLastError())
    }

    AsyncFunction("startForward") { protocol: String, remoteHost: String, remotePort: Int ->
      ensureLoaded()
      val localPort = nativeStartForward(protocol, remoteHost, remotePort)
      if (localPort <= 0) throw Exception(nativeLastError())
      localPort
    }

    AsyncFunction("stopForward") { protocol: String, remoteHost: String, remotePort: Int, localPort: Int ->
      ensureLoaded()
      val rc = nativeStopForward(protocol, remoteHost, remotePort, localPort)
      if (rc != 0) throw Exception(nativeLastError())
    }

    AsyncFunction("stopAllForwards") {
      if (libraryLoaded) {
        val rc = nativeStopAllForwards()
        if (rc != 0) throw Exception(nativeLastError())
      }
    }

    AsyncFunction("isForwardActive") { protocol: String, remoteHost: String, remotePort: Int, localPort: Int ->
      if (!libraryLoaded) false else nativeIsForwardActive(protocol, remoteHost, remotePort, localPort)
    }

    AsyncFunction("probeForward") { protocol: String, remoteHost: String, remotePort: Int, localPort: Int ->
      if (!libraryLoaded) false else nativeProbeForward(protocol, remoteHost, remotePort, localPort)
    }

    AsyncFunction("isUp") {
      if (!libraryLoaded) false else nativeIsUp()
    }

    AsyncFunction("getIPs") {
      if (!libraryLoaded) "" else nativeGetIPs()
    }

    AsyncFunction("close") {
      if (libraryLoaded) {
        val rc = nativeClose()
        if (rc != 0) throw Exception(nativeLastError())
      }
    }
  }

  private fun startNetworkMonitor() {
    val context = appContext.reactContext ?: return
    val manager = context.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager
      ?: return
    connectivityManager = manager
    try {
      manager.registerDefaultNetworkCallback(networkCallback)
      networkMonitorStarted = true
      refreshNetworkSnapshot()
    } catch (_: SecurityException) {
      publishUnknownSnapshot()
    } catch (_: RuntimeException) {
      publishUnknownSnapshot()
    }
  }

  private fun stopNetworkMonitor() {
    val manager = connectivityManager
    connectivityManager = null
    if (manager != null && networkMonitorStarted) {
      try {
        manager.unregisterNetworkCallback(networkCallback)
      } catch (_: IllegalArgumentException) {
        // Callback was already removed with the React context.
      }
    }
    networkMonitorStarted = false
  }

  private fun refreshNetworkSnapshot() {
    val manager = connectivityManager ?: return
    val material = try {
      captureMaterialSnapshot(manager)
    } catch (_: SecurityException) {
      MaterialNetworkSnapshot.unknown()
    } catch (_: RuntimeException) {
      MaterialNetworkSnapshot.unknown()
    }
    publishMaterialSnapshot(material)
  }

  private fun publishUnknownSnapshot() {
    publishMaterialSnapshot(MaterialNetworkSnapshot.unknown())
  }

  private fun publishMaterialSnapshot(material: MaterialNetworkSnapshot) {
    val next: NetworkSnapshot
    val changed: Boolean
    synchronized(snapshotLock) {
      changed = !hasNetworkSnapshot || material.signature != latestNetworkSnapshot.signature
      hasNetworkSnapshot = true
      val generation = if (changed && latestNetworkSnapshot.generation < Long.MAX_VALUE) {
        latestNetworkSnapshot.generation + 1
      } else {
        latestNetworkSnapshot.generation
      }
      next = NetworkSnapshot(
        generation = generation,
        signature = material.signature,
        status = material.status,
        transport = material.transport,
        systemVpn = material.systemVpn,
      )
      latestNetworkSnapshot = next
    }

    if (changed) {
      // This ABI only invalidates generations and cancels contexts; it never
      // waits for Go cleanup, so ConnectivityManager's callback cannot block.
      if (libraryLoaded) nativeCancelCurrentOperation()
      sendEvent("onNetworkChanged", next.toMap())
    }
  }

  private fun captureMaterialSnapshot(manager: ConnectivityManager): MaterialNetworkSnapshot {
    val activeNetwork = manager.activeNetwork ?: return MaterialNetworkSnapshot.offline()
    val activeCapabilities = manager.getNetworkCapabilities(activeNetwork)
      ?: return MaterialNetworkSnapshot.offline()
    val systemVpn = activeCapabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    val transport = physicalTransport(activeCapabilities)
      ?: (if (systemVpn) findVpnUnderlayTransport(manager, activeNetwork) else null)
      ?: "other"
    return MaterialNetworkSnapshot.online(transport, systemVpn)
  }

  private fun findVpnUnderlayTransport(
    manager: ConnectivityManager,
    activeNetwork: Network,
  ): String? {
    val candidates = manager.allNetworks.mapNotNull { network ->
      if (network == activeNetwork) return@mapNotNull null
      val capabilities = manager.getNetworkCapabilities(network) ?: return@mapNotNull null
      if (capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) return@mapNotNull null
      val transport = physicalTransport(capabilities) ?: return@mapNotNull null
      UnderlayCandidate(
        transport = transport,
        validated = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED),
        internet = capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET),
      )
    }
    return candidates.sortedWith(
      compareByDescending<UnderlayCandidate> { it.validated }
        .thenByDescending { it.internet }
        .thenBy { transportPriority(it.transport) }
    ).firstOrNull()?.transport
  }

  private fun physicalTransport(capabilities: NetworkCapabilities): String? = when {
    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET) -> "wired"
    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) -> "wifi"
    capabilities.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) -> "cellular"
    else -> null
  }

  private fun transportPriority(transport: String): Int = when (transport) {
    "wired" -> 0
    "wifi" -> 1
    "cellular" -> 2
    else -> 3
  }

  private fun ensureLoaded() {
    if (!libraryLoaded) {
      throw Exception(
        "Termix Tailscale native library not loaded. Run: make -C modules/termix-tailscale/native android"
      )
    }
  }

  private fun loadNativeLibraries(): Boolean = try {
    System.loadLibrary("termix_ts")
    System.loadLibrary("termix_ts_jni")
    true
  } catch (_: UnsatisfiedLinkError) {
    false
  } catch (_: Exception) {
    false
  }
}

private data class UnderlayCandidate(
  val transport: String,
  val validated: Boolean,
  val internet: Boolean,
)

private data class MaterialNetworkSnapshot(
  val signature: String,
  val status: String,
  val transport: String,
  val systemVpn: Boolean,
) {
  companion object {
    fun online(transport: String, systemVpn: Boolean) = create(
      status = "online",
      transport = transport,
      systemVpn = systemVpn,
    )

    fun offline() = create(
      status = "offline",
      transport = "none",
      systemVpn = false,
    )

    fun unknown() = create(
      status = "unknown",
      transport = "none",
      systemVpn = false,
    )

    private fun create(
      status: String,
      transport: String,
      systemVpn: Boolean,
    ) = MaterialNetworkSnapshot(
      signature = "$status|$transport|vpn:${if (systemVpn) 1 else 0}",
      status = status,
      transport = transport,
      systemVpn = systemVpn,
    )
  }
}

private data class NetworkSnapshot(
  val generation: Long,
  val signature: String,
  val status: String,
  val transport: String,
  val systemVpn: Boolean,
) {
  fun toMap(): Map<String, Any> = mapOf(
    "generation" to generation,
    "signature" to signature,
    "status" to status,
    "transport" to transport,
    "systemVpn" to systemVpn,
  )

  companion object {
    fun unknown() = NetworkSnapshot(
      generation = 0,
      signature = "unknown|none|vpn:0",
      status = "unknown",
      transport = "none",
      systemVpn = false,
    )
  }
}
