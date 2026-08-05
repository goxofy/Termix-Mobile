import ExpoModulesCore
import Foundation

public class TermixTailscaleModule: Module {
  public func definition() -> ModuleDefinition {
    Name("TermixTailscale")

    Function("isAvailable") { () -> Bool in
      true
    }

    AsyncFunction("getDefaultStateDir") { () -> String in
      TermixTSBridge.defaultStateDir()
    }

    AsyncFunction("configure") { (options: [String: Any]) in
      let authKey = options["authKey"] as? String ?? ""
      let hostname = options["hostname"] as? String ?? "termix-mobile"
      let stateDir = options["stateDir"] as? String ?? TermixTSBridge.defaultStateDir()
      let ephemeral = options["ephemeral"] as? Bool ?? false

      var error: NSError?
      let ok = TermixTSBridge.configure(
        withAuthKey: authKey,
        hostname: hostname,
        stateDir: stateDir,
        ephemeral: ephemeral,
        error: &error
      )
      if !ok {
        throw error ?? makeError("configure failed")
      }
    }

    AsyncFunction("up") {
      var error: NSError?
      let ok = TermixTSBridge.upWithError(&error)
      if !ok {
        throw error ?? makeError("up failed")
      }
    }

    AsyncFunction("startForward") { (remoteHost: String, remotePort: Int) -> Int in
      var error: NSError?
      guard let port = TermixTSBridge.startForward(
        toHost: remoteHost,
        port: Int32(remotePort),
        error: &error
      ) else {
        throw error ?? makeError("startForward failed")
      }
      return port.intValue
    }

    AsyncFunction("stopForward") { (remoteHost: String, remotePort: Int, localPort: Int) in
      var error: NSError?
      let ok = TermixTSBridge.stopForward(
        toHost: remoteHost,
        port: Int32(remotePort),
        localPort: Int32(localPort),
        error: &error
      )
      if !ok {
        throw error ?? makeError("stopForward failed")
      }
    }

    AsyncFunction("stopAllForwards") {
      TermixTSBridge.stopAllForwards()
    }

    AsyncFunction("isUp") { () -> Bool in
      TermixTSBridge.isUp()
    }

    AsyncFunction("getIPs") { () -> String in
      TermixTSBridge.ips()
    }

    AsyncFunction("close") {
      TermixTSBridge.close()
    }
  }
}

private func makeError(_ message: String) -> NSError {
  NSError(
    domain: "TermixTailscale",
    code: 1,
    userInfo: [NSLocalizedDescriptionKey: message]
  )
}
