const createTestnet = require('hyperdht/testnet')
const { Pluma } = require('..')

async function network(t, n) {
  const testnet = await createTestnet(3, t.teardown)
  const peers = []
  for (let i = 0; i < n; i++) {
    const p = new Pluma(await t.tmp(), { bootstrap: testnet.bootstrap })
    await p.ready()
    t.teardown(() => p.close(), { order: -1 })
    peers.push(p)
  }
  return peers
}

async function eventually(fn, { timeout = 20000, interval = 100 } = {}) {
  const start = Date.now()
  let last
  while (Date.now() - start < timeout) {
    try {
      const v = await fn()
      if (v) return v
    } catch (err) {
      last = err
    }
    await new Promise((r) => setTimeout(r, interval))
  }
  throw last || new Error('timed out')
}

module.exports = { network, eventually }

// Devices without the DHT, linked directly so tests can take them on/offline.
async function devices(t, n) {
  const out = []
  for (let i = 0; i < n; i++) {
    const p = new Pluma(await t.tmp(), { swarm: false })
    await p.ready()
    t.teardown(() => p.close(), { order: -1 })
    out.push(p)
  }
  return out
}

function link(a, b) {
  const s1 = a.store.replicate(true)
  const s2 = b.store.replicate(false)
  s1.pipe(s2).pipe(s1)
  a.wakeup.addStream(s1)
  b.wakeup.addStream(s2)
  return () => { s1.destroy(); s2.destroy() }
}

module.exports.devices = devices
module.exports.link = link
