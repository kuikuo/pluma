// The event base's apply function. Every rule that decides what the shared
// state is lives here, and it runs identically on every device. It must be
// deterministic: no clocks, no randomness, no I/O besides `view`.
//
// View layout (Hyperbee, utf-8 keys, json values):
//   event                 public event document
//   keys                  { ticketKey, boxKey } host public keys
//   hosts/<writer>        { role: organiser|manager|scanner, name, visible, boxKey }
//   secrets/<writer>      sealed host secrets for that co-host
//   guests/<writer>       { status: approved|pending|declined|full|closed|cancelled|revoked, holderKey, sealed, at, message }
//   hidden/<writer>       true when a host hid the guest (selective mode)
//   parked/decision|ticket/<writer>  host records that arrived before the RSVP
//   tickets/<ticketId>    { guest, ticket }
//   revoked/<ticketId>    { reason }
//   checkins/<ticketId>   { by, at, duplicates: [{ by, at }] }
//   roster/<writer>       { name }   (visible guest names, written by hosts)
//   blasts/<seq>          { body, audience, at, by }
//   meta/approved         number of approved guests

const b4a = require('b4a')
const { ticketId: deriveTicketId } = require('./ticket')

const STATUSES = ['approved', 'declined', 'pending']
const MODES = ['public', 'selective', 'private']
const EVENT_FIELDS = [
  'title', 'description', 'start', 'end', 'timezone', 'type', 'location', 'link', 'cover',
  'capacity', 'requireApproval', 'accepting', 'guestListMode', 'questions'
]

const isHex = (s, bytes) => typeof s === 'string' && s.length === bytes * 2 && /^[0-9a-f]+$/.test(s)
const isStr = (s, max = 10_000) => typeof s === 'string' && s.length <= max

function pickEventFields(input) {
  const out = {}
  for (const k of EVENT_FIELDS) if (input && input[k] !== undefined) out[k] = input[k]
  if (out.guestListMode !== undefined && !MODES.includes(out.guestListMode)) delete out.guestListMode
  if (out.capacity !== undefined && out.capacity !== null && !(Number.isInteger(out.capacity) && out.capacity >= 0)) {
    delete out.capacity
  }
  return out
}

function createApply(eventKeyRef) {
  return async function apply(nodes, view, host) {
    for (const node of nodes) {
      const value = node.value
      if (!value || typeof value.type !== 'string') continue
      const writer = b4a.toString(node.from.key, 'hex')
      await applyOne(value, writer, node, view, host, eventKeyRef())
    }
  }
}

async function get(view, key) {
  const node = await view.get(key)
  return node ? node.value : null
}

async function role(view, writer) {
  const h = await get(view, 'hosts/' + writer)
  return h ? h.role : null
}

async function applyOne(v, writer, node, view, host, eventKey) {
  const r = await role(view, writer)
  const isManager = r === 'organiser' || r === 'manager'
  const event = await get(view, 'event')

  // Guest records are the only ones accepted from non-writers (optimistic).
  if (v.type === 'rsvp') return rsvp(v, writer, node, view, host, event, eventKey)
  if (v.type === 'rsvp.cancel') return rsvpCancel(v, writer, node, view, host, eventKey)

  switch (v.type) {
    case 'init': {
      if (event) return
      const { ticketKey, boxKey } = v
      if (!isHex(ticketKey, 32) || !isHex(boxKey, 32)) return
      await view.put('event', { cancelled: false, accepting: true, guestListMode: 'private', capacity: null, requireApproval: false, questions: [], ...pickEventFields(v.event) })
      await view.put('keys', { ticketKey, boxKey })
      await view.put('hosts/' + writer, { role: 'organiser', name: isStr(v.name, 100) ? v.name : '', visible: true, boxKey: v.memberBoxKey || null })
      await view.put('meta/approved', 0)
      return
    }
    case 'event.update': {
      if (!isManager || !event) return
      await view.put('event', { ...event, ...pickEventFields(v.fields) })
      return
    }
    case 'event.cancel': {
      if (!isManager || !event) return
      await view.put('event', { ...event, cancelled: true, accepting: false })
      return
    }
    case 'host.add': {
      if (r !== 'organiser' || !isHex(v.key, 32)) return
      const newRole = v.role === 'scanner' ? 'scanner' : 'manager'
      await host.addWriter(b4a.from(v.key, 'hex'), { indexer: false })
      await view.put('hosts/' + v.key, {
        role: newRole,
        name: isStr(v.name, 100) ? v.name : '',
        visible: newRole === 'manager' && v.visible !== false,
        boxKey: isHex(v.boxKey, 32) ? v.boxKey : null
      })
      return
    }
    case 'host.remove': {
      if (r !== 'organiser' || !isHex(v.key, 32) || v.key === writer) return
      const key = b4a.from(v.key, 'hex')
      if (host.removeable(key)) await host.removeWriter(key)
      await view.del('hosts/' + v.key)
      await view.del('secrets/' + v.key)
      return
    }
    case 'secrets.share': {
      if (!isManager || !isHex(v.to, 32) || !isStr(v.sealed)) return
      await view.put('secrets/' + v.to, { sealed: v.sealed })
      return
    }
    case 'decide': {
      if (!isManager || !isHex(v.guest, 32) || !STATUSES.includes(v.status)) return
      const decision = { status: v.status, message: isStr(v.message, 1000) ? v.message : null }
      const g = await get(view, 'guests/' + v.guest)
      // Guest RSVPs are optimistic, so a host's decision can be ordered before
      // the RSVP it answers. Park it; rsvp() applies it when the RSVP lands.
      if (!g) return view.put('parked/decision/' + v.guest, decision)
      await decide(view, eventKey, event, v.guest, g, decision)
      return
    }
    case 'ticket.issue': {
      if (!isManager || !isHex(v.guest, 32) || !isStr(v.ticket)) return
      await view.put('parked/ticket/' + v.guest, { ticket: v.ticket })
      await settleTicket(view, eventKey, v.guest)
      return
    }
    case 'ticket.revoke': {
      if (!isManager || !isHex(v.ticketId, 32)) return
      const t = await get(view, 'tickets/' + v.ticketId)
      if (!t) return
      await view.put('revoked/' + v.ticketId, { reason: isStr(v.reason, 200) ? v.reason : 'revoked' })
      const g = await get(view, 'guests/' + t.guest)
      if (g && g.status === 'approved') {
        await view.put('guests/' + t.guest, { ...g, status: 'revoked', message: isStr(v.reason, 200) ? v.reason : null })
        await view.put('meta/approved', (await get(view, 'meta/approved')) - 1)
      }
      return
    }
    case 'guest.hidden': {
      if (!isManager || !isHex(v.guest, 32)) return
      if (v.hidden) await view.put('hidden/' + v.guest, true)
      else await view.del('hidden/' + v.guest)
      return
    }
    case 'roster.set': {
      if (!isManager || !isHex(v.guest, 32) || !isStr(v.name, 100)) return
      await view.put('roster/' + v.guest, { name: v.name })
      return
    }
    case 'roster.del': {
      if (!isManager || !isHex(v.guest, 32)) return
      await view.del('roster/' + v.guest)
      return
    }
    case 'checkin': {
      if (!(isManager || r === 'scanner') || !isHex(v.ticketId, 32) || typeof v.at !== 'number') return
      const prev = await get(view, 'checkins/' + v.ticketId)
      if (!prev) {
        await view.put('checkins/' + v.ticketId, { by: writer, at: v.at, duplicates: [] })
      } else {
        await view.put('checkins/' + v.ticketId, { ...prev, duplicates: [...prev.duplicates, { by: writer, at: v.at }] })
      }
      return
    }
    case 'checkin.undo': {
      if (!isManager || !isHex(v.ticketId, 32)) return
      await view.del('checkins/' + v.ticketId)
      return
    }
    case 'blast': {
      if (!isManager || !isStr(v.body, 5000)) return
      const seq = String(node.length).padStart(10, '0') + '-' + writer.slice(0, 8)
      await view.put('blasts/' + seq, { body: v.body, audience: v.audience === 'all' ? 'all' : 'approved', at: v.at, by: writer })
    }
  }
}

async function rsvp(v, writer, node, view, host, event, eventKey) {
  if (!event || !isHex(v.holderKey, 32) || !isStr(v.sealed, 20_000)) return
  const existing = await get(view, 'guests/' + writer)
  if (existing && existing.status !== 'cancelled') return // duplicate guard

  await host.ackWriter(node.from.key)

  let status
  if (event.cancelled || !event.accepting) status = 'closed'
  else if (event.requireApproval) status = 'pending'
  else if (event.capacity !== null && (await get(view, 'meta/approved')) >= event.capacity) status = 'full'
  else status = 'approved'

  if (status === 'approved') {
    await view.put('meta/approved', (await get(view, 'meta/approved')) + 1)
    await view.del('revoked/' + idFor(eventKey, writer))
  }
  const g = {
    status,
    holderKey: v.holderKey,
    sealed: v.sealed,
    at: typeof v.at === 'number' ? v.at : 0,
    message: null
  }
  await view.put('guests/' + writer, g)

  const parked = await get(view, 'parked/decision/' + writer)
  if (parked) {
    await view.del('parked/decision/' + writer)
    await decide(view, eventKey, event, writer, g, parked)
  }
  await settleTicket(view, eventKey, writer)
}

async function decide(view, eventKey, event, guest, g, decision) {
  if (g.status === 'cancelled' || g.status === decision.status) return
  let approved = await get(view, 'meta/approved')
  if (decision.status === 'approved') {
    if (event.capacity !== null && approved >= event.capacity) return // no oversell
    approved++
  } else if (g.status === 'approved') {
    approved--
  }
  await view.put('meta/approved', approved)
  await view.put('guests/' + guest, { ...g, status: decision.status, message: decision.message })
  if (decision.status === 'approved') {
    await view.del('revoked/' + idFor(eventKey, guest))
    await settleTicket(view, eventKey, guest)
  } else if (g.status === 'approved') {
    await revokeFor(view, eventKey, guest, 'declined')
  }
}

// Move a host-issued ticket into place once its guest is approved.
async function settleTicket(view, eventKey, guest) {
  const g = await get(view, 'guests/' + guest)
  const parked = await get(view, 'parked/ticket/' + guest)
  if (!g || g.status !== 'approved' || !parked) return
  const id = idFor(eventKey, guest)
  if (!(await get(view, 'tickets/' + id))) await view.put('tickets/' + id, { guest, ticket: parked.ticket })
  await view.del('parked/ticket/' + guest)
}

async function rsvpCancel(v, writer, node, view, host, eventKey) {
  const g = await get(view, 'guests/' + writer)
  if (!g || g.status === 'cancelled') return
  await host.ackWriter(node.from.key)
  if (g.status === 'approved') await view.put('meta/approved', (await get(view, 'meta/approved')) - 1)
  await view.put('guests/' + writer, { ...g, status: 'cancelled' })
  await view.del('roster/' + writer)
  await revokeFor(view, eventKey, writer, 'cancelled')
}

function idFor(eventKey, guestHex) {
  return b4a.toString(deriveTicketId(eventKey, b4a.from(guestHex, 'hex')), 'hex')
}

async function revokeFor(view, eventKey, guestHex, reason) {
  const id = idFor(eventKey, guestHex)
  if (await get(view, 'tickets/' + id)) await view.put('revoked/' + id, { reason })
}

module.exports = { createApply, idFor }
