// Ticket and dynamic QR encoding (ARCHITECTURE.md §5).
//
// ticket body  = eventKey(32) | ticketId(32) | holderKey(32) | issuedAt(8, ms)
// ticket       = body | ticketSig(64)                         -> 168 bytes
// qr payload   = ticket | window(4) | holderSig(64)           -> 236 bytes, base64url

const b4a = require('b4a')
const { sign, verify, hash } = require('./crypto')

const WINDOW_MS = 30_000
const WINDOW_TOLERANCE = 4 // ±2 minutes of clock drift
const BODY = 104
const TICKET = BODY + 64
const QR = TICKET + 4 + 64

function ticketId(eventKey, guestKey) {
  return hash('pluma:ticket', eventKey, guestKey)
}

function encodeBody({ eventKey, ticketId, holderKey, issuedAt }) {
  const buf = b4a.alloc(BODY)
  eventKey.copy(buf, 0)
  ticketId.copy(buf, 32)
  holderKey.copy(buf, 64)
  buf.writeBigUInt64BE(BigInt(issuedAt), 96)
  return buf
}

function issue(fields, ticketSecretKey) {
  const body = encodeBody(fields)
  return b4a.concat([body, sign(body, ticketSecretKey)])
}

function decodeTicket(buf) {
  return {
    eventKey: buf.subarray(0, 32),
    ticketId: buf.subarray(32, 64),
    holderKey: buf.subarray(64, 96),
    issuedAt: Number(buf.readBigUInt64BE(96)),
    body: buf.subarray(0, BODY),
    sig: buf.subarray(BODY, TICKET)
  }
}

function windowMessage(ticketIdBuf, w) {
  const buf = b4a.alloc(36)
  ticketIdBuf.copy(buf, 0)
  buf.writeUInt32BE(w, 32)
  return buf
}

function qr(ticketBuf, holderSecretKey, now) {
  const w = Math.floor(now / WINDOW_MS)
  const { ticketId } = decodeTicket(ticketBuf)
  const wbuf = b4a.alloc(4)
  wbuf.writeUInt32BE(w, 0)
  const holderSig = sign(windowMessage(ticketId, w), holderSecretKey)
  return b4a.toString(b4a.concat([ticketBuf, wbuf, holderSig]), 'base64url')
}

// Pure, offline verification. Returns { ok, reason, ticketId }.
function verifyQR(payload, { eventKey, ticketPublicKey, now }) {
  let buf
  try {
    buf = b4a.from(payload, 'base64url')
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  if (buf.byteLength !== QR) return { ok: false, reason: 'unreadable' }

  const t = decodeTicket(buf.subarray(0, TICKET))
  const w = buf.readUInt32BE(TICKET)
  const holderSig = buf.subarray(TICKET + 4)
  const id = b4a.toString(t.ticketId, 'hex')

  if (!b4a.equals(t.eventKey, eventKey)) return { ok: false, reason: 'wrong-event', ticketId: id }
  if (!verify(t.body, t.sig, ticketPublicKey)) return { ok: false, reason: 'forged', ticketId: id }
  if (Math.abs(w - Math.floor(now / WINDOW_MS)) > WINDOW_TOLERANCE) {
    return { ok: false, reason: 'expired-code', ticketId: id }
  }
  if (!verify(windowMessage(t.ticketId, w), holderSig, t.holderKey)) {
    return { ok: false, reason: 'not-holder', ticketId: id }
  }
  return { ok: true, ticketId: id }
}

module.exports = { ticketId, issue, decodeTicket, qr, verifyQR, WINDOW_MS }
