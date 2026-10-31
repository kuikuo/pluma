const test = require('brittle')
const { devices, link, eventually } = require('./helpers')

const EVENT = { title: 'Demo', start: '2026-11-01T18:00:00Z', timezone: 'UTC' }

async function guestJoins(ev, guestDevice, name) {
  const g = await guestDevice.openEvent(ev.link)
  await eventually(() => g.info())
  await g.rsvp({ name })
  return g
}

test('capacity is never oversold, cancel frees a seat', async (t) => {
  const [org, a, b, c] = await devices(t, 4)
  const ev = await org.createEvent({ ...EVENT, capacity: 2 })
  for (const d of [a, b, c]) link(org, d)

  const ga = await guestJoins(ev, a, 'A')
  const gb = await guestJoins(ev, b, 'B')
  const gc = await guestJoins(ev, c, 'C')

  const statuses = await eventually(async () => {
    const l = await ev.guests()
    return l.length === 3 && l.map((g) => g.status).sort()
  })
  t.alike(statuses, ['approved', 'approved', 'full'])

  const full = [ga, gb, gc]
  const states = await Promise.all(full.map((g) => eventually(async () => { const s = await g.myStatus(); return s.status !== 'none' && s })))
  const loser = full[states.findIndex((s) => s.status === 'full')]
  const winner = full[states.findIndex((s) => s.status === 'approved')]

  await eventually(async () => (await winner.myStatus()).ticket)
  await winner.cancelRsvp()
  await eventually(async () => (await ev.guests()).some((g) => g.status === 'cancelled'))

  const loserId = loser.me
  await ev.approve(loserId)
  await eventually(async () => (await loser.myStatus()).ticket)
  t.pass('freed seat can be given to the guest who was full')
})

test('approval required: pending until a host approves; decline revokes', async (t) => {
  const [org, a] = await devices(t, 2)
  const ev = await org.createEvent({ ...EVENT, requireApproval: true })
  link(org, a)
  const g = await guestJoins(ev, a, 'Ada')

  await eventually(async () => (await g.myStatus()).status === 'pending')
  t.is((await g.myStatus()).ticket, null)

  await ev.approve(g.me)
  await eventually(async () => (await g.myStatus()).ticket)
  await ev.decline(g.me, 'Sorry, full')
  const s = await eventually(async () => { const s = await g.myStatus(); return s.status === 'declined' && s })
  t.is(s.ticket, null)
  t.is(s.message, 'Sorry, full')
})

test('guest list privacy modes', async (t) => {
  const [org, a, b] = await devices(t, 3)
  const ev = await org.createEvent(EVENT)
  link(org, a); link(org, b)
  const ga = await guestJoins(ev, a, 'Ada')
  const gb = await guestJoins(ev, b, 'Bo')
  await eventually(async () => (await ev.guests()).filter((g) => g.status === 'approved').length === 2)
  await ev.reconciled()

  t.is((await ga.roster()).length, 0, 'private by default: no names published')

  await ev.setGuestListMode('public')
  const names = await eventually(async () => { const r = await gb.roster(); return r.length === 2 && r.map((x) => x.name).sort() })
  t.alike(names, ['Ada', 'Bo'])

  await ev.setGuestListMode('selective')
  await ev.hideGuest(ga.me)
  await eventually(async () => { const r = await gb.roster(); return r.length === 1 && r[0].name === 'Bo' })

  await ev.setGuestListMode('private')
  await eventually(async () => (await gb.roster()).length === 0)
  t.pass('selective hides one guest, private removes all')
})

test('a co-host confirms guests while the organiser is offline', async (t) => {
  const [org, co, a] = await devices(t, 3)
  const ev = await org.createEvent({ ...EVENT, requireApproval: true })
  const unlinkOrgCo = link(org, co)
  const coEv = await co.openEvent(ev.link)
  await eventually(() => coEv.info())
  await ev.addCohost({ ...coEv.joinRequest, name: 'Co' })
  await eventually(async () => coEv.base.writable && (await coEv.hostSecrets()))

  unlinkOrgCo() // organiser goes offline
  link(co, a)
  const g = await guestJoins(coEv, a, 'Ada')
  const pending = await eventually(async () => { const l = await coEv.guests(); return l.length === 1 && l[0] })
  t.is(pending.name, 'Ada', 'co-host can read private details')

  await coEv.approve(g.me)
  await eventually(async () => (await g.myStatus()).ticket)
  t.pass('guest got a ticket signed with the event key, organiser never online')
})

test('offline scanners: verify locally, merge later, flag duplicates', async (t) => {
  const [org, s1, s2, a] = await devices(t, 4)
  const ev = await org.createEvent(EVENT)
  const u1 = link(org, s1)
  const u2 = link(org, s2)
  link(org, a)

  const e1 = await s1.openEvent(ev.link)
  const e2 = await s2.openEvent(ev.link)
  await eventually(() => e1.info())
  await eventually(() => e2.info())
  await ev.addScanner({ key: e1.me })
  await ev.addScanner({ key: e2.me })
  await eventually(() => e1.base.writable && e2.base.writable)

  const g = await guestJoins(ev, a, 'Ada')
  await eventually(async () => (await g.myStatus()).ticket)
  await eventually(async () => (await e1.keys()) && (await e2.keys()))

  u1(); u2() // both scanners lose connectivity at the door

  const r1 = await e1.scan(await g.ticketQR())
  const r2 = await e2.scan(await g.ticketQR())
  t.ok(r1.ok, 'scanner 1 accepts offline')
  t.ok(r2.ok, 'scanner 2 also accepts (it cannot know)')
  t.is((await e1.scan(await g.ticketQR())).reason, 'already-checked-in', 'same scanner rejects a re-scan')

  link(org, s1); link(org, s2)
  const dups = await eventually(async () => { const d = await ev.duplicateScans(); return d.length === 1 && d })
  t.is(dups[0].duplicates.length, 1, 'organiser sees the duplicate after merge')
})

test('guests and strangers cannot perform host actions', async (t) => {
  const [org, a] = await devices(t, 2)
  const ev = await org.createEvent({ ...EVENT, requireApproval: true })
  link(org, a)
  const g = await guestJoins(ev, a, 'Mallory')
  await eventually(async () => (await g.myStatus()).status === 'pending')

  // Try to approve self and rename the event via optimistic appends.
  await g.base.append({ type: 'decide', guest: g.me, status: 'approved' }, { optimistic: true })
  await g.base.append({ type: 'event.update', fields: { title: 'Pwned' } }, { optimistic: true })
  await g.base.append({ type: 'checkin', ticketId: '00'.repeat(32), at: 1 }, { optimistic: true })
  await new Promise((r) => setTimeout(r, 1500))
  await ev.base.update()

  t.is((await ev.info()).title, 'Demo')
  t.is((await ev.guests())[0].status, 'pending')
  t.is((await ev.checkins()).length, 0)
})

test('host cancelling a ticket marks it revoked with a reason, and the seat frees up', async (t) => {
  const [org, a, b] = await devices(t, 3)
  const ev = await org.createEvent({ ...EVENT, capacity: 1 })
  link(org, a); link(org, b)
  const ga = await guestJoins(ev, a, 'Ada')
  await eventually(async () => (await ga.myStatus()).ticket)

  await ev.revokeTicket(ga.me, 'Event capacity was reduced')
  const s = await eventually(async () => { const s = await ga.myStatus(); return s.status === 'revoked' && s })
  t.is(s.message, 'Event capacity was reduced')
  t.is(s.ticket, null)

  const gb = await guestJoins(ev, b, 'Bo')
  await eventually(async () => (await gb.myStatus()).status === 'approved')
  t.pass('the freed seat goes to the next guest')
})
