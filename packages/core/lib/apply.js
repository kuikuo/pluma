// The event base's apply function. Every rule that decides what the shared
// state is lives here, and it runs identically on every device. It must be
// deterministic: no clocks, no randomness, no I/O besides `view`.
//
// View layout (Hyperbee, utf-8 keys, json values):
//   event                 public event document
//   keys                  { ticketKey, boxKey } host public keys
//   hosts/<writer>        { role: organiser|manager|scanner, name, visible, boxKey }
//   secrets/<writer>      sealed host secrets for that co-host
//   guests/<writer>       { status: approved|pending|waitlist|declined|closed|cancelled|revoked,
//                           ticketType, holderKey, sealed, at, message, wseq }
//   hidden/<writer>       true when a host hid the guest (selective mode)
//   parked/decision|ticket/<writer>  host records that arrived before the RSVP
//   tickets/<ticketId>    { guest, ticket }
//   revoked/<ticketId>    { reason }
//   checkins/<ticketId>   { by, at, duplicates: [{ by, at }] }
//   roster/<writer>       { name }   (visible guest names, written by hosts)
//   blasts/<seq>          { body, audience, at, by }
//   meta/approved         number of approved guests
//   meta/type/<id>        approved guests per ticket type
//   meta/wseq             waitlist counter
//   waitlist/<seq>        guest id, in the order they joined the waitlist

const b4a = require('b4a')
const { ticketId: deriveTicketId } = require('./ticket')

// Bump when the meaning of records changes. Devices refuse to apply events
// created under newer rules than they know, instead of computing a different state.
const RULES_VERSION = 2

const STATUSES = ['approved', 'declined', 'pending']
const QUESTION_KINDS = ['text', 'choice', 'agree']
const MODES = ['public', 'selective', 'private']
const EVENT_FIELDS = [
  'title', 'description', 'start', 'end', 'timezone', 'type', 'location', 'link', 'cover',
  'capacity', 'requireApproval', 'accepting', 'guestListMode', 'questions', 'ticketTypes'
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
  if (out.ticketTypes !== undefined) out.ticketTypes = cleanTicketTypes(out.ticketTypes)
  if (out.questions !== undefined) out.questions = cleanQuestions(out.questions)
  return out
}

const isCap = (c) => c === null || c === undefined || (Number.isInteger(c) && c >= 0)

function cleanTicketTypes(list) {
  if (!Array.isArray(list)) return []
  return list.slice(0, 20).filter((t) => t && isStr(t.id, 40) && t.id && isStr(t.name, 60) && isCap(t.capacity)).map((t) => ({
    id: t.id, name: t.name, capacity: t.capacity ?? null, requireApproval: !!t.requireApproval
  }))
}

function cleanQuestions(list) {
  if (!Array.isArray(list)) return []
  return list.slice(0, 20).filter((q) => q && isStr(q.id, 40) && q.id && isStr(q.label, 200) && QUESTION_KINDS.includes(q.kind)).map((q) => ({
    id: q.id,
    label: q.label,
    kind: q.kind,
    required: !!q.required,
    options: q.kind === 'choice' && Array.isArray(q.options) ? q.options.filter((o) => isStr(o, 100)).slice(0, 20) : []
  }))
}

// The ticket type a guest asked for (or the implicit single type).
function typeOf(event, id) {
  const types = event.ticketTypes || []
  const t = types.find((x) => x.id === id) || types[0]
  if (!t) return { id: 'general', name: 'General', capacity: null, requireApproval: !!event.requireApproval }
  return { ...t, requireApproval: t.requireApproval || !!event.requireApproval }
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
  if (event && (event.rules || 1) > RULES_VERSION) return // made by a newer Pluma: don't guess

  // Guest records are the only ones accepted from non-writers (optimistic).
  if (v.type === 'rsvp') return rsvp(v, writer, node, view, host, event, eventKey)
  if (v.type === 'rsvp.cancel') return rsvpCancel(v, writer, node, view, host, eventKey)

  switch (v.type) {
    case 'init': {
      if (event) return
      const { ticketKey, boxKey } = v
      if (!isHex(ticketKey, 32) || !isHex(boxKey, 32)) return
      const rules = Number.isInteger(v.rules) ? v.rules : 1
      await view.put('event', { cancelled: false, accepting: true, guestListMode: 'private', capacity: null, requireApproval: false, questions: [], ticketTypes: [], ...pickEventFields(v.event), rules })
      if (rules > RULES_VERSION) return
      await view.put('keys', { ticketKey, boxKey })
      await view.put('hosts/' + writer, { role: 'organiser', name: isStr(v.name, 100) ? v.name : '', visible: true, boxKey: v.memberBoxKey || null })
      await view.put('meta/approved', 0)
      return
    }
    case 'event.update': {
      if (!isManager || !event) return
      const updated = { ...event, ...pickEventFields(v.fields) }
      await view.put('event', updated)
      await promote(view, eventKey, updated) // more room may have opened up
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
        await count(view, g.ticketType, -1)
        await promote(view, eventKey, event)
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

  const type = typeOf(event, v.ticketType)
  let status
  if (event.cancelled || !event.accepting) status = 'closed'
  else if (type.requireApproval) status = 'pending'
  else if (!(await hasRoom(view, event, type))) status = 'waitlist'
  else status = 'approved'

  const g = {
    status,
    ticketType: type.id,
    holderKey: v.holderKey,
    sealed: v.sealed,
    at: typeof v.at === 'number' ? v.at : 0,
    message: null,
    wseq: null
  }
  if (status === 'approved') {
    await count(view, type.id, 1)
    await view.del('revoked/' + idFor(eventKey, writer))
  }
  if (status === 'waitlist') g.wseq = await joinWaitlist(view, writer)
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
  const type = typeOf(event, g.ticketType)
  if (decision.status === 'approved') {
    if (!(await hasRoom(view, event, type))) return // no oversell
    await count(view, type.id, 1)
  } else if (g.status === 'approved') {
    await count(view, type.id, -1)
  }
  await leaveWaitlist(view, g)
  await view.put('guests/' + guest, { ...g, status: decision.status, message: decision.message, wseq: null })
  if (decision.status === 'approved') {
    await view.del('revoked/' + idFor(eventKey, guest))
    await settleTicket(view, eventKey, guest)
  } else if (g.status === 'approved') {
    await revokeFor(view, eventKey, guest, 'declined')
    await promote(view, eventKey, event)
  }
}

async function count(view, typeId, delta) {
  await view.put('meta/approved', ((await get(view, 'meta/approved')) || 0) + delta)
  await view.put('meta/type/' + typeId, ((await get(view, 'meta/type/' + typeId)) || 0) + delta)
}

async function hasRoom(view, event, type) {
  if (event.capacity !== null && event.capacity !== undefined && ((await get(view, 'meta/approved')) || 0) >= event.capacity) return false
  if (type.capacity !== null && type.capacity !== undefined && ((await get(view, 'meta/type/' + type.id)) || 0) >= type.capacity) return false
  return true
}

async function joinWaitlist(view, guest) {
  const seq = ((await get(view, 'meta/wseq')) || 0) + 1
  await view.put('meta/wseq', seq)
  await view.put('waitlist/' + String(seq).padStart(10, '0'), guest)
  return seq
}

async function leaveWaitlist(view, g) {
  if (g.wseq) await view.del('waitlist/' + String(g.wseq).padStart(10, '0'))
}

// Give freed seats to the waitlist in order. Ticket types that need approval
// stay on the waitlist for a host to approve.
async function promote(view, eventKey, event) {
  if (event.cancelled || !event.accepting) return
  const entries = []
  for await (const { value } of view.createReadStream({ gt: 'waitlist/', lt: 'waitlist/~' })) entries.push(value)
  for (const guest of entries) {
    const g = await get(view, 'guests/' + guest)
    if (!g || g.status !== 'waitlist') continue
    const type = typeOf(event, g.ticketType)
    if (type.requireApproval || !(await hasRoom(view, event, type))) continue
    await count(view, type.id, 1)
    await leaveWaitlist(view, g)
    await view.put('guests/' + guest, { ...g, status: 'approved', wseq: null, message: 'A spot opened up' })
    await view.del('revoked/' + idFor(eventKey, guest))
    await settleTicket(view, eventKey, guest)
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
  if (g.status === 'approved') await count(view, g.ticketType || 'general', -1)
  await leaveWaitlist(view, g)
  await view.put('guests/' + writer, { ...g, status: 'cancelled', wseq: null })
  await view.del('roster/' + writer)
  await revokeFor(view, eventKey, writer, 'cancelled')
  await promote(view, eventKey, await get(view, 'event'))
}

function idFor(eventKey, guestHex) {
  return b4a.toString(deriveTicketId(eventKey, b4a.from(guestHex, 'hex')), 'hex')
}

async function revokeFor(view, eventKey, guestHex, reason) {
  const id = idFor(eventKey, guestHex)
  if (await get(view, 'tickets/' + id)) await view.put('revoked/' + id, { reason })
}

module.exports = { createApply, idFor, RULES_VERSION }
