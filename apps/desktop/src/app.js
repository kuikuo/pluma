/* global pluma, jsQR */
// Pluma desktop UI. Plain DOM; every value from the network is escaped.
const $app = document.getElementById('app')
const call = (m, ...a) => window.pluma.call(m, ...a)
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const KEY_RE = /(?:pluma:\/\/event\/|#)([0-9a-f]{64})/
const parseInvite = (t) => { const m = KEY_RE.exec(t || ''); return m ? 'pluma://event/' + m[1] : null }

const STATUS_TEXT = {
  approved: "You're going", pending: 'Waiting for the organiser to approve', waitlist: "You're on the waitlist",
  declined: 'Not approved', full: 'This event is full', closed: 'Registration is closed',
  cancelled: "You're not going", revoked: 'Your spot was cancelled by the host'
}
const HOST_STATUS = { approved: 'going', pending: 'waiting for you', waitlist: 'on waitlist', declined: 'declined', full: 'asked when full', closed: 'asked after closing', cancelled: 'cancelled', revoked: 'cancelled by host' }
const SCAN_REASONS = {
  'already-checked-in': 'Already checked in', revoked: 'Ticket was cancelled', 'expired-code': 'Old code — ask them to open the app',
  'not-holder': 'Copied ticket — not their phone', forged: 'Not a valid ticket', 'wrong-event': 'Ticket for a different event',
  unreadable: 'Not a Pluma ticket', 'event-not-synced': 'Event not loaded yet'
}

let stack = [{ name: 'home' }]
let timers = []
let cleanups = []
let stopCamera = null

function toast(msg) {
  const t = document.getElementById('toast')
  t.textContent = msg
  t.classList.add('show')
  setTimeout(() => t.classList.remove('show'), 2200)
}
function when(start, tz) {
  if (!start) return ''
  const local = new Date(start).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  return tz && tz !== here ? `${local} (your time) · event time zone ${tz}` : local
}
const listNames = (n) => n.length <= 1 ? n.join('') : n.slice(0, -1).join(', ') + ' and ' + n[n.length - 1]

function go(name, params = {}) { stack.push({ name, ...params }); render() }
function back() { if (stack.length > 1) stack.pop(); render() }
function home() { stack = [{ name: 'home' }]; render() }

function render() {
  timers.forEach(clearInterval); timers = []
  cleanups.forEach((f) => f()); cleanups = []
  if (stopCamera) { stopCamera(); stopCamera = null }
  const s = stack[stack.length - 1]
  window.scrollTo(0, 0)
  ;({ home: Home, create: Create, event: Event, scan: Scan, addHelper: AddHelper }[s.name])(s).catch((e) => { $app.innerHTML = `<p class="red">${esc(e.message)}</p>` })
}
function every(ms, fn) { timers.push(setInterval(fn, ms)) }
const on = (sel, ev, fn) => { const el = $app.querySelector(sel); if (el) el.addEventListener(ev, fn) }
const onAll = (sel, ev, fn) => $app.querySelectorAll(sel).forEach((el) => el.addEventListener(ev, () => fn(el)))

// ---------- home ----------
async function Home() {
  const draw = async () => {
    const events = await call('events')
    const peers = await call('peers')
    $app.innerHTML = `
      <h1>Pluma</h1>
      <div class="muted">Events without accounts. Tickets that work offline. Free, with no servers.</div>
      <div class="hero">
        <button id="create">Create an event</button>
        <button class="secondary" id="scan-invite">Scan an invite with the webcam</button>
      </div>
      <div class="card">
        <h3>Got an invite link?</h3>
        <div class="row"><input id="invite" placeholder="Paste the link here (https://… or pluma://…)"><button id="open" style="flex:0 0 auto">Open invite</button></div>
      </div>
      <h2>Your events</h2>
      ${events.length === 0 ? '<div class="muted">Nothing yet. Create one, or open an invite someone sent you.</div>' : ''}
      ${events.map((e) => `<div class="card event" data-link="${esc(e.link)}" tabindex="0">
        <h3>${esc(e.title)}${e.cancelled ? ' (cancelled)' : ''}</h3>
        <div class="muted">${esc(when(e.start))}</div>
        <div class="tag">${e.role === 'organiser' || e.role === 'manager' ? 'Hosting' : e.role === 'scanner' ? 'Check-in helper' : esc(STATUS_TEXT[e.status] || 'Invited')}</div>
      </div>`).join('')}
      <p class="muted center" style="margin-top:28px">${peers > 0 ? `Connected to ${peers} device${peers === 1 ? '' : 's'}` : 'Looking for other devices…'}</p>`
    on('#create', 'click', () => go('create'))
    on('#scan-invite', 'click', () => go('scan', { mode: 'invite' }))
    const openInvite = () => { const l = parseInvite($app.querySelector('#invite').value); if (!l) return toast('That doesn’t look like a Pluma invite link'); go('event', { link: l }) }
    on('#open', 'click', openInvite)
    on('#invite', 'keydown', (e) => { if (e.key === 'Enter') openInvite() })
    onAll('.event', 'click', (el) => go('event', { link: el.dataset.link }))
  }
  await draw()
  every(5000, () => { if (!document.activeElement || document.activeElement.id !== 'invite') draw() })
}

// ---------- create / edit ----------
async function Create({ link, info }) {
  const editing = !!info
  const pad = (n) => String(n).padStart(2, '0')
  const d = info && info.start ? new Date(info.start) : (() => { const t = new Date(Date.now() + 86400000); t.setHours(18, 0, 0, 0); return t })()
  const st = {
    title: info?.title || '', date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    location: info?.location || '', description: info?.description || '', capacity: info?.capacity ?? '',
    requireApproval: !!info?.requireApproval, mode: info?.guestListMode || 'private',
    types: (info?.ticketTypes || []).map((t) => ({ ...t, capacity: t.capacity ?? '' })),
    questions: (info?.questions || []).map((q) => ({ ...q, options: (q.options || []).join(', ') })),
    name: editing ? '' : (await call('profile')).name
  }
  const newId = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36)
  const draw = () => {
    $app.innerHTML = `
      <button class="back" id="back">‹ Back</button>
      <h1>${editing ? 'Edit event' : 'New event'}</h1>
      <label>Event name</label><input id="title" value="${esc(st.title)}" placeholder="Hack night">
      <div class="row"><div><label>Date</label><input id="date" type="date" value="${esc(st.date)}"></div><div><label>Time</label><input id="time" type="time" value="${esc(st.time)}"></div></div>
      <label>Where</label><input id="location" value="${esc(st.location)}" placeholder="Address or video link">
      <label>About</label><textarea id="description" placeholder="What should guests know?">${esc(st.description)}</textarea>
      <div class="row"><div><label>Capacity (optional)</label><input id="capacity" type="number" min="0" value="${esc(st.capacity)}" placeholder="No limit"></div>
        <div><label>&nbsp;</label><label style="display:flex;gap:8px;align-items:center;font-size:15px;color:#222"><input id="approval" type="checkbox" style="width:auto" ${st.requireApproval ? 'checked' : ''}> I approve each guest</label></div></div>
      <label>Who can see the guest list?</label>
      <div class="seg" id="mode">${[['private', 'Only hosts'], ['selective', 'Guests (I pick)'], ['public', 'All guests']].map(([v, l]) => `<button data-v="${v}" class="${st.mode === v ? 'on' : ''}">${l}</button>`).join('')}</div>
      <h2>Ticket types</h2>
      ${st.types.length === 0 ? '<div class="muted">One general ticket. Add types for things like Speaker or Volunteer.</div>' : ''}
      ${st.types.map((t, i) => `<div class="card"><div class="row">
        <div><label>Name</label><input data-type="${i}" data-f="name" value="${esc(t.name)}" placeholder="General"></div>
        <div><label>Capacity</label><input data-type="${i}" data-f="capacity" type="number" min="0" value="${esc(t.capacity)}" placeholder="No limit"></div></div>
        <label style="display:flex;gap:8px;align-items:center;font-size:15px;color:#222"><input data-type="${i}" data-f="requireApproval" type="checkbox" style="width:auto" ${t.requireApproval ? 'checked' : ''}> I approve these guests</label>
        ${editing ? '' : `<button class="link red" data-rmtype="${i}">Remove</button>`}</div>`).join('')}
      <button class="secondary" id="addtype" style="margin-top:10px">+ Add ticket type</button>
      <h2>Questions for guests</h2>
      ${st.questions.map((q, i) => `<div class="card">
        <label>Question</label><input data-q="${i}" data-f="label" value="${esc(q.label)}" placeholder="Dietary needs?">
        <div class="row"><div><label>Answer type</label><select data-q="${i}" data-f="kind">${[['text', 'Text'], ['choice', 'Choice'], ['agree', 'Checkbox (agree)']].map(([v, l]) => `<option value="${v}" ${q.kind === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
          <div><label>&nbsp;</label><label style="display:flex;gap:8px;align-items:center;font-size:15px;color:#222"><input data-q="${i}" data-f="required" type="checkbox" style="width:auto" ${q.required ? 'checked' : ''}> Required</label></div></div>
        ${q.kind === 'choice' ? `<label>Options (comma separated)</label><input data-q="${i}" data-f="options" value="${esc(q.options)}" placeholder="None, Vegetarian, Halal">` : ''}
        <button class="link red" data-rmq="${i}">Remove</button></div>`).join('')}
      <button class="secondary" id="addq" style="margin-top:10px">+ Add question</button>
      ${editing ? '' : `<label style="margin-top:22px">Your name (shown as host)</label><input id="name" value="${esc(st.name)}" placeholder="Your name">`}
      ${editing ? '<p class="muted">Guests see changes the next time their app syncs. Lowering capacity never cancels anyone automatically.</p>' : ''}
      <button id="save" style="width:100%;margin-top:18px">${editing ? 'Save changes' : 'Publish'}</button>`
    const read = () => {
      for (const k of ['title', 'date', 'time', 'location', 'description', 'capacity', 'name']) { const el = $app.querySelector('#' + k); if (el) st[k] = el.value }
      st.requireApproval = $app.querySelector('#approval').checked
      $app.querySelectorAll('[data-type]').forEach((el) => { st.types[el.dataset.type][el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value })
      $app.querySelectorAll('[data-q]').forEach((el) => { st.questions[el.dataset.q][el.dataset.f] = el.type === 'checkbox' ? el.checked : el.value })
    }
    on('#back', 'click', back)
    onAll('#mode button', 'click', (b) => { read(); st.mode = b.dataset.v; draw() })
    on('#addtype', 'click', () => { read(); st.types.push({ id: newId('t'), name: st.types.length ? '' : 'General', capacity: '', requireApproval: false }); draw() })
    on('#addq', 'click', () => { read(); st.questions.push({ id: newId('q'), label: '', kind: 'text', options: '', required: false }); draw() })
    onAll('[data-rmtype]', 'click', (b) => { read(); st.types.splice(+b.dataset.rmtype, 1); draw() })
    onAll('[data-rmq]', 'click', (b) => { read(); st.questions.splice(+b.dataset.rmq, 1); draw() })
    onAll('select[data-q]', 'change', () => { read(); draw() })
    on('#save', 'click', async (e) => {
      read()
      if (!st.title.trim()) return toast('Give your event a name')
      const start = new Date(`${st.date}T${st.time || '18:00'}:00`)
      if (isNaN(start)) return toast('Check the date and time')
      e.target.disabled = true
      const fields = {
        title: st.title.trim(), start: start.toISOString(), timezone: editing ? info.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
        location: st.location.trim(), description: st.description.trim(), capacity: st.capacity === '' ? null : Number(st.capacity),
        requireApproval: st.requireApproval, guestListMode: st.mode,
        ticketTypes: st.types.filter((t) => String(t.name).trim()).map((t) => ({ id: t.id, name: String(t.name).trim(), capacity: t.capacity === '' ? null : Number(t.capacity), requireApproval: !!t.requireApproval })),
        questions: st.questions.filter((q) => String(q.label).trim()).map((q) => ({ id: q.id, label: String(q.label).trim(), kind: q.kind, required: !!q.required, options: q.kind === 'choice' ? String(q.options).split(',').map((o) => o.trim()).filter(Boolean) : [] }))
      }
      try {
        if (editing) { await call('update', link, fields); back(); return }
        if (st.name.trim()) await call('setProfile', { name: st.name.trim() })
        const l = await call('createEvent', fields)
        stack = [{ name: 'home' }, { name: 'event', link: l }]
        render()
        toast('Published! Share the invite link with your guests.')
      } catch (err) { toast(err.message); e.target.disabled = false }
    })
  }
  draw()
}

// ---------- event ----------
async function Event({ link }) {
  let rsvping = false
  let blastDraft = ''
  const draw = async () => {
    if (document.activeElement && ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName) && $app.contains(document.activeElement)) return
    const d = await call('detail', link)
    if (!d.info) {
      $app.innerHTML = `<button class="back" id="back">‹ Events</button><div class="card center"><h3>Finding the event…</h3>
        <p class="muted">This works as soon as the host or another guest has Pluma open. You can leave this screen; it keeps trying.</p></div>`
      on('#back', 'click', back)
      return
    }
    if (d.needsUpdate) {
      $app.innerHTML = `<button class="back" id="back">‹ Events</button><h1>${esc(d.info.title)}</h1><p>This event was made with a newer version of Pluma. Update the app to see it and join.</p>`
      on('#back', 'click', back)
      return
    }
    const manager = d.role === 'organiser' || d.role === 'manager'
    $app.innerHTML = `
      <button class="back" id="back">‹ Events</button>
      ${d.info.cancelled ? '<p class="red">This event has been cancelled.</p>' : ''}
      <h1>${esc(d.info.title)}</h1>
      <div>${esc(when(d.info.start, d.info.timezone))}</div>
      ${d.info.location ? `<div>📍 ${esc(d.info.location)}</div>` : ''}
      ${d.hosts.length ? `<div class="muted">Hosted by ${esc(d.hosts.join(', '))}</div>` : ''}
      ${d.info.description ? `<p>${esc(d.info.description)}</p>` : ''}
      ${d.blasts.length ? `<div class="card"><h3>Updates from the host</h3>${d.blasts.slice().reverse().map((b) => `<div>• ${esc(b.body)}</div>`).join('')}</div>` : ''}
      ${manager ? await hostView(d) : d.role === 'scanner' ? '<button id="checkin" style="width:100%;margin-top:14px">Check in guests</button>' : await guestView(d, rsvping)}
      ${!manager && d.roster.length ? `<div class="card"><h3>Who’s going</h3><div>${esc(d.roster.join(', '))}</div></div>` : ''}
      ${!manager && d.role !== 'scanner' ? `<details class="card"><summary class="muted">Helping run this event?</summary><p>Ask the organiser to scan this with “Add a co-host or door helper”.</p><img class="qr" src="${await call('qr', 'pluma-join:' + JSON.stringify(d.joinRequest))}" alt="Helper code"></details>` : ''}`
    on('#back', 'click', back)
    on('#checkin', 'click', () => go('scan', { mode: 'tickets', link }))
    on('#going', 'click', () => { rsvping = true; draw() })
    on('#cant', 'click', async () => { if (confirm('Cancel your spot? Your ticket will stop working.')) { await call('cancelRsvp', link); draw() } })
    on('#ics', 'click', async () => { if (await call('saveICS', link)) toast('Saved — open the file to add it to your calendar') })
    on('#copy', 'click', async () => { await call('copy', d.invite); toast('Invite link copied') })
    on('#openpage', 'click', () => call('openExternal', d.invite))
    on('#csv', 'click', async () => { if (await call('saveCSV', link)) toast('Guest list saved') })
    on('#edit', 'click', () => go('create', { link, info: d.info }))
    on('#helper', 'click', () => go('addHelper', { link }))
    on('#cancel-event', 'click', async () => { if (confirm('Cancel this event? All guests will see it is cancelled.')) { await call('cancelEvent', link); draw() } })
    onAll('#mode button', 'click', async (b) => { await call('setMode', link, b.dataset.v); draw() })
    onAll('[data-approve]', 'click', async (b) => { await call('approve', link, b.dataset.approve); draw() })
    onAll('[data-decline]', 'click', async (b) => { await call('decline', link, b.dataset.decline); draw() })
    onAll('[data-hide]', 'click', async (b) => { await call('hide', link, b.dataset.hide, b.dataset.hidden !== 'true'); draw() })
    onAll('[data-revoke]', 'click', async (b) => { if (confirm(`Cancel ${b.dataset.name}'s ticket? They will be told their spot was cancelled.`)) { await call('revoke', link, b.dataset.revoke); draw() } })
    on('#blast', 'input', (e) => { blastDraft = e.target.value })
    on('#send', 'click', async () => { if (!blastDraft.trim()) return; await call('blast', link, blastDraft.trim()); blastDraft = ''; toast('Sent to everyone going'); draw() })
    if (rsvping) bindRsvp(d, () => { rsvping = false; draw() })
  }
  await draw()
  every(4000, draw)
  const off = window.pluma.onEvent((m) => { if (m.link === link) draw() })
  cleanups.push(off)
}

async function guestView(d, rsvping) {
  const st = d.mine.status
  const canRsvp = st === 'none' || st === 'cancelled'
  let ticket = ''
  if (d.mine.ticket) {
    const img = await call('ticketQR', d.link)
    ticket = `<div class="card center"><h3>Your ticket</h3><img class="qr" id="ticket" src="${img}" alt="Ticket QR code" width="300">
      <div class="muted">Saved on this computer — works offline. The code refreshes itself, so screenshots won’t work.</div></div>`
  }
  return `
    ${st !== 'none' ? `<p class="${st === 'approved' ? 'green' : ''}" style="font-weight:600;font-size:17px">${esc(STATUS_TEXT[st] || st)}${d.mine.message ? ' — ' + esc(d.mine.message) : ''}</p>` : ''}
    ${st === 'pending' ? '<div class="muted">We’ll keep trying in the background.</div>' : ''}
    ${st === 'waitlist' ? `<div class="muted">${d.mine.position ? `You're number ${d.mine.position} in line. ` : ''}If a spot opens up, your ticket appears here automatically.</div>` : ''}
    ${st === 'approved' && !d.mine.ticket ? '<div class="muted">Your ticket is on its way — it arrives as soon as a host is online.</div>' : ''}
    ${ticket}
    ${['approved', 'pending', 'waitlist'].includes(st) ? '<div class="row" style="margin-top:10px"><button class="secondary" id="ics">Add to calendar</button><button class="secondary" id="cant">I can’t make it</button></div>' : ''}
    ${canRsvp && !d.info.cancelled ? (rsvping ? await rsvpForm(d) : '<button id="going" style="width:100%;margin-top:10px">I’m going</button>') : ''}`
}

async function rsvpForm(d) {
  const p = await call('profile')
  const qs = d.info.questions || []
  return `<div class="card" id="rsvp">
    ${d.ticketTypes.length > 1 ? `<label>Ticket</label>${d.ticketTypes.map((t, i) => `<div class="option ${i === 0 ? 'on' : ''}" data-tt="${esc(t.id)}"><b>${esc(t.name)}</b>
      <div class="muted">${t.left === 0 ? 'Full — join the waitlist' : t.left !== null ? `${t.left} left` : ''}${t.requireApproval ? (t.left !== null ? ' · ' : '') + 'host approves' : ''}</div></div>`).join('')}` : ''}
    <label>Your name</label><input id="rname" value="${esc(p.name)}" placeholder="Name">
    <label>Email (optional)</label><input id="remail" type="email" value="${esc(p.email)}" placeholder="For the host only">
    ${qs.map((q) => q.kind === 'agree'
      ? `<label style="display:flex;gap:8px;align-items:center;font-size:15px;color:#222"><input type="checkbox" data-ans="${esc(q.id)}" style="width:auto"> ${esc(q.label)}${q.required ? ' *' : ''}</label>`
      : q.kind === 'choice'
        ? `<label>${esc(q.label)}${q.required ? ' *' : ''}</label><div class="chips" data-choice="${esc(q.id)}">${q.options.map((o) => `<button class="chip" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>`
        : `<label>${esc(q.label)}${q.required ? ' *' : ''}</label><input data-ans="${esc(q.id)}" placeholder="Your answer">`).join('')}
    <p class="muted">${d.info.guestListMode === 'private' ? 'Only the hosts will see your name, details and answers.' : 'Other guests will see your name. Only hosts see your email and answers.'}</p>
    <button id="confirm" style="width:100%">Confirm</button></div>`
}

function bindRsvp(d, done) {
  let ticketType = d.ticketTypes[0] ? d.ticketTypes[0].id : null
  const choices = {}
  onAll('.option', 'click', (el) => { $app.querySelectorAll('.option').forEach((o) => o.classList.remove('on')); el.classList.add('on'); ticketType = el.dataset.tt })
  onAll('[data-opt]', 'click', (b) => { const box = b.parentElement; box.querySelectorAll('.chip').forEach((c) => c.classList.remove('on')); b.classList.add('on'); choices[box.dataset.choice] = b.dataset.opt })
  on('#confirm', 'click', async (e) => {
    const name = $app.querySelector('#rname').value.trim()
    const email = $app.querySelector('#remail').value.trim()
    if (!name) return toast('Add your name so the host knows who’s coming')
    const answers = { ...choices }
    $app.querySelectorAll('[data-ans]').forEach((el) => { answers[el.dataset.ans] = el.type === 'checkbox' ? el.checked : el.value })
    for (const q of d.info.questions || []) {
      const a = answers[q.id]
      if (q.required && (q.kind === 'agree' ? a !== true : !a)) return toast('Please answer: ' + q.label)
    }
    e.target.disabled = true
    try {
      await call('setProfile', { name, email })
      await call('rsvp', d.link, { name, email: email || null, answers, ticketType })
      done()
    } catch (err) { toast(err.message); e.target.disabled = false }
  })
}

async function hostView(d) {
  const guests = d.guests || []
  const counts = guests.reduce((a, g) => ({ ...a, [g.status]: (a[g.status] || 0) + 1 }), {})
  const over = new Set(d.overCapacity)
  const types = new Map(d.ticketTypes.map((t) => [t.id, t.name]))
  const qs = d.info.questions || []
  return `
    <div class="card"><h3>Invite people</h3>
      <img class="qr" src="${await call('qr', d.invite)}" alt="Invite QR code" width="220">
      <input readonly value="${esc(d.invite)}" onclick="this.select()">
      <div class="row" style="margin-top:10px"><button id="copy">Copy invite link</button><button class="secondary" id="openpage">Preview invite page</button></div>
      <div class="help">Keep Pluma open while guests sign up — your computer is what shares the event. Add a co-host so it stays reachable when you're away.</div>
    </div>
    <div class="card"><h3>Guests</h3>
      <div class="muted">${counts.approved || 0} going${d.info.capacity !== null ? ` of ${d.info.capacity}` : ''} · ${counts.pending || 0} waiting · ${counts.waitlist || 0} on waitlist · ${d.checkins} checked in</div>
      ${d.ticketTypes.length > 1 ? `<div class="muted">${d.ticketTypes.map((t) => `${esc(t.name)}: ${t.taken}${t.capacity !== null ? '/' + t.capacity : ''}`).join(' · ')}</div>` : ''}
      ${over.size ? `<p class="red">${over.size} ${over.size === 1 ? 'guest' : 'guests'} over capacity. The most recent sign-ups are highlighted; cancel tickets to fit.</p>` : ''}
      ${d.duplicates.length ? `<p class="red">${esc(listNames(d.duplicates))} ${d.duplicates.length === 1 ? 'was' : 'were'} checked in at two doors. Worth a look.</p>` : ''}
      ${guests.length === 0 ? '<p class="muted">No one yet. Share the invite!</p>' : ''}
      ${guests.map((g) => `<div class="guest ${over.has(g.id) ? 'over' : ''}"><div>
          <div>${esc(g.name || 'Unknown')}${g.hidden ? ' (hidden)' : ''}</div>
          <div class="muted">${esc(HOST_STATUS[g.status] || g.status)}${d.ticketTypes.length > 1 ? ' · ' + esc(types.get(g.ticketType) || g.ticketType) : ''}${g.email ? ' · ' + esc(g.email) : ''}</div>
          ${qs.length && g.answers ? `<div class="muted">${esc(qs.filter((q) => g.answers[q.id] !== undefined && g.answers[q.id] !== '').map((q) => `${q.label}: ${g.answers[q.id] === true ? 'yes' : g.answers[q.id] === false ? 'no' : g.answers[q.id]}`).join(' · '))}</div>` : ''}
        </div>
        ${['pending', 'full', 'waitlist'].includes(g.status) ? `<button class="link" data-approve="${esc(g.id)}">Approve</button><button class="link red" data-decline="${esc(g.id)}">Decline</button>` : ''}
        ${g.status === 'approved' ? `${d.info.guestListMode === 'selective' ? `<button class="link" data-hide="${esc(g.id)}" data-hidden="${g.hidden}">${g.hidden ? 'Show' : 'Hide'}</button>` : ''}<button class="link red" data-revoke="${esc(g.id)}" data-name="${esc(g.name || 'this guest')}">Cancel</button>` : ''}
      </div>`).join('')}
      ${guests.length ? '<button class="secondary" id="csv" style="margin-top:10px">Export guest list (CSV)</button>' : ''}
    </div>
    <div class="card"><h3>Who can see the guest list?</h3>
      <div class="seg" id="mode">${[['private', 'Only hosts'], ['selective', 'I pick'], ['public', 'All guests']].map(([v, l]) => `<button data-v="${v}" class="${d.info.guestListMode === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
    <div class="card"><h3>Message guests</h3><textarea id="blast" placeholder="e.g. Doors open at 6:30"></textarea><button class="secondary" id="send" style="margin-top:8px">Send to everyone going</button></div>
    <div class="stack" style="margin-top:14px">
      <button id="checkin" style="width:100%">Check in guests</button>
      <button class="secondary" id="edit" style="width:100%">Edit event details</button>
      ${d.role === 'organiser' ? '<button class="secondary" id="helper" style="width:100%">Add a co-host or door helper</button>' : ''}
      ${d.role === 'organiser' && !d.info.cancelled ? '<button class="danger" id="cancel-event" style="width:100%">Cancel event</button>' : ''}
    </div>`
}

// ---------- scanning (webcam, or paste a code) ----------
async function startCamera(onCode) {
  const video = $app.querySelector('video')
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 1280, height: 720 } })
    video.srcObject = stream
    await video.play()
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    let busy = false
    const t = setInterval(async () => {
      if (busy || !video.videoWidth) return
      canvas.width = video.videoWidth; canvas.height = video.videoHeight
      ctx.drawImage(video, 0, 0)
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const qr = jsQR(img.data, img.width, img.height, { inversionAttempts: 'dontInvert' })
      if (qr && qr.data) { busy = true; await onCode(qr.data); setTimeout(() => { busy = false }, 1800) }
    }, 200)
    stopCamera = () => { clearInterval(t); stream.getTracks().forEach((x) => x.stop()) }
  } catch {
    $app.querySelector('#cam-msg').textContent = 'No webcam available. Paste the code below instead.'
  }
}

async function Scan({ mode, link }) {
  const title = mode === 'invite' ? 'Scan an invite' : 'Check in guests'
  $app.innerHTML = `<button class="back" id="back">‹ Done</button><h1>${title}</h1>
    <p class="muted" id="cam-msg">${mode === 'invite' ? 'Hold the invite QR code up to your webcam.' : 'Hold the guest’s ticket up to your webcam. Works offline.'}</p>
    <video playsinline muted></video><div id="result"></div>
    <label>Or paste a ${mode === 'invite' ? 'link' : 'ticket code'}</label><div class="row"><input id="code"><button id="go" style="flex:0 0 auto">${mode === 'invite' ? 'Open' : 'Check in'}</button></div>`
  on('#back', 'click', back)
  const handle = async (data) => {
    if (mode === 'invite') {
      const l = parseInvite(data)
      if (!l) return show(false, 'Not a Pluma invite')
      stack.pop(); go('event', { link: l })
      return
    }
    const r = await call('scan', link, data.trim())
    show(r.ok, r.ok ? (r.name ? `Welcome, ${r.name}` : 'Valid ticket') : (SCAN_REASONS[r.reason] || r.reason) + (r.name ? ` — ${r.name}` : ''))
  }
  const show = (ok, text) => { $app.querySelector('#result').innerHTML = `<div class="result ${ok ? 'ok' : 'bad'}">${ok ? '✓' : '✕'} ${esc(text)}</div>` }
  on('#go', 'click', () => handle($app.querySelector('#code').value))
  startCamera(handle)
}

async function AddHelper({ link }) {
  $app.innerHTML = `<button class="back" id="back">‹ Done</button><h1>Add a co-host or door helper</h1>
    <p class="muted">On their device, open the event and choose “Helping run this event?”. Hold their code up to your webcam.</p>
    <video playsinline muted></video><p id="cam-msg" class="muted"></p><div id="result"></div>`
  on('#back', 'click', back)
  startCamera(async (data) => {
    if (!data.startsWith('pluma-join:')) return
    const req = JSON.parse(data.slice('pluma-join:'.length))
    const full = confirm('Give them full co-host access?\n\nOK = co-host (manage guests)\nCancel = door helper (check-in only)')
    await call('addHelper', link, req, full ? 'manager' : 'scanner')
    $app.querySelector('#result').innerHTML = `<div class="result ok">✓ ${full ? 'Co-host' : 'Door helper'} added</div>`
  })
}

window.pluma.onEvent((m) => { if (m.event === 'open') go('event', { link: m.link }) })
render()
