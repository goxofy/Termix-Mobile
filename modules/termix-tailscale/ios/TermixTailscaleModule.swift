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

    // ObjC methods ending in NSError** import into Swift as `throws`
    // (do not pass an `error:` argument).

    AsyncFunction("configure") { (options: [String: Any]) in
      let authKey = options["authKey"] as? String ?? ""
      let hostname = options["hostname"] as? String ?? "termix-mobile"
      let stateDir = options["stateDir"] as? String ?? TermixTSBridge.defaultStateDir()
      let ephemeral = options["ephemeral"] as? Bool ?? false

      try TermixTSBridge.configure(
        withAuthKey: authKey,
        hostname: hostname,
        stateDir: stateDir,
        ephemeral: ephemeral
      )
    }

    AsyncFunction("up") {
      try TermixTSBridge.up()
    }

    AsyncFunction("startForward") { (remoteHost: String, remotePort: Int) -> Int in
      let port = try TermixTSBridge.startForward(
        toHost: remoteHost,
        port: Int32(remotePort)
      )
      return port.intValue
    }

    AsyncFunction("stopForward") { (remoteHost: String, remotePort: Int, localPort: Int) in
      try TermixTSBridge.stopForward(
        toHost: remoteHost,
        port: Int32(remotePort),
        localPort: Int32(localPort)
      )
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
