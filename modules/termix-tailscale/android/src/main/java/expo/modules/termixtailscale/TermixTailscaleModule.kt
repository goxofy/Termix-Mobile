package expo.modules.termixtailscale

import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Android bridge for the Termix Tailscale userspace library.
 *
 * When `libtermix_ts.so` is present under jniLibs (built via
 * `make -C modules/termix-tailscale/native android`), JNI bindings apply.
 * Until then, methods report unavailable / throw a clear error so the JS
 * layer can fall back to direct connectivity.
 */
class TermixTailscaleModule : Module() {
  private var libraryLoaded = false

  override fun definition() = ModuleDefinition {
    Name("TermixTailscale")

    OnCreate {
      try {
        System.loadLibrary("termix_ts")
        libraryLoaded = true
      } catch (_: UnsatisfiedLinkError) {
        libraryLoaded = false
      }
    }

    Function("isAvailable") {
      libraryLoaded
    }

    AsyncFunction("getDefaultStateDir") {
      val base = appContext.reactContext?.filesDir
        ?: throw Exception("No Android filesDir")
      val dir = File(base, "TermixTailscale")
      if (!dir.exists()) dir.mkdirs()
      dir.absolutePath
    }

    AsyncFunction("configure") { options: Map<String, Any?>, promise: Promise ->
      if (!libraryLoaded) {
        promise.reject("E_TS_UNAVAILABLE", "libtermix_ts.so not built/linked", null)
        return@AsyncFunction
      }
      // JNI path filled when the shared library is produced with matching exports.
      promise.reject(
        "E_TS_JNI",
        "Android JNI wrappers not yet linked; build native lib and regenerate JNI",
        null
      )
    }

    AsyncFunction("up") { promise: Promise ->
      promise.reject("E_TS_UNAVAILABLE", unavailableMessage(), null)
    }

    AsyncFunction("startForward") { _: String, _: Int, promise: Promise ->
      promise.reject("E_TS_UNAVAILABLE", unavailableMessage(), null)
    }

    AsyncFunction("stopForward") { _: String, _: Int, _: Int, promise: Promise ->
      promise.resolve(null)
    }

    AsyncFunction("stopAllForwards") {
      // no-op when unavailable
    }

    AsyncFunction("isUp") {
      false
    }

    AsyncFunction("getIPs") {
      ""
    }

    AsyncFunction("close") {
      // no-op
    }
  }

  private fun unavailableMessage(): String {
    return if (!libraryLoaded) {
      "Termix Tailscale native library not loaded. Run: make -C modules/termix-tailscale/native android"
    } else {
      "Termix Tailscale Android JNI not fully wired yet"
    }
  }
}
