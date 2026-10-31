const { EventEmitter } = require('events')
const Autobase = require('autobase')
const Hyperbee = require('hyperbee')
const b4a = require('b4a')
const { hash, signKeyPair, boxKeyPair, seal, unseal } = require('./crypto')
const { createApply, idFor, RULES_VERSION } = require('./apply')
const T = require('./ticket')

const hex = (b) => b4a.toString(b, 'hex')
const unhex = (s) => b4a.from(s, 'hex')

class PlumaEvent extends EventEmitter {
  constructor(pluma, { key = null, ns, create = null }) {
    super()
    this.pluma = pluma
    this.ns = ns
    this._create = create
    this._reconciling = null
    this._reconcileAgain = false

    const seed = hash('pluma:member', pluma.store.primaryKey, ns)
    this.member = { sign: signKeyPair(hash(seed, 'sign')), box: boxKeyPair(hash(seed, 'box')) }
    this._ownHostSeed = hash('pluma:host', pluma.store.primaryKey, ns)

    this.base = new Autobase(pluma.store.namespace('event:' + ns), key, {
      valueEncoding: 'json',
      optimistic: true,
      ackInterval: 1000,
      wakeup: pluma.wakeup,
      open: (store) => new Hyperbee(store.get('view'), { keyEncoding: 'utf-8', valueEncoding: 'json', extension: false }),
      apply: createApply(() => this.base.key)
    })
    this.base.on('update', () => {
      this.emit('update')
      this._scheduleReconcile()
    })
    this.base.on('error', (err) => this.emit('error', err))
  }

  async ready() {
    await this.base.ready()
    if (this._create) {
      const hs = this._hostKeys(this._ownHostSeed)
      await this.base.append({
        type: 'init',
        rules: this._create.rules || RULES_VERSION,
        event: this._create.event,
        name: this._create.name || '',
        ticketKey: hex(hs.ticket.publicKey),
        boxKey: hex(hs.box.publicKey),
        memberBoxKey: hex(this.member.box.publicKey)
      })
      this._create = null
    }
  }

  get key() { return this.base.key }
  get link() { return 'pluma://event/' + hex(this.base.key) }
  get view() { return this.base.view }
  get me() { return hex(this.base.local.key) }

  // What a would-be co-host or scanner sends to the organiser (e.g. as a QR code).
  get joinRequest() {
    return { key: this.me, boxKey: hex(this.member.box.publicKey) }
  }

  async _get(key) {
    await this.base.update()
    const node = await this.view.get(key)
    return node ? node.value : null
  }

  async _list(prefix) {
    await this.base.update()
    const out = []
    for await (const { key, value } of this.view.createReadStream({ gt: prefix, lt: prefix + '\xff' })) {
      out.push({ id: key.slice(prefix.length), ...value })
    }
    return out
  }

  _hostKeys(seed) {
    return { ticket: signKeyPair(hash(seed, 'ticket')), box: boxKeyPair(hash(seed, 'box')) }
  }

  async role() {
    const h = await this._get('hosts/' + this.me)
    return h ? h.role : 'guest'
  }

  async isManager() {
    const r = await this.role()
    return r === 'organiser' || r === 'manager'
  }

  // Host secrets: derived locally for the organiser, unsealed from the view for co-hosts.
  async hostSecrets() {
    const r = await this.role()
    if (r === 'organiser') return this._hostKeys(this._ownHostSeed)
    if (r !== 'manager') return null
    const s = await this._get('secrets/' + this.me)
    if (!s) return null
    const opened = unseal(unhex(s.sealed), this.member.box)
    return opened ? this._hostKeys(unhex(opened.seed)) : null
  }

  // ---- everyone ----

  async info() {
    return this._get('event')
  }

  // True when the event was made by a newer Pluma whose rules this one doesn't know.
  async needsUpdate() {
    const ev = await this.info()
    return !!ev && (ev.rules || 1) > RULES_VERSION
  }

  async ticketTypes() {
    const ev = await this.info()
    if (!ev) return []
    const types = ev.ticketTypes && ev.ticketTypes.length ? ev.ticketTypes : [{ id: 'general', name: 'General', capacity: null, requireApproval: false }]
    const out = []
    for (const t of types) {
      const taken = (await this._get('meta/type/' + t.id)) || 0
      out.push({ ...t, requireApproval: t.requireApproval || !!ev.requireApproval, taken, left: t.capacity === null ? null : Math.max(0, t.capacity - taken) })
    }
    return out
  }

  async keys() {
    return this._get('keys')
  }

  async hosts() {
    return (await this._list('hosts/')).filter((h) => h.role !== 'scanner')
  }

  async roster() {
    return this._list('roster/')
  }

  async blasts() {
    return this._list('blasts/')
  }

  // ---- guest ----

  async rsvp({ name, email = null, answers = {}, ticketType = null }) {
    if (await this.needsUpdate()) throw new Error('Update Pluma to join this event')
    const keys = await this.keys()
    if (!keys) throw new Error('Event not loaded yet')
    const sealed = seal({ name, email, answers }, unhex(keys.boxKey))
    await this.base.append(
      { type: 'rsvp', ticketType, holderKey: hex(this.member.sign.publicKey), sealed: hex(sealed), at: Date.now() },
      { optimistic: true }
    )
    await this.base.update()
  }

  async cancelRsvp() {
    await this.base.append({ type: 'rsvp.cancel', at: Date.now() }, { optimistic: true })
    await this.base.update()
  }

  async myStatus() {
    const g = await this._get('guests/' + this.me)
    if (!g) return { status: 'none', ticket: null }
    const id = idFor(this.key, this.me)
    const t = await this._get('tickets/' + id)
    const revoked = await this._get('revoked/' + id)
    let position = null
    if (g.status === 'waitlist' && g.wseq) {
      position = 1
      for (const w of await this._list('waitlist/')) if (Number(w.id) < g.wseq) position++
    }
    return { status: g.status, message: g.message, ticketType: g.ticketType, position, ticket: t && !revoked ? t.ticket : null, ticketId: id }
  }

  async ticketQR(now = Date.now()) {
    const { ticket } = await this.myStatus()
    if (!ticket) return null
    return T.qr(unhex(ticket), this.member.sign.secretKey, now)
  }

  // ---- hosts ----

  async _append(value) {
    await this.base.append(value)
    await this.base.update()
  }

  async update(fields) { await this._append({ type: 'event.update', fields }) }
  async cancel() { await this._append({ type: 'event.cancel' }) }
  async approve(guest, message) { await this._append({ type: 'decide', guest, status: 'approved', message }) }
  async decline(guest, message) { await this._append({ type: 'decide', guest, status: 'declined', message }) }
  async setGuestListMode(mode) { await this.update({ guestListMode: mode }) }
  async hideGuest(guest, hidden = true) { await this._append({ type: 'guest.hidden', guest, hidden }) }
  async revokeTicket(guest, reason = 'cancelled by host') {
    await this._append({ type: 'ticket.revoke', ticketId: idFor(this.key, guest), reason })
  }
  async blast(body, audience = 'approved') { await this._append({ type: 'blast', body, audience, at: Date.now() }) }

  async addCohost({ key, boxKey, name = '', visible = true }) {
    await this._append({ type: 'host.add', key, boxKey, name, role: 'manager', visible })
    const sealed = seal({ seed: hex(this._ownHostSeed) }, unhex(boxKey))
    await this._append({ type: 'secrets.share', to: key, sealed: hex(sealed) })
  }

  async addScanner({ key, name = '' }) {
    await this._append({ type: 'host.add', key, name, role: 'scanner' })
  }

  // Full guest list with private details (hosts only).
  async guests() {
    const secrets = await this.hostSecrets()
    const list = await this._list('guests/')
    const hidden = new Set((await this._list('hidden/')).map((h) => h.id))
    return list.map((g) => {
      const details = secrets ? unseal(unhex(g.sealed), secrets.box) : null
      return { id: g.id, status: g.status, ticketType: g.ticketType || 'general', hidden: hidden.has(g.id), at: g.at, ...(details || { name: null }) }
    })
  }

  // Approved guests beyond capacity, newest first: the pre-selection for the
  // "N over capacity" flow (SPEC.md §3.2). Nothing is cancelled automatically.
  async overCapacity() {
    const ev = await this.info()
    if (!ev || ev.capacity === null) return []
    const approved = (await this.guests()).filter((g) => g.status === 'approved').sort((a, b) => b.at - a.at)
    return approved.slice(0, Math.max(0, approved.length - ev.capacity))
  }

  // ---- check-in (hosts and scanners, works offline) ----

  async scan(payload, now = Date.now()) {
    const ev = await this.info()
    const keys = await this.keys()
    if (!ev || !keys) return { ok: false, reason: 'event-not-synced' }
    const res = T.verifyQR(payload, { eventKey: this.key, ticketPublicKey: unhex(keys.ticketKey), now })
    if (!res.ok) return res
    if (await this._get('revoked/' + res.ticketId)) return { ok: false, reason: 'revoked', ticketId: res.ticketId }

    const t = await this._get('tickets/' + res.ticketId)
    let name = null
    if (t) {
      const secrets = await this.hostSecrets()
      const g = await this._get('guests/' + t.guest)
      const details = secrets && g ? unseal(unhex(g.sealed), secrets.box) : null
      name = details ? details.name : null
    }

    const prev = await this._get('checkins/' + res.ticketId)
    if (prev) return { ok: false, reason: 'already-checked-in', ticketId: res.ticketId, name, at: prev.at }

    await this.base.append({ type: 'checkin', ticketId: res.ticketId, at: now })
    await this.base.update()
    return { ok: true, ticketId: res.ticketId, name }
  }

  async checkins() {
    return this._list('checkins/')
  }

  async duplicateScans() {
    return (await this.checkins()).filter((c) => c.duplicates.length > 0)
  }

  async undoCheckin(ticketId) { await this._append({ type: 'checkin.undo', ticketId }) }

  // ---- host automation: issue tickets and keep the visible roster in sync ----

  _scheduleReconcile() {
    if (this._reconciling) {
      this._reconcileAgain = true
      return
    }
    this._reconciling = this._reconcile()
      .catch((err) => this.emit('error', err))
      .finally(() => {
        this._reconciling = null
        if (this._reconcileAgain) {
          this._reconcileAgain = false
          this._scheduleReconcile()
        }
      })
  }

  async reconciled() {
    while (this._reconciling) await this._reconciling
  }

  async _reconcile() {
    if (!this.base.writable) return
    const secrets = await this.hostSecrets()
    if (!secrets) return
    const ev = await this.info()
    if (!ev) return

    const guests = await this._list('guests/')
    const hidden = new Set((await this._list('hidden/')).map((h) => h.id))
    const roster = new Map((await this._list('roster/')).map((r) => [r.id, r.name]))

    for (const g of guests) {
      const id = idFor(this.key, g.id)
      if (g.status === 'approved' && !(await this._get('tickets/' + id))) {
        const ticket = T.issue({ eventKey: this.key, ticketId: unhex(id), holderKey: unhex(g.holderKey), issuedAt: Date.now() }, secrets.ticket.secretKey)
        await this.base.append({ type: 'ticket.issue', guest: g.id, ticket: hex(ticket) })
      }

      const show = g.status === 'approved' && ev.guestListMode !== 'private' && !(ev.guestListMode === 'selective' && hidden.has(g.id))
      if (show && !roster.has(g.id)) {
        const details = unseal(unhex(g.sealed), secrets.box)
        if (details && details.name) await this.base.append({ type: 'roster.set', guest: g.id, name: String(details.name).slice(0, 100) })
      } else if (!show && roster.has(g.id)) {
        await this.base.append({ type: 'roster.del', guest: g.id })
      }
    }
  }

  async close() {
    await this.reconciled()
    await this.base.close()
  }
}

module.exports = PlumaEvent
