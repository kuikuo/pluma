// Runs inside the Bare worklet on the phone. Hosts @pluma/core and answers
// newline-delimited JSON requests from the React Native UI over IPC.
/* global Bare, BareKit */
const { Pluma, toICS, toCSV } = require('../../../packages/core')
const b4a = require('b4a')
const { idFor } = require('../../../packages/core/lib/apply')

const { IPC } = BareKit
const storage = (Bare.argv[0] || '.') + '/pluma'
const pluma = new Pluma(storage)
const opening = pluma.ready()
const watched = new Set()

function send(msg) {
  IPC.write(Buffer.from(JSON.stringify(msg) + '\n'))
}

async function open(link) {
  await opening
  const ev = await pluma.openEvent(link)
  if (!watched.has(ev.link)) {
    watched.add(ev.link)
    let timer = null
    ev.on('update', () => {
      clearTimeout(timer)
      timer = setTimeout(() => send({ event: 'update', link: ev.link }), 250)
    })
    ev.on('error', (err) => send({ event: 'error', message: err.message }))
  }
  return ev
}

async function summary(ev) {
  const info = (await ev.info()) || {}
  const role = await ev.role()
  const mine = await ev.myStatus()
  return { link: ev.link, title: info.title || 'Loading…', start: info.start || null, cancelled: !!info.cancelled, role, status: mine.status }
}

// Names of guests whose ticket was scanned at more than one door.
// Compact event preview carried in invite links (decoded by the invite web page).
function preview(info, hosts) {
  if (!info) return ''
  const p = { t: info.title, s: info.start, z: info.timezone, l: info.location || undefined, h: hosts.join(', ') || undefined }
  return b4a.toString(b4a.from(JSON.stringify(p)), 'base64url')
}

async function duplicateNames(ev) {
  const dups = await ev.duplicateScans()
  if (dups.length === 0) return []
  const guests = await ev.guests()
  const names = []
  for (const d of dups) {
    const t = await ev._get('tickets/' + d.id)
    const g = t && guests.find((x) => x.id === t.guest)
    names.push(g && g.name ? g.name : 'A guest')
  }
  return names
}

const methods = {
  async profile() {
    await opening
    const p = await pluma.local.get('profile')
    return p ? p.value : { name: '', email: '' }
  },
  async setProfile(p) {
    await opening
    await pluma.local.put('profile', { name: p.name || '', email: p.email || '' })
  },
  async events() {
    await opening
    const out = []
    for (const link of await pluma.myEvents()) out.push(await summary(await open(link)))
    return out
  },
  async peers() {
    return pluma.swarm ? pluma.swarm.connections.size : 0
  },
  async createEvent(fields) {
    await opening
    const p = await methods.profile()
    const ev = await pluma.createEvent(fields, { name: p.name })
    await open(ev.link)
    return ev.link
  },
  async open(link) {
    return (await open(link)).link
  },
  async detail(link) {
    const ev = await open(link)
    const info = await ev.info()
    const role = await ev.role()
    const manager = role === 'organiser' || role === 'manager'
    return {
      link: ev.link,
      info,
      role,
      needsUpdate: await ev.needsUpdate(),
      ticketTypes: await ev.ticketTypes(),
      preview: preview(info, (await ev.hosts()).filter((h) => h.visible).map((h) => h.name).filter(Boolean)),
      mine: await ev.myStatus(),
      hosts: (await ev.hosts()).filter((h) => h.visible).map((h) => h.name).filter(Boolean),
      roster: (await ev.roster()).map((r) => r.name),
      blasts: (await ev.blasts()).map((b) => ({ body: b.body, at: b.at })),
      guests: manager ? await ev.guests() : null,
      overCapacity: manager ? (await ev.overCapacity()).map((g) => g.id) : [],
      duplicates: manager ? await duplicateNames(ev) : [],
      checkins: manager || role === 'scanner' ? (await ev.checkins()).length : 0,
      joinRequest: ev.joinRequest
    }
  },
  async rsvp(link, details) { await (await open(link)).rsvp(details) },
  async ics(link) {
    const ev = await open(link)
    return toICS(await ev.info(), { link: ev.link, uid: ev.link.slice(-64) })
  },
  async csv(link) {
    const ev = await open(link)
    const scanned = new Set((await ev.checkins()).map((c) => c.id))
    const guests = await ev.guests()
    const checkins = new Set(guests.filter((g) => scanned.has(idFor(ev.key, g.id))).map((g) => g.id))
    return toCSV(guests, await ev.info(), checkins)
  },
  async cancelRsvp(link) { await (await open(link)).cancelRsvp() },
  async ticketQR(link) { return (await open(link)).ticketQR() },
  async approve(link, id) { await (await open(link)).approve(id) },
  async decline(link, id) { await (await open(link)).decline(id) },
  async revoke(link, id) { await (await open(link)).revokeTicket(id, 'Event capacity was reduced') },
  async setMode(link, mode) { await (await open(link)).setGuestListMode(mode) },
  async hide(link, id, hidden) { await (await open(link)).hideGuest(id, hidden) },
  async update(link, fields) { await (await open(link)).update(fields) },
  async cancelEvent(link) { await (await open(link)).cancel() },
  async blast(link, body) { await (await open(link)).blast(body) },
  async scan(link, code) { return (await open(link)).scan(code) },
  async addHelper(link, req, role) {
    const ev = await open(link)
    if (role === 'scanner') await ev.addScanner({ key: req.key, name: req.name || '' })
    else await ev.addCohost({ key: req.key, boxKey: req.boxKey, name: req.name || '' })
  }
}

let buffered = ''
IPC.on('data', (data) => {
  buffered += data.toString()
  let i
  while ((i = buffered.indexOf('\n')) !== -1) {
    const line = buffered.slice(0, i)
    buffered = buffered.slice(i + 1)
    handle(line)
  }
})

async function handle(line) {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const fn = methods[msg.method]
  try {
    if (!fn) throw new Error('Unknown method ' + msg.method)
    send({ id: msg.id, result: await fn(...(msg.args || [])) })
  } catch (err) {
    send({ id: msg.id, error: err.message })
  }
}

Bare.on('suspend', () => {})
Bare.on('teardown', () => pluma.close())
