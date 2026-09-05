import ExpoModulesCore
import Foundation
import Network

public class TermixTailscaleModule: Module {
  private let nativeQueue = DispatchQueue(
    label: "expo.modules.termixtailscale.native",
    qos: .userInitiated,
    attributes: .concurrent
  )

  private var networkMonitor: NetworkPathSnapshotMonitor!

  public func definition() -> ModuleDefinition {
    Name("TermixTailscale")

    Events("onNetworkChanged")

    OnCreate {
      self.networkMonitor = NetworkPathSnapshotMonitor { [weak self] snapshot in
        self?.sendEvent("onNetworkChanged", snapshot.dictionary)
      }
      self.networkMonitor.start()
    }

    OnDestroy {
      self.networkMonitor?.stop()
      TermixTSBridge.cancelCurrentOperation()
    }

    Function("isAvailable") { () -> Bool in
      TermixTSBridge.isAvailable()
    }

    Function("cancelCurrentOperation") {
      TermixTSBridge.cancelCurrentOperation()
    }

    AsyncFunction("getNetworkSnapshot") { () -> [String: Any] in
      self.networkMonitor.snapshot().dictionary
    }.runOnQueue(nativeQueue)

    AsyncFunction("getDefaultStateDir") { () -> String in
      TermixTSBridge.defaultStateDir()
    }.runOnQueue(nativeQueue)

    // Bridge API returns nil / error strings (no NSError**), so Swift calls are
    // plain and do not depend on throwing-import name mangling.

    AsyncFunction("configure") { (options: [String: Any]) in
      let authKey = options["authKey"] as? String ?? ""
      let hostname = options["hostname"] as? String ?? "termix-mobile"
      let stateDir = options["stateDir"] as? String ?? TermixTSBridge.defaultStateDir()
      let ephemeral = options["ephemeral"] as? Bool ?? false

      if let message = TermixTSBridge.configure(
        withAuthKey: authKey,
        hostname: hostname,
        stateDir: stateDir,
        ephemeral: ephemeral
      ) {
        throw makeError(message)
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("up") {
      // The policy must be republished immediately before Go constructs tsnet's
      // live netmon. Empty/stale physical names are never reused.
      self.networkMonitor.publishLatestBeforeUp()
      if let message = TermixTSBridge.up() {
        throw makeError(message)
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("startForward") { (scheme: String, remoteHost: String, remotePort: Int) -> Int in
      let result = TermixTSBridge.startForward(
        withProtocol: scheme,
        host: remoteHost,
        port: Int32(remotePort)
      )
      if let message = result["error"] as? String {
        throw makeError(message)
      }
      guard let portNumber = result["localPort"] as? NSNumber else {
        throw makeError("startForward returned no localPort")
      }
      return portNumber.intValue
    }.runOnQueue(nativeQueue)

    AsyncFunction("stopForward") { (scheme: String, remoteHost: String, remotePort: Int, localPort: Int) in
      if let message = TermixTSBridge.stopForward(
        withProtocol: scheme,
        host: remoteHost,
        port: Int32(remotePort),
        localPort: Int32(localPort)
      ) {
        throw makeError(message)
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("stopAllForwards") {
      if let message = TermixTSBridge.stopAllForwards() {
        throw makeError(message)
      }
    }.runOnQueue(nativeQueue)

    AsyncFunction("isForwardActive") { (scheme: String, remoteHost: String, remotePort: Int, localPort: Int) -> Bool in
      TermixTSBridge.isForwardActive(
        withProtocol: scheme,
        host: remoteHost,
        port: Int32(remotePort),
        localPort: Int32(localPort)
      )
    }.runOnQueue(nativeQueue)

    AsyncFunction("probeForward") { (scheme: String, remoteHost: String, remotePort: Int, localPort: Int) -> Bool in
      TermixTSBridge.probeForward(
        withProtocol: scheme,
        host: remoteHost,
        port: Int32(remotePort),
        localPort: Int32(localPort)
      )
    }.runOnQueue(nativeQueue)

    AsyncFunction("isUp") { () -> Bool in
      TermixTSBridge.isUp()
    }.runOnQueue(nativeQueue)

    AsyncFunction("getIPs") { () -> String in
      TermixTSBridge.ips()
    }.runOnQueue(nativeQueue)

    AsyncFunction("close") {
      if let message = TermixTSBridge.close() {
        throw makeError(message)
      }
    }.runOnQueue(nativeQueue)
  }
}

private enum NativeRoutePolicy: Int32 {
  case unavailable = 0
  case physical = 1
  case systemVPN = 2
}

private struct NetworkSnapshotValue {
  let generation: Int
  let signature: String
  let status: String
  let transport: String
  let systemVPN: Bool
  let routePolicy: NativeRoutePolicy
  let physicalInterface: String

  static let unknown = NetworkSnapshotValue(
    generation: 0,
    signature: "unknown|none|vpn:0",
    status: "unknown",
    transport: "none",
    systemVPN: false,
    routePolicy: .unavailable,
    physicalInterface: ""
  )

  var dictionary: [String: Any] {
    [
      "generation": generation,
      "signature": signature,
      "status": status,
      "transport": transport,
      "systemVpn": systemVPN,
    ]
  }
}

private struct PathMaterialSnapshot {
  let signature: String
  let status: String
  let transport: String
  let systemVPN: Bool
  let routePolicy: NativeRoutePolicy
  let physicalInterface: String

  static func capture(_ path: NWPath) -> PathMaterialSnapshot {
    guard path.status == .satisfied else {
      return make(
        status: "offline",
        transport: "none",
        systemVPN: false,
        routePolicy: .unavailable,
        physicalInterface: ""
      )
    }

    let activelyUsesOther = path.usesInterfaceType(.other)
    let hasActiveTunnelInterface = path.availableInterfaces.contains { interface in
      interface.type == .other &&
        interface.name.lowercased().hasPrefix("utun")
    }
    let systemVPN = activelyUsesOther && hasActiveTunnelInterface
    if systemVPN {
      // A packet tunnel hides its underlay. Binding to an available Wi-Fi or
      // cellular interface would be a guess and can route outside the VPN.
      return make(
        status: "online",
        transport: "other",
        systemVPN: true,
        routePolicy: .systemVPN,
        physicalInterface: ""
      )
    }

    if let physical = selectUsedPhysicalInterface(from: path) {
      return make(
        status: "online",
        transport: physical.transport,
        systemVPN: false,
        routePolicy: .physical,
        physicalInterface: physical.name
      )
    }

    return make(
      status: "online",
      transport: "other",
      systemVPN: false,
      routePolicy: .unavailable,
      physicalInterface: ""
    )
  }

  private static func make(
    status: String,
    transport: String,
    systemVPN: Bool,
    routePolicy: NativeRoutePolicy,
    physicalInterface: String
  ) -> PathMaterialSnapshot {
    PathMaterialSnapshot(
      signature: "\(status)|\(transport)|vpn:\(systemVPN ? 1 : 0)",
      status: status,
      transport: transport,
      systemVPN: systemVPN,
      routePolicy: routePolicy,
      physicalInterface: physicalInterface
    )
  }

  private static func selectUsedPhysicalInterface(
    from path: NWPath
  ) -> (name: String, transport: String)? {
    let types: [(NWInterface.InterfaceType, String)] = [
      (.wiredEthernet, "wired"),
      (.wifi, "wifi"),
      (.cellular, "cellular"),
    ]

    for (type, transport) in types where path.usesInterfaceType(type) {
      let names = path.availableInterfaces.compactMap { interface -> String? in
        guard interface.type == type else { return nil }
        let name = interface.name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard
          !name.isEmpty,
          !name.lowercased().hasPrefix("utun")
        else {
          return nil
        }
        return name
      }.sorted()
      if let name = names.first {
        return (name, transport)
      }
    }
    return nil
  }
}

private final class NetworkPathSnapshotMonitor {
  private let monitor = NWPathMonitor()
  private let monitorQueue = DispatchQueue(
    label: "expo.modules.termixtailscale.network-path"
  )
  private let condition = NSCondition()
  private let onMaterialChange: (NetworkSnapshotValue) -> Void
  private var latest = NetworkSnapshotValue.unknown
  private var hasReceivedPath = false
  private var started = false

  init(onMaterialChange: @escaping (NetworkSnapshotValue) -> Void) {
    self.onMaterialChange = onMaterialChange
  }

  func start() {
    condition.lock()
    guard !started else {
      condition.unlock()
      return
    }
    started = true
    condition.unlock()

    monitor.pathUpdateHandler = { [weak self] path in
      self?.handle(path)
    }
    monitor.start(queue: monitorQueue)
  }

  func stop() {
    condition.lock()
    started = false
    monitor.pathUpdateHandler = nil
    condition.broadcast()
    condition.unlock()
    monitor.cancel()
  }

  func snapshot() -> NetworkSnapshotValue {
    condition.lock()
    defer { condition.unlock() }
    return latest
  }

  func publishLatestBeforeUp() {
    condition.lock()
    if !hasReceivedPath, started {
      _ = condition.wait(until: Date().addingTimeInterval(1))
    }
    publishRouteLocked(latest)
    condition.unlock()
  }

  private func handle(_ path: NWPath) {
    let material = PathMaterialSnapshot.capture(path)
    var eventSnapshot: NetworkSnapshotValue?

    condition.lock()
    guard started else {
      condition.unlock()
      return
    }
    let materialChanged = !hasReceivedPath || material.signature != latest.signature
    hasReceivedPath = true
    let nextGeneration: Int
    if materialChanged {
      nextGeneration = latest.generation == Int.max
        ? Int.max
        : latest.generation + 1
    } else {
      nextGeneration = latest.generation
    }
    latest = NetworkSnapshotValue(
      generation: nextGeneration,
      signature: material.signature,
      status: material.status,
      transport: material.transport,
      systemVPN: material.systemVPN,
      routePolicy: material.routePolicy,
      physicalInterface: material.physicalInterface
    )

    // Keep route publication ordered with immutable snapshot replacement. A
    // concurrent pre-Up publication can therefore never replay an older name.
    publishRouteLocked(latest)
    if materialChanged {
      // This call is immediate: it invalidates generations and contexts without
      // waiting for a blocked Go Up/Close. The JS event is emitted only after it.
      TermixTSBridge.cancelCurrentOperation()
      eventSnapshot = latest
    }
    condition.broadcast()
    condition.unlock()

    if let eventSnapshot {
      onMaterialChange(eventSnapshot)
    }
  }

  private func publishRouteLocked(_ snapshot: NetworkSnapshotValue) {
    TermixTSBridge.updateRoutePolicy(
      snapshot.routePolicy.rawValue,
      physicalInterface: snapshot.physicalInterface,
      generation: UInt64(snapshot.generation)
    )
  }
}

private func makeError(_ message: String) -> NSError {
  NSError(
    domain: "TermixTailscale",
    code: 1,
    userInfo: [NSLocalizedDescriptionKey: message]
  )
}
