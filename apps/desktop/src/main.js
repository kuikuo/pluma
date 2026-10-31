// Pluma desktop: runs @pluma/core in the main process; the window talks to it over IPC.
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron')
const path = require('path')
const fs = require('fs')
const QRCode = require('qrcode')
const b4a = require('b4a')
const { Pluma, toICS, toCSV } = require('../core')
const { idFor } = require('../core/lib/apply')

const INVITE_BASE = 'https://kuikuo.github.io/pluma/'
let win = null
let pluma = null
let opening = null
const watched = new Set()

function send(msg) {
  if (win && !win.isDestroyed()) win.webContents.send('pluma:event', msg)
}

async function open(link) {
  await opening
  const ev = await pluma.openEvent(link)
  if (!watched.has(ev.link)) {
    watched.add(ev.link)
    let timer = null
    ev.on('update', () => { clearTimeout(timer); timer = setTimeout(() => send({ event: 'update', link: ev.link }), 250) })
    ev.on('error', (err) => console.error(err))
  }
  return ev
}

function preview(info, hosts) {
  if (!info) return ''
  const p = { t: info.title, s: info.start, z: info.timezone, l: info.location || undefined, h: hosts.join(', ') || undefined }
  return b4a.toString(b4a.from(JSON.stringify(p)), 'base64url')
}

async function summary(ev) {
  const info = (await ev.info()) || {}
  return { link: ev.link, title: info.title || 'Loading…', start: info.start || null, cancelled: !!info.cancelled, role: await ev.role(), status: (await ev.myStatus()).status }
}

const methods = {
  async profile() { await opening; const p = await pluma.local.get('profile'); return p ? p.value : { name: '', email: '' } },
  async setProfile(p) { await opening; await pluma.local.put('profile', { name: p.name || '', email: p.email || '' }) },
  async events() { await opening; const out = []; for (const l of await pluma.myEvents()) out.push(await summary(await open(l))); return out },
  async peers() { return pluma && pluma.swarm ? pluma.swarm.connections.size : 0 },
  async createEvent(fields) { await opening; const p = await methods.profile(); const ev = await pluma.createEvent(fields, { name: p.name }); await open(ev.link); return ev.link },
  async open(link) { return (await open(link)).link },
  async detail(link) {
    const ev = await open(link)
    const info = await ev.info()
    const role = await ev.role()
    const manager = role === 'organiser' || role === 'manager'
    const hosts = (await ev.hosts()).filter((h) => h.visible).map((h) => h.name).filter(Boolean)
    let duplicates = []
    if (manager) {
      const guests = await ev.guests()
      for (const d of await ev.duplicateScans()) {
        const t = await ev._get('tickets/' + d.id)
        const g = t && guests.find((x) => x.id === t.guest)
        duplicates.push(g && g.name ? g.name : 'A guest')
      }
    }
    const pv = preview(info, hosts)
    return {
      link: ev.link, info, role, hosts,
      needsUpdate: await ev.needsUpdate(),
      ticketTypes: await ev.ticketTypes(),
      invite: INVITE_BASE + '#' + ev.link.slice(-64) + (pv ? '.' + pv : ''),
      mine: await ev.myStatus(),
      roster: (await ev.roster()).map((r) => r.name),
      blasts: (await ev.blasts()).map((b) => ({ body: b.body, at: b.at })),
      guests: manager ? await ev.guests() : null,
      overCapacity: manager ? (await ev.overCapacity()).map((g) => g.id) : [],
      duplicates,
      checkins: manager || role === 'scanner' ? (await ev.checkins()).length : 0,
      joinRequest: ev.joinRequest
    }
  },
  async rsvp(link, details) { await (await open(link)).rsvp(details) },
  async cancelRsvp(link) { await (await open(link)).cancelRsvp() },
  async ticketQR(link) { const code = await (await open(link)).ticketQR(); return code ? QRCode.toDataURL(code, { width: 360, margin: 2 }) : null },
  async qr(text) { return QRCode.toDataURL(text, { width: 300, margin: 2 }) },
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
  },
  async copy(text) { clipboard.writeText(text) },
  async openExternal(url) { if (/^https:\/\//.test(url)) await shell.openExternal(url) },
  async saveICS(link) {
    const ev = await open(link)
    const info = await ev.info()
    return saveFile((info.title || 'event') + '.ics', toICS(info, { link: ev.link, uid: ev.link.slice(-64) }), 'Calendar', 'ics')
  },
  async saveCSV(link) {
    const ev = await open(link)
    const scanned = new Set((await ev.checkins()).map((c) => c.id))
    const guests = await ev.guests()
    const checkins = new Set(guests.filter((g) => scanned.has(idFor(ev.key, g.id))).map((g) => g.id))
    const info = await ev.info()
    return saveFile((info.title || 'event') + ' guests.csv', toCSV(guests, info, checkins), 'Spreadsheet', 'csv')
  }
}

async function saveFile(name, text, label, ext) {
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(app.getPath('documents'), name.replace(/[\\/:*?"<>|]+/g, '')),
    filters: [{ name: label, extensions: [ext] }]
  })
  if (canceled || !filePath) return false
  fs.writeFileSync(filePath, text)
  shell.showItemInFolder(filePath)
  return true
}

ipcMain.handle('pluma:call', async (e, method, args) => {
  const fn = methods[method]
  if (!fn) throw new Error('Unknown method ' + method)
  return fn(...(args || []))
})

// pluma:// links open the event in the running app.
function handleUrl(url) {
  const m = /([0-9a-f]{64})/.exec(url || '')
  if (m) send({ event: 'open', link: 'pluma://event/' + m[1] })
}
if (!app.requestSingleInstanceLock()) app.quit()
app.on('second-instance', (e, argv) => { handleUrl(argv.find((a) => a.startsWith('pluma://'))); if (win) { if (win.isMinimized()) win.restore(); win.focus() } })
app.on('open-url', (e, url) => { e.preventDefault(); handleUrl(url) })
app.setAsDefaultProtocolClient('pluma')

app.whenReady().then(async () => {
  pluma = new Pluma(path.join(app.getPath('userData'), 'pluma-data'))
  opening = pluma.ready()
  win = new BrowserWindow({
    width: 1000, height: 820, minWidth: 720, minHeight: 600, title: 'Pluma',
    backgroundColor: '#f6f5fb',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  })
  win.removeMenu()
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb) => cb(permission === 'media')) // webcam for check-in
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' } })
  await win.loadFile(path.join(__dirname, 'index.html'))
  handleUrl(process.argv.find((a) => a.startsWith('pluma://')))
  // Test hook (development only): run a script of UI steps, then save a screenshot.
  if (process.env.PLUMA_SCREENSHOT) {
    const steps = process.env.PLUMA_STEPS ? require(path.resolve(process.env.PLUMA_STEPS)) : []
    setTimeout(async () => {
      for (const step of steps) {
        try { await win.webContents.executeJavaScript(step.js) } catch (err) { console.error('step failed', step.js, err.message) }
        await new Promise((r) => setTimeout(r, step.wait || 1500))
      }
      fs.writeFileSync(process.env.PLUMA_SCREENSHOT, (await win.webContents.capturePage()).toPNG())
      app.quit()
    }, 4000)
  }
})

app.on('window-all-closed', async () => {
  if (pluma) await pluma.close().catch(() => {})
  app.quit()
})
