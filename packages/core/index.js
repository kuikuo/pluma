const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Hyperbee = require('hyperbee')
const b4a = require('b4a')
const sodium = require('sodium-universal')
const ProtomuxWakeup = require('protomux-wakeup')
const PlumaEvent = require('./lib/event')
const ticket = require('./lib/ticket')
const { toICS, toCSV } = require('./lib/export')
const { RULES_VERSION } = require('./lib/apply')

class Pluma {
  constructor(storage, { bootstrap, swarm = true } = {}) {
    this.store = new Corestore(storage)
    this.swarm = swarm ? new Hyperswarm(bootstrap ? { bootstrap } : {}) : null
    this.events = new Map()
    this.local = null
    // One wakeup protocol shared by every event base, so peers announce which
    // writers (including guests' optimistic RSVP cores) have new data.
    this.wakeup = new ProtomuxWakeup()
    if (this.swarm) {
      this.swarm.on('connection', (conn) => {
        const stream = this.store.replicate(conn)
        this.wakeup.addStream(stream)
      })
    }
  }

  async ready() {
    await this.store.ready()
    this.local = new Hyperbee(this.store.get({ name: 'pluma-local' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
    await this.local.ready()
  }

  async createEvent(event, { name = '', rules } = {}) {
    const ns = b4a.toString(randomBytes(16), 'hex')
    const ev = new PlumaEvent(this, { ns, create: { event, name, rules } })
    await ev.ready()
    await this.local.put('events/' + b4a.toString(ev.key, 'hex'), { ns, created: true })
    return this._track(ev)
  }

  async openEvent(link) {
    const keyHex = parseLink(link)
    if (this.events.has(keyHex)) return this.events.get(keyHex)
    const saved = await this.local.get('events/' + keyHex)
    const ns = saved ? saved.value.ns : keyHex
    const ev = new PlumaEvent(this, { key: b4a.from(keyHex, 'hex'), ns })
    await ev.ready()
    if (!saved) await this.local.put('events/' + keyHex, { ns, created: false })
    return this._track(ev)
  }

  async myEvents() {
    const out = []
    for await (const { key } of this.local.createReadStream({ gt: 'events/', lt: 'events/\xff' })) {
      out.push('pluma://event/' + key.slice(7))
    }
    return out
  }

  _track(ev) {
    this.events.set(b4a.toString(ev.key, 'hex'), ev)
    if (this.swarm) this.swarm.join(ev.base.discoveryKey, { server: true, client: true })
    return ev
  }

  async close() {
    for (const ev of this.events.values()) await ev.close()
    if (this.swarm) await this.swarm.destroy()
    await this.local.close()
    await this.store.close()
  }
}

function parseLink(link) {
  const m = /^(?:pluma:\/\/event\/)?([0-9a-f]{64})$/.exec(String(link).trim())
  if (!m) throw new Error('Not a Pluma event link')
  return m[1]
}

function randomBytes(n) {
  const b = b4a.alloc(n)
  sodium.randombytes_buf(b)
  return b
}

module.exports = { Pluma, PlumaEvent, ticket, parseLink, toICS, toCSV, RULES_VERSION }
