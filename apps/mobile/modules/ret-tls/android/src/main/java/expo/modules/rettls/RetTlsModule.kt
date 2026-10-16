package expo.modules.rettls

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.ssl.SSLSockets
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.InputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.KeyStore
import java.security.KeyPairGenerator
import java.security.MessageDigest
import java.security.Principal
import java.security.PrivateKey
import java.security.SecureRandom
import java.security.Signature
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509ExtendedKeyManager
import javax.net.ssl.X509TrustManager

class TlsException(message: String) : CodedException(message)

class ConnectOptions : Record {
  @Field val host: String = ""
  @Field val port: Int = 0
  /** The device id (SHA-256 of its public key, hex) the other side must have; null while pairing. */
  @Field val expect: String? = null
  @Field val timeoutMs: Int = 8000
  /** Longest line accepted before the connection is dropped (raised once the peer is trusted). */
  @Field val maxLine: Int = 64 * 1024
}

/**
 * Ret's remote-access transport on Android: TLS 1.3 connections that present this device's key
 * (in the Android Keystore) and pin the other side's, the same as the desktop's (src/main/remote).
 * Lines are split here, so only whole lines cross over to JavaScript, in batches.
 */
class RetTlsModule : Module() {
  private val connections = ConcurrentHashMap<Int, TlsConnection>()
  private val nextId = AtomicInteger(1)
  private val connector = Executors.newCachedThreadPool()
  private var browser: Browser? = null

  private val context: Context
    get() = appContext.reactContext ?: throw TlsException("No context")

  override fun definition() = ModuleDefinition {
    Name("RetTls")

    Events("onLines", "onClose", "onServices")

    AsyncFunction("identity") {
      val key = DeviceKey.loadOrCreate(context)
      mapOf(
        "publicKey" to b64(DeviceKey.publicPoint(key.second)),
        "certificate" to DeviceKey.certificate(context)?.let { b64(it.encoded) },
      )
    }

    AsyncFunction("sign") { data: String -> b64(DeviceKey.sign(Base64.decode(data, Base64.NO_WRAP))) }

    AsyncFunction("setCertificate") { der: String -> DeviceKey.setCertificate(context, Base64.decode(der, Base64.NO_WRAP)) }

    AsyncFunction("resetIdentity") { DeviceKey.reset(context) }

    AsyncFunction("connect") { options: ConnectOptions, promise: Promise ->
      connector.execute { open(options, promise) }
    }

    AsyncFunction("exportKeyingMaterial") { id: Int, label: String, length: Int ->
      val c = connections[id] ?: throw TlsException("Not connected")
      b64(c.exportKeyingMaterial(label, length))
    }

    Function("write") { id: Int, text: String -> connections[id]?.write(text) }

    Function("setMaxLine") { id: Int, max: Int -> connections[id]?.maxLine = max }

    Function("close") { id: Int -> connections[id]?.close("Closed") }

    Function("startDiscovery") { type: String ->
      val b = browser
      if (b != null) b.report()
      else browser = Browser(context, type) { services -> sendEvent("onServices", mapOf("services" to services)) }
    }

    Function("stopDiscovery") {
      browser?.stop()
      browser = null
    }

    OnDestroy {
      connections.values.forEach { it.close("Closed") }
      browser?.stop()
      browser = null
      connector.shutdown()
    }
  }

  private fun open(options: ConnectOptions, promise: Promise) {
    val socket: SSLSocket
    val peer: String
    try {
      val key = DeviceKey.loadOrCreate(context).first
      val cert = DeviceKey.certificate(context) ?: throw TlsException("This device has no certificate yet")
      val ssl = SSLContext.getInstance("TLSv1.3")
      // Self-signed on both sides: a device is who its key says. The key is checked below,
      // before anything is sent; while pairing any key is let through and reported.
      ssl.init(arrayOf(DeviceKeyManager(key, cert)), arrayOf(AnyServer), SecureRandom())
      val raw = Socket()
      raw.tcpNoDelay = true
      raw.keepAlive = true
      raw.connect(InetSocketAddress(options.host, options.port), options.timeoutMs)
      socket = ssl.socketFactory.createSocket(raw, options.host, options.port, true) as SSLSocket
      socket.enabledProtocols = arrayOf("TLSv1.3")
      socket.soTimeout = options.timeoutMs
      socket.startHandshake()
      socket.soTimeout = 0
      val leaf = socket.session.peerCertificates.firstOrNull() as? X509Certificate ?: throw TlsException("No device key from the other side")
      peer = hex(MessageDigest.getInstance("SHA-256").digest(leaf.publicKey.encoded))
      val expect = options.expect?.lowercase()
      if (expect != null && expect != peer) {
        socket.close()
        throw TlsException("a different device")
      }
    } catch (e: TlsException) {
      return promise.reject(e)
    } catch (e: Exception) {
      return promise.reject(TlsException(e.message ?: e.javaClass.simpleName))
    }
    val id = nextId.getAndIncrement()
    val c = TlsConnection(socket, options.maxLine,
      onLines = { lines -> sendEvent("onLines", mapOf("id" to id, "lines" to lines)) },
      onClose = { reason ->
        connections.remove(id)
        sendEvent("onClose", mapOf("id" to id, "reason" to reason))
      })
    connections[id] = c
    c.start()
    promise.resolve(mapOf("id" to id, "peer" to peer))
  }
}

private fun b64(bytes: ByteArray) = Base64.encodeToString(bytes, Base64.NO_WRAP)

private fun hex(bytes: ByteArray) = bytes.joinToString("") { "%02x".format(it) }

/** Accepts any certificate: who the other side is gets decided by its key (see open). */
private object AnyServer : X509TrustManager {
  override fun checkClientTrusted(chain: Array<X509Certificate>, authType: String) {}
  override fun checkServerTrusted(chain: Array<X509Certificate>, authType: String) {}
  override fun getAcceptedIssuers(): Array<X509Certificate> = arrayOf()
}

/** Presents this device's certificate whatever the server asks for: there's only the one. */
private class DeviceKeyManager(private val key: PrivateKey, private val cert: X509Certificate) : X509ExtendedKeyManager() {
  override fun chooseClientAlias(keyType: Array<String>?, issuers: Array<Principal>?, socket: Socket?) = ALIAS
  override fun chooseEngineClientAlias(keyType: Array<String>?, issuers: Array<Principal>?, engine: SSLEngine?) = ALIAS
  override fun getClientAliases(keyType: String?, issuers: Array<Principal>?) = arrayOf(ALIAS)
  override fun getServerAliases(keyType: String?, issuers: Array<Principal>?) = null
  override fun chooseServerAlias(keyType: String?, issuers: Array<Principal>?, socket: Socket?) = null
  override fun getCertificateChain(alias: String?) = arrayOf(cert)
  override fun getPrivateKey(alias: String?) = key

  companion object {
    const val ALIAS = "ret-device"
  }
}

private class TlsConnection(
  private val socket: SSLSocket,
  @Volatile var maxLine: Int,
  private val onLines: (List<String>) -> Unit,
  private val onClose: (String) -> Unit,
) {
  private val writer = Executors.newSingleThreadExecutor()
  private val closed = java.util.concurrent.atomic.AtomicBoolean(false)

  fun start() {
    Thread({ read(socket.inputStream) }, "ret-tls-read").start()
  }

  fun write(text: String) {
    if (closed.get()) return
    writer.execute {
      try {
        socket.outputStream.write(text.toByteArray(Charsets.UTF_8))
        socket.outputStream.flush()
      } catch (e: Exception) {
        close(e.message ?: "Write failed")
      }
    }
  }

  fun close(reason: String) {
    if (!closed.compareAndSet(false, true)) return
    // Let what was written go out (a goodbye), then end the connection.
    writer.execute { runCatching { socket.close() } }
    writer.shutdown()
    onClose(reason)
  }

  /** RFC 8446 §7.5 exporter (Android 10+). Node's with an empty context derives the same in TLS 1.3. */
  fun exportKeyingMaterial(label: String, length: Int): ByteArray {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) throw TlsException("Pairing needs Android 10 or later")
    if (!SSLSockets.isSupportedSocket(socket)) throw TlsException("Couldn't export keying material")
    return SSLSockets.exportKeyingMaterial(socket, label, null, length) ?: throw TlsException("Couldn't export keying material")
  }

  private fun read(input: InputStream) {
    val buf = ByteArray(1 shl 16)
    val partial = ByteArrayOutputStream()
    try {
      while (!closed.get()) {
        val n = input.read(buf)
        if (n < 0) return close("Connection closed")
        val lines = ArrayList<String>()
        var start = 0
        for (i in 0 until n) {
          if (buf[i] != '\n'.code.toByte()) continue
          val line: String
          if (partial.size() == 0) {
            if (i - start > maxLine) return close("Message too long")
            line = String(buf, start, i - start, Charsets.UTF_8)
          } else {
            partial.write(buf, start, i - start)
            if (partial.size() > maxLine) return close("Message too long")
            line = partial.toString(Charsets.UTF_8.name())
            partial.reset()
          }
          lines.add(line)
          start = i + 1
        }
        if (start < n) {
          partial.write(buf, start, n - start)
          if (partial.size() > maxLine) return close("Message too long")
        }
        if (lines.isNotEmpty()) onLines(lines)
      }
    } catch (e: Exception) {
      close(e.message ?: "Connection lost")
    }
  }
}

/**
 * This device's identity: a P-256 key in the Android Keystore (it never leaves it) and the
 * self-signed certificate around it that the JavaScript side builds and has signed.
 */
private object DeviceKey {
  const val ALIAS = "app.getret.mobile.device-key"

  private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
  private fun certFile(context: Context) = File(context.filesDir, "ret-device.cer")

  fun loadOrCreate(context: Context): Pair<PrivateKey, ECPublicKey> {
    val ks = store()
    val key = ks.getKey(ALIAS, null) as? PrivateKey
    val pub = ks.getCertificate(ALIAS)?.publicKey as? ECPublicKey
    if (key != null && pub != null) return key to pub
    // A new key means a new device: any certificate from before belongs to the old one.
    certFile(context).delete()
    val gen = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, "AndroidKeyStore")
    gen.initialize(
      KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_SIGN)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        // TLS 1.3 signs with SHA-256 here; NONE lets the TLS stack hash for itself.
        .setDigests(KeyProperties.DIGEST_NONE, KeyProperties.DIGEST_SHA256)
        .build(),
    )
    val pair = gen.generateKeyPair()
    return pair.private to (pair.public as ECPublicKey)
  }

  /** The uncompressed point (0x04 ‖ x ‖ y), as iOS reports it. */
  fun publicPoint(key: ECPublicKey): ByteArray {
    fun coord(v: java.math.BigInteger): ByteArray {
      val b = v.toByteArray()
      return when {
        b.size == 32 -> b
        b.size > 32 -> b.copyOfRange(b.size - 32, b.size)
        else -> ByteArray(32 - b.size) + b
      }
    }
    return byteArrayOf(4) + coord(key.w.affineX) + coord(key.w.affineY)
  }

  fun sign(data: ByteArray): ByteArray {
    val key = store().getKey(ALIAS, null) as? PrivateKey ?: throw TlsException("No device key")
    return Signature.getInstance("SHA256withECDSA").run {
      initSign(key)
      update(data)
      sign()
    }
  }

  fun certificate(context: Context): X509Certificate? {
    val file = certFile(context)
    if (!file.exists()) return null
    return runCatching { parse(file.readBytes()) }.getOrNull()
  }

  fun setCertificate(context: Context, der: ByteArray) {
    val cert = runCatching { parse(der) }.getOrNull() ?: throw TlsException("Bad certificate")
    val pub = store().getCertificate(ALIAS)?.publicKey ?: throw TlsException("No device key")
    if (!cert.publicKey.encoded.contentEquals(pub.encoded)) throw TlsException("The certificate isn't for this device's key")
    certFile(context).writeBytes(der)
  }

  fun reset(context: Context) {
    certFile(context).delete()
    runCatching { store().deleteEntry(ALIAS) }
  }

  private fun parse(der: ByteArray) = CertificateFactory.getInstance("X.509").generateCertificate(der.inputStream()) as X509Certificate
}

/** Rets advertising on the network (`_ret._tcp`, TXT id/n/v), resolved to an address and port. Only hints: the connection checks keys. */
private class Browser(context: Context, type: String, private val changed: (List<Map<String, Any>>) -> Unit) {
  private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
  private val found = ConcurrentHashMap<String, Map<String, Any>>()
  private val resolver = Executors.newSingleThreadExecutor()

  private val listener = object : NsdManager.DiscoveryListener {
    override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
    override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
    override fun onDiscoveryStarted(serviceType: String) {}
    override fun onDiscoveryStopped(serviceType: String) {}
    override fun onServiceFound(info: NsdServiceInfo) = resolve(info)
    override fun onServiceLost(info: NsdServiceInfo) {
      if (found.remove(info.serviceName) != null) report()
    }
  }

  init {
    nsd.discoverServices("$type.", NsdManager.PROTOCOL_DNS_SD, listener)
  }

  fun report() = changed(found.values.toList())

  fun stop() {
    runCatching { nsd.stopServiceDiscovery(listener) }
    resolver.shutdownNow()
  }

  /** One at a time: older Androids refuse a second resolve while one is underway. */
  private fun resolve(info: NsdServiceInfo) {
    resolver.execute {
      val done = java.util.concurrent.CountDownLatch(1)
      @Suppress("DEPRECATION")
      nsd.resolveService(info, object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) = done.countDown()
        override fun onServiceResolved(info: NsdServiceInfo) {
          @Suppress("DEPRECATION")
          val address = info.host?.hostAddress
          if (address != null && !address.contains(':')) {
            val txt = info.attributes.mapValues { (_, v) -> v?.toString(Charsets.UTF_8) ?: "" }
            found[info.serviceName] = mapOf(
              "name" to (txt["n"] ?: info.serviceName),
              "id" to (txt["id"] ?: ""),
              "v" to (txt["v"] ?: ""),
              "address" to address,
              "port" to info.port,
            )
            report()
          }
          done.countDown()
        }
      })
      done.await(10, java.util.concurrent.TimeUnit.SECONDS)
    }
  }
}
