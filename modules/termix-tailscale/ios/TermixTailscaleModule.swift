import ExpoModulesCore
import Foundation
import Network

public class TermixTailscaleModule: Module {
  private let routeMonitor = PhysicalDefaultRouteMonitor()

  public func definition() -> ModuleDefinition {
    Name("TermixTailscale")

    OnCreate {
      self.routeMonitor.start()
    }

    OnDestroy {
      self.routeMonitor.stop()
    }

    Function("isAvailable") { () -> Bool in
      TermixTSBridge.isAvailable()
    }

    AsyncFunction("getDefaultStateDir") { () -> String in
      TermixTSBridge.defaultStateDir()
    }

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
    }

    AsyncFunction("up") {
      // netmon consults this hint during tsnet startup, so synchronously republish
      // the latest validated physical interface immediately before entering Go.
      self.routeMonitor.publishLatestBeforeUp()
      if let message = TermixTSBridge.up() {
        throw makeError(message)
      }
    }

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
    }

    AsyncFunction("stopForward") { (scheme: String, remoteHost: String, remotePort: Int, localPort: Int) in
      if let message = TermixTSBridge.stopForward(
        withProtocol: scheme,
        host: remoteHost,
        port: Int32(remotePort),
        localPort: Int32(localPort)
      ) {
        throw makeError(message)
      }
    }

    AsyncFunction("stopAllForwards") {
      if let message = TermixTSBridge.stopAllForwards() {
        throw makeError(message)
      }
    }

    AsyncFunction("isForwardActive") { (scheme: String, remoteHost: String, remotePort: Int, localPort: Int) -> Bool in
      TermixTSBridge.isForwardActive(
        withProtocol: scheme,
        host: remoteHost,
        port: Int32(remotePort),
        localPort: Int32(localPort)
      )
    }

    AsyncFunction("probeForward") { (scheme: String, remoteHost: String, remotePort: Int, localPort: Int) -> Bool in
      TermixTSBridge.probeForward(
        withProtocol: scheme,
        host: remoteHost,
        port: Int32(remotePort),
        localPort: Int32(localPort)
      )
    }

    AsyncFunction("isUp") { () -> Bool in
      TermixTSBridge.isUp()
    }

    AsyncFunction("getIPs") { () -> String in
      TermixTSBridge.ips()
    }

    AsyncFunction("close") {
      if let message = TermixTSBridge.close() {
        throw makeError(message)
      }
    }
  }
}

private final class PhysicalDefaultRouteMonitor {
  private struct Candidate {
    let name: String
    let priority: Int
    let isUsedByPath: Bool
  }

  private let monitor = NWPathMonitor()
  private let monitorQueue = DispatchQueue(
    label: "expo.modules.termixtailscale.default-route"
  )
  private let condition = NSCondition()
  private var latestInterfaceName: String?
  private var started = false

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
    monitor.pathUpdateHandler = nil
    monitor.cancel()
  }

  func publishLatestBeforeUp() {
    condition.lock()
    if latestInterfaceName == nil {
      _ = condition.wait(until: Date().addingTimeInterval(1))
    }
    if let name = latestInterfaceName {
      // Keep selection and publication ordered with path updates so an older
      // cached value can never overwrite a newer callback.
      TermixTSBridge.updateDefaultRouteInterface(name)
    }
    condition.unlock()
  }

  private func handle(_ path: NWPath) {
    guard let name = Self.selectPhysicalInterface(from: path) else {
      return
    }

    condition.lock()
    if latestInterfaceName != name {
      latestInterfaceName = name
      TermixTSBridge.updateDefaultRouteInterface(name)
    }
    condition.broadcast()
    condition.unlock()
  }

  private static func selectPhysicalInterface(from path: NWPath) -> String? {
    guard path.status == .satisfied else {
      return nil
    }

    let candidates = path.availableInterfaces.compactMap { interface -> Candidate? in
      let name = interface.name.trimmingCharacters(in: .whitespacesAndNewlines)
      guard
        !name.isEmpty,
        !name.lowercased().hasPrefix("utun"),
        let priority = physicalPriority(for: interface.type)
      else {
        return nil
      }

      return Candidate(
        name: name,
        priority: priority,
        isUsedByPath: path.usesInterfaceType(interface.type)
      )
    }

    return candidates.sorted { lhs, rhs in
      if lhs.isUsedByPath != rhs.isUsedByPath {
        return lhs.isUsedByPath && !rhs.isUsedByPath
      }
      if lhs.priority != rhs.priority {
        return lhs.priority < rhs.priority
      }
      return lhs.name < rhs.name
    }.first?.name
  }

  private static func physicalPriority(
    for type: NWInterface.InterfaceType
  ) -> Int? {
    switch type {
    case .wiredEthernet:
      return 0
    case .wifi:
      return 1
    case .cellular:
      return 2
    case .loopback, .other:
      return nil
    @unknown default:
      return nil
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
