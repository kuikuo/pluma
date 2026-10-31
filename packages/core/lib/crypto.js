const sodium = require('sodium-universal')
const b4a = require('b4a')

function hash(...parts) {
  const out = b4a.alloc(32)
  sodium.crypto_generichash(out, b4a.concat(parts.map((p) => (typeof p === 'string' ? b4a.from(p) : p))))
  return out
}

function signKeyPair(seed) {
  const publicKey = b4a.alloc(sodium.crypto_sign_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_sign_SECRETKEYBYTES)
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed)
  return { publicKey, secretKey }
}

function boxKeyPair(seed) {
  const publicKey = b4a.alloc(sodium.crypto_box_PUBLICKEYBYTES)
  const secretKey = b4a.alloc(sodium.crypto_box_SECRETKEYBYTES)
  sodium.crypto_box_seed_keypair(publicKey, secretKey, seed)
  return { publicKey, secretKey }
}

function sign(message, secretKey) {
  const sig = b4a.alloc(sodium.crypto_sign_BYTES)
  sodium.crypto_sign_detached(sig, message, secretKey)
  return sig
}

function verify(message, sig, publicKey) {
  if (sig.byteLength !== sodium.crypto_sign_BYTES) return false
  if (publicKey.byteLength !== sodium.crypto_sign_PUBLICKEYBYTES) return false
  return sodium.crypto_sign_verify_detached(sig, message, publicKey)
}

function seal(json, publicKey) {
  const msg = b4a.from(JSON.stringify(json))
  const out = b4a.alloc(msg.byteLength + sodium.crypto_box_SEALBYTES)
  sodium.crypto_box_seal(out, msg, publicKey)
  return out
}

function unseal(buf, { publicKey, secretKey }) {
  if (buf.byteLength < sodium.crypto_box_SEALBYTES) return null
  const out = b4a.alloc(buf.byteLength - sodium.crypto_box_SEALBYTES)
  if (!sodium.crypto_box_seal_open(out, buf, publicKey, secretKey)) return null
  try {
    return JSON.parse(b4a.toString(out))
  } catch {
    return null
  }
}

module.exports = { hash, signKeyPair, boxKeyPair, sign, verify, seal, unseal }
