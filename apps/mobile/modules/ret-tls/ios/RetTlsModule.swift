import CryptoKit
import ExpoModulesCore
import Network
import Security

/**
 * Ret's remote-access transport on iOS: TLS 1.3 connections that present this device's key and
 * pin the other side's, the same as the desktop's (src/main/remote). Network.framework does TLS;
 * the device key lives in the keychain and never leaves it.
 *
 * Lines are split here, not in JavaScript: a thread's history is one line of many MB, and a chunk
 * can end inside a UTF-8 character. Only whole lines cross over, in batches.
 */
public class RetTlsModule: Module {
  private let queue = DispatchQueue(label: "dev.ret.tls")
  private var connections: [Int: TlsConnection] = [:]
  private var nextId = 1
  private var browser: Browser?

  public func definition() -> ModuleDefinition {
    Name("RetTls")

    Events("onLines", "onClose", "onServices")

    // Identity

    AsyncFunction("identity") { () -> [String: Any?] in
      let key = try DeviceKey.loadOrCreate()
      return [
        "publicKey": try DeviceKey.publicPoint(key).base64EncodedString(),
        "certificate": DeviceKey.certificate().map { SecCertificateCopyData($0) as Data }?.base64EncodedString(),
      ]
    }

    AsyncFunction("sign") { (data: String) -> String in
      guard let bytes = Data(base64Encoded: data) else { throw TlsError("Bad data to sign") }
      return try DeviceKey.sign(bytes).base64EncodedString()
    }

    AsyncFunction("setCertificate") { (der: String) in
      guard let bytes = Data(base64Encoded: der) else { throw TlsError("Bad certificate") }
      try DeviceKey.setCertificate(bytes)
    }

    AsyncFunction("resetIdentity") {
      DeviceKey.reset()
    }

    // Connections

    AsyncFunction("connect") { (options: ConnectOptions, promise: Promise) in
      self.queue.async { self.open(options, promise) }
    }

    AsyncFunction("exportKeyingMaterial") { (id: Int, label: String, length: Int, promise: Promise) in
      self.queue.async {
        guard let c = self.connections[id] else { return promise.reject(TlsError("Not connected")) }
        do { promise.resolve(try c.exportKeyingMaterial(label: label, length: length).base64EncodedString()) } catch { promise.reject(error) }
      }
    }

    Function("write") { (id: Int, text: String) in
      self.queue.async { self.connections[id]?.write(text) }
    }

    Function("setMaxLine") { (id: Int, max: Int) in
      self.queue.async { self.connections[id]?.maxLine = max }
    }

    Function("close") { (id: Int) in
      self.queue.async { self.connections[id]?.close("Closed") }
    }

    // Discovery

    Function("startDiscovery") { (type: String) in
      self.queue.async { [weak self] in
        guard let self else { return }
        if let browser = self.browser { return browser.report() }
        self.browser = Browser(type: type, queue: self.queue) { [weak self] services in
          self?.sendEvent("onServices", ["services": services])
        }
      }
    }

    Function("stopDiscovery") {
      self.queue.async {
        self.browser?.stop()
        self.browser = nil
      }
    }

    OnDestroy {
      self.queue.async {
        for c in self.connections.values { c.close("Closed") }
        self.browser?.stop()
        self.browser = nil
      }
    }
  }

  private func open(_ options: ConnectOptions, _ promise: Promise) {
    let identity: SecIdentity
    do { identity = try DeviceKey.identity() } catch { return promise.reject(error) }
    guard let port = NWEndpoint.Port(rawValue: UInt16(clamping: options.port)), options.port > 0 else {
      return promise.reject(TlsError("Bad port"))
    }
    let id = nextId
    nextId += 1
    let expect = options.expect?.lowercased()
    var peer: String?

    let tls = NWProtocolTLS.Options()
    let sec = tls.securityProtocolOptions
    sec_protocol_options_set_min_tls_protocol_version(sec, .TLSv13)
    if let local = sec_identity_create(identity) { sec_protocol_options_set_local_identity(sec, local) }
    // Self-signed on both sides: a device is who its key says. Pinned keys are checked here, in
    // the handshake; while pairing any key is let through and reported, and the pairing binds it.
    sec_protocol_options_set_verify_block(sec, { _, trust, complete in
      guard let id = peerKeyId(sec_trust_copy_ref(trust).takeRetainedValue()) else { return complete(false) }
      peer = id
      complete(expect == nil || expect == id)
    }, queue)

    let tcp = NWProtocolTCP.Options()
    tcp.noDelay = true
    tcp.connectionTimeout = max(1, options.timeoutMs / 1000)
    tcp.enableKeepalive = true
    tcp.keepaliveIdle = 15
    let params = NWParameters(tls: tls, tcp: tcp)

    let conn = NWConnection(host: NWEndpoint.Host(options.host), port: port, using: params)
    let c = TlsConnection(id: id, conn: conn, maxLine: options.maxLine)
    var settled = false
    let timeout = DispatchWorkItem { [weak self] in
      guard !settled else { return }
      settled = true
      conn.cancel()
      self?.connections[id] = nil
      promise.reject(TlsError("timed out"))
    }
    queue.asyncAfter(deadline: .now() + .milliseconds(options.timeoutMs), execute: timeout)

    c.onLines = { [weak self] lines in self?.sendEvent("onLines", ["id": id, "lines": lines]) }
    c.onClose = { [weak self] reason in
      self?.connections[id] = nil
      self?.sendEvent("onClose", ["id": id, "reason": reason])
    }
    conn.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        guard !settled else { return }
        settled = true
        timeout.cancel()
        guard let peer else {
          conn.cancel()
          return promise.reject(TlsError("No device key from the other side"))
        }
        self?.connections[id] = c
        c.start()
        promise.resolve(["id": id, "peer": peer])
      case .failed(let error), .waiting(let error):
        if settled { return c.close(describe(error)) }
        settled = true
        timeout.cancel()
        conn.cancel()
        promise.reject(TlsError(expect != nil && peer != nil && peer != expect ? "a different device" : describe(error)))
      case .cancelled:
        if !settled {
          settled = true
          timeout.cancel()
          promise.reject(TlsError("cancelled"))
        }
      default:
        break
      }
    }
    conn.start(queue: queue)
  }
}

struct ConnectOptions: Record {
  @Field var host: String = ""
  @Field var port: Int = 0
  /** The device id (SHA-256 of its public key, hex) the other side must have; nil while pairing. */
  @Field var expect: String? = nil
  @Field var timeoutMs: Int = 8000
  /** Longest line accepted before the connection is dropped (raised once the peer is trusted). */
  @Field var maxLine: Int = 64 * 1024
}

struct TlsError: Error, LocalizedError {
  let message: String
  init(_ message: String) { self.message = message }
  var errorDescription: String? { message }
}

private func describe(_ error: NWError) -> String {
  switch error {
  case .posix(let code): return String(cString: strerror(code.rawValue))
  case .tls(let status): return "TLS error \(status)"
  case .dns(let code): return "DNS error \(code)"
  default: return error.localizedDescription
  }
}

/** DER SubjectPublicKeyInfo prefix for a P-256 key, followed by its 65-byte uncompressed point. */
let p256SpkiPrefix = Data([
  0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a,
  0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00,
])

func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

/** The device id of whoever holds a certificate's key: SHA-256 of its SubjectPublicKeyInfo (as the desktop's keyId). */
func peerKeyId(_ trust: SecTrust) -> String? {
  guard let chain = SecTrustCopyCertificateChain(trust) as? [SecCertificate], let leaf = chain.first,
    let key = SecCertificateCopyKey(leaf),
    let attrs = SecKeyCopyAttributes(key) as? [CFString: Any],
    (attrs[kSecAttrKeyType] as? String) == (kSecAttrKeyTypeECSECPrimeRandom as String),
    (attrs[kSecAttrKeySizeInBits] as? Int) == 256,
    let point = SecKeyCopyExternalRepresentation(key, nil) as Data?, point.count == 65
  else { return nil }
  return hex(Data(SHA256.hash(data: p256SpkiPrefix + point)))
}

// MARK: - Connection

final class TlsConnection {
  let id: Int
  let conn: NWConnection
  var maxLine: Int
  var onLines: (([String]) -> Void)?
  var onClose: ((String) -> Void)?
  private var partial = Data()
  private var closed = false

  init(id: Int, conn: NWConnection, maxLine: Int) {
    self.id = id
    self.conn = conn
    self.maxLine = maxLine
  }

  func start() { receive() }

  func write(_ text: String) {
    guard !closed else { return }
    conn.send(content: Data(text.utf8), completion: .contentProcessed { [weak self] error in
      if let error { self?.close(describe(error)) }
    })
  }

  func close(_ reason: String) {
    guard !closed else { return }
    closed = true
    // Let what was written go out (a goodbye), then end the connection.
    conn.send(content: nil, contentContext: .finalMessage, isComplete: true, completion: .contentProcessed { [conn] _ in conn.cancel() })
    conn.stateUpdateHandler = nil
    onClose?(reason)
  }

  /** RFC 8446 §7.5 exporter. Node's exportKeyingMaterial with an empty context derives the same in TLS 1.3. */
  func exportKeyingMaterial(label: String, length: Int) throws -> Data {
    guard let meta = conn.metadata(definition: NWProtocolTLS.definition) as? NWProtocolTLS.Metadata else {
      throw TlsError("No TLS session")
    }
    let secret = label.withCString { ptr in
      sec_protocol_metadata_create_secret(meta.securityProtocolMetadata, label.utf8.count, ptr, length)
    }
    guard let secret else { throw TlsError("Couldn't export keying material") }
    var out = Data()
    (secret as DispatchData).enumerateBytes { bytes, _, _ in out.append(contentsOf: bytes) }
    guard out.count == length else { throw TlsError("Couldn't export keying material") }
    return out
  }

  private func receive() {
    conn.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) { [weak self] data, _, isComplete, error in
      guard let self, !self.closed else { return }
      if let data, !data.isEmpty { self.take(data) }
      if self.closed { return }
      if isComplete { self.close("Connection closed") }
      else if let error { self.close(describe(error)) }
      else { self.receive() }
    }
  }

  private func take(_ chunk: Data) {
    var lines: [String] = []
    var start = chunk.startIndex
    // Only the new chunk is searched for line ends.
    while let nl = chunk[start...].firstIndex(of: 0x0A) {
      let line: Data
      if partial.isEmpty { line = chunk[start..<nl] } else {
        partial.append(chunk[start..<nl])
        line = partial
        partial = Data()
      }
      if line.count > maxLine { return close("Message too long") }
      lines.append(String(decoding: line, as: UTF8.self))
      start = chunk.index(after: nl)
    }
    if start < chunk.endIndex {
      partial.append(chunk[start...])
      if partial.count > maxLine { return close("Message too long") }
    }
    if !lines.isEmpty { onLines?(lines) }
  }
}

// MARK: - Device key

/**
 * This device's identity: a P-256 key in the keychain (this device only, never synced or backed
 * up) and the self-signed certificate around it that the JavaScript side builds and has signed.
 */
enum DeviceKey {
  static let tag = "app.getret.mobile.device-key".data(using: .utf8)!
  static let certLabel = "Ret device certificate"

  static func load() -> SecKey? {
    let query: [CFString: Any] = [
      kSecClass: kSecClassKey,
      kSecAttrApplicationTag: tag,
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecReturnRef: true,
    ]
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let out else { return nil }
    return (out as! SecKey)
  }

  static func loadOrCreate() throws -> SecKey {
    if let key = load() { return key }
    // A new key means a new device: any certificate from before belongs to the old one.
    deleteCertificate()
    let attrs: [CFString: Any] = [
      kSecAttrKeyType: kSecAttrKeyTypeECSECPrimeRandom,
      kSecAttrKeySizeInBits: 256,
      kSecPrivateKeyAttrs: [
        kSecAttrIsPermanent: true,
        kSecAttrApplicationTag: tag,
        kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
      ] as [CFString: Any],
    ]
    var error: Unmanaged<CFError>?
    guard let key = SecKeyCreateRandomKey(attrs as CFDictionary, &error) else {
      throw TlsError("Couldn't create the device key: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
    }
    return key
  }

  static func publicPoint(_ key: SecKey) throws -> Data {
    guard let pub = SecKeyCopyPublicKey(key), let point = SecKeyCopyExternalRepresentation(pub, nil) as Data? else {
      throw TlsError("Couldn't read the device key")
    }
    return point
  }

  static func sign(_ data: Data) throws -> Data {
    guard let key = load() else { throw TlsError("No device key") }
    var error: Unmanaged<CFError>?
    guard let sig = SecKeyCreateSignature(key, .ecdsaSignatureMessageX962SHA256, data as CFData, &error) as Data? else {
      throw TlsError("Couldn't sign: \(error?.takeRetainedValue().localizedDescription ?? "unknown")")
    }
    return sig
  }

  static func certificate() -> SecCertificate? {
    let query: [CFString: Any] = [kSecClass: kSecClassCertificate, kSecAttrLabel: certLabel, kSecReturnRef: true]
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let out else { return nil }
    return (out as! SecCertificate)
  }

  static func setCertificate(_ der: Data) throws {
    guard let cert = SecCertificateCreateWithData(nil, der as CFData) else { throw TlsError("Bad certificate") }
    guard let key = load(), let certKey = SecCertificateCopyKey(cert),
      SecKeyCopyExternalRepresentation(certKey, nil) as Data? == (try? publicPoint(key))
    else { throw TlsError("The certificate isn't for this device's key") }
    deleteCertificate()
    let add: [CFString: Any] = [
      kSecClass: kSecClassCertificate,
      kSecValueRef: cert,
      kSecAttrLabel: certLabel,
      kSecAttrAccessible: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
    ]
    let status = SecItemAdd(add as CFDictionary, nil)
    guard status == errSecSuccess else { throw TlsError("Couldn't save the certificate (\(status))") }
  }

  /** The key and certificate as one identity, which the keychain pairs up by the key's hash. */
  static func identity() throws -> SecIdentity {
    guard let cert = certificate() else { throw TlsError("This device has no certificate yet") }
    let der = SecCertificateCopyData(cert) as Data
    let query: [CFString: Any] = [kSecClass: kSecClassIdentity, kSecReturnRef: true, kSecMatchLimit: kSecMatchLimitAll]
    var out: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &out) == errSecSuccess, let list = out as? [SecIdentity] else {
      throw TlsError("The device key and certificate don't match up")
    }
    for identity in list {
      var c: SecCertificate?
      if SecIdentityCopyCertificate(identity, &c) == errSecSuccess, let c, SecCertificateCopyData(c) as Data == der { return identity }
    }
    throw TlsError("The device key and certificate don't match up")
  }

  static func deleteCertificate() {
    SecItemDelete([kSecClass: kSecClassCertificate, kSecAttrLabel: certLabel] as CFDictionary)
  }

  static func reset() {
    deleteCertificate()
    SecItemDelete([kSecClass: kSecClassKey, kSecAttrApplicationTag: tag] as CFDictionary)
  }
}

// MARK: - Discovery

/**
 * Rets advertising on the network (`_ret._tcp`, TXT id/n/v), each resolved to an address and port
 * by opening a plain TCP connection to the service. Only hints: the connection checks keys.
 */
final class Browser {
  private let nw: NWBrowser
  private let queue: DispatchQueue
  private let changed: ([[String: Any]]) -> Void
  private var found: [String: [String: Any]] = [:]
  private var resolving: [String: NWConnection] = [:]

  init(type: String, queue: DispatchQueue, changed: @escaping ([[String: Any]]) -> Void) {
    self.queue = queue
    self.changed = changed
    nw = NWBrowser(for: .bonjourWithTXTRecord(type: type, domain: nil), using: .tcp)
    nw.browseResultsChangedHandler = { [weak self] results, _ in self?.update(results) }
    nw.start(queue: queue)
  }

  func report() { changed(Array(found.values)) }

  func stop() {
    nw.cancel()
    resolving.values.forEach { $0.cancel() }
    resolving = [:]
  }

  private func update(_ results: Set<NWBrowser.Result>) {
    var names = Set<String>()
    for r in results {
      guard case .service(let name, _, _, _) = r.endpoint else { continue }
      names.insert(name)
      var txt: [String: String] = [:]
      if case .bonjour(let record) = r.metadata { txt = record.dictionary }
      if found[name] == nil, resolving[name] == nil { resolve(name, r.endpoint, txt) }
    }
    let gone = found.keys.filter { !names.contains($0) }
    gone.forEach { found[$0] = nil }
    if !gone.isEmpty { report() }
  }

  private func resolve(_ name: String, _ endpoint: NWEndpoint, _ txt: [String: String]) {
    let params = NWParameters.tcp
    if let ip = params.defaultProtocolStack.internetProtocol as? NWProtocolIP.Options { ip.version = .v4 }
    let c = NWConnection(to: endpoint, using: params)
    resolving[name] = c
    c.stateUpdateHandler = { [weak self] state in
      guard let self else { return }
      switch state {
      case .ready:
        if case .hostPort(let host, let port)? = c.currentPath?.remoteEndpoint {
          var address = "\(host)"
          if let pct = address.firstIndex(of: "%") { address = String(address[..<pct]) }
          self.found[name] = ["name": txt["n"] ?? name, "id": txt["id"] ?? "", "v": txt["v"] ?? "", "address": address, "port": Int(port.rawValue)]
          self.report()
        }
        c.cancel()
        self.resolving[name] = nil
      case .failed, .cancelled:
        self.resolving[name] = nil
      default:
        break
      }
    }
    c.start(queue: queue)
  }
}
