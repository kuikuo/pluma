const test = require('brittle')
const b4a = require('b4a')
const T = require('../lib/ticket')
const { signKeyPair, hash } = require('../lib/crypto')

const eventKey = hash('event')
const host = signKeyPair(hash('host'))
const holder = signKeyPair(hash('holder'))
const id = T.ticketId(eventKey, hash('guest'))
const ticket = T.issue({ eventKey, ticketId: id, holderKey: holder.publicKey, issuedAt: 1 }, host.secretKey)
const now = 1_800_000_000_000
const opts = { eventKey, ticketPublicKey: host.publicKey, now }

test('valid dynamic QR verifies offline', (t) => {
  const r = T.verifyQR(T.qr(ticket, holder.secretKey, now), opts)
  t.ok(r.ok)
  t.is(r.ticketId, b4a.toString(id, 'hex'))
})

test('screenshot expires after the drift window', (t) => {
  const old = T.qr(ticket, holder.secretKey, now - 2 * 60_000)
  t.ok(T.verifyQR(old, opts).ok, 'within ±2 min is accepted')
  const stale = T.qr(ticket, holder.secretKey, now - 3 * 60_000)
  t.is(T.verifyQR(stale, opts).reason, 'expired-code')
})

test('forwarded ticket without holder key is rejected', (t) => {
  const thief = signKeyPair(hash('thief'))
  t.is(T.verifyQR(T.qr(ticket, thief.secretKey, now), opts).reason, 'not-holder')
})

test('forged or foreign tickets are rejected', (t) => {
  const fake = T.issue({ eventKey, ticketId: id, holderKey: holder.publicKey, issuedAt: 1 }, signKeyPair(hash('x')).secretKey)
  t.is(T.verifyQR(T.qr(fake, holder.secretKey, now), opts).reason, 'forged')
  t.is(T.verifyQR(T.qr(ticket, holder.secretKey, now), { ...opts, eventKey: hash('other') }).reason, 'wrong-event')
  t.is(T.verifyQR('garbage', opts).reason, 'unreadable')
})
