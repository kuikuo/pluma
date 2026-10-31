const test = require('brittle')
const b4a = require('b4a')
const { devices, link, eventually } = require('./helpers')
const { toICS, toCSV } = require('..')

const EVENT = { title: 'Demo', start: '2026-11-01T10:00:00.000Z', timezone: 'Asia/Singapore' }

async function join(ev, d, name, opts = {}) {
  const g = await d.openEvent(ev.link)
  await eventually(() => g.info())
  await g.rsvp({ name, ...opts })
  await eventually(async () => (await g.myStatus()).status !== 'none')
  return g
}

test('ticket types: per-type capacity and approval', async (t) => {
  const [org, a, b, c] = await devices(t, 4)
  const ev = await org.createEvent({
    ...EVENT,
    ticketTypes: [
      { id: 'ga', name: 'General', capacity: 1 },
      { id: 'speaker', name: 'Speaker', capacity: null, requireApproval: true }
    ]
  })
  for (const d of [a, b, c]) link(org, d)

  const ga = await join(ev, a, 'Ada', { ticketType: 'ga' })
  const gb = await join(ev, b, 'Bo', { ticketType: 'ga' })
  const gc = await join(ev, c, 'Cy', { ticketType: 'speaker' })

  t.is((await ga.myStatus()).status, 'approved')
  t.is((await gb.myStatus()).status, 'waitlist', 'General is full')
  t.is((await gc.myStatus()).status, 'pending', 'Speakers need approval even with room')
  const types = await ev.ticketTypes()
  t.alike(types.map((x) => [x.id, x.taken, x.left]), [['ga', 1, 0], ['speaker', 0, null]])
})

test('waitlist promotes in order when seats free up or capacity grows', async (t) => {
  const [org, a, b, c] = await devices(t, 4)
  const ev = await org.createEvent({ ...EVENT, capacity: 1 })
  for (const d of [a, b, c]) link(org, d)
  const ga = await join(ev, a, 'Ada')
  const gb = await join(ev, b, 'Bo')
  const gc = await join(ev, c, 'Cy')
  t.is((await gb.myStatus()).position, 1)
  t.is((await gc.myStatus()).position, 2)

  await ga.cancelRsvp()
  const sb = await eventually(async () => { const s = await gb.myStatus(); return s.status === 'approved' && s })
  t.is(sb.message, 'A spot opened up')
  t.is((await gc.myStatus()).status, 'waitlist')
  await eventually(async () => (await gc.myStatus()).position === 1)

  await ev.update({ capacity: 2 })
  await eventually(async () => (await gc.myStatus()).status === 'approved')
  await eventually(async () => (await gc.myStatus()).ticket)
  t.pass('raising capacity promoted the next guest, who got a ticket')
})

test('answers to custom questions reach hosts only', async (t) => {
  const [org, a] = await devices(t, 2)
  const ev = await org.createEvent({
    ...EVENT,
    questions: [
      { id: 'diet', label: 'Dietary needs?', kind: 'choice', options: ['None', 'Vegan', 'Halal'] },
      { id: 'coc', label: 'I agree to the code of conduct', kind: 'agree', required: true },
      { id: 'bad', label: 'x', kind: 'nonsense' }
    ]
  })
  link(org, a)
  t.alike((await ev.info()).questions.map((q) => q.id), ['diet', 'coc'], 'invalid questions are dropped')
  const g = await join(ev, a, 'Ada', { answers: { diet: 'Vegan', coc: true } })
  const list = await eventually(async () => { const l = await ev.guests(); return l.length === 1 && l })
  t.alike(list[0].answers, { diet: 'Vegan', coc: true })
  const raw = (await g.view.get('guests/' + g.me)).value
  t.absent(JSON.stringify(raw).includes('Vegan'), 'answers are encrypted in the shared log')
})

test('events from a newer Pluma are not interpreted', async (t) => {
  const [org, a] = await devices(t, 2)
  const current = await org.createEvent(EVENT)
  t.is((await current.info()).rules, 2, 'new events are stamped with the current rules version')
  t.absent(await current.needsUpdate())

  const future = await org.createEvent(EVENT, { rules: 99 }) // as if made by a newer app
  link(org, a)
  const g = await a.openEvent(future.link)
  await eventually(() => g.info())
  t.ok(await g.needsUpdate(), 'older app knows it must update')
  await future.update({ title: 'Changed' })
  await t.exception(() => g.rsvp({ name: 'Ada' }), /Update Pluma/)
  await new Promise((r) => setTimeout(r, 1000))
  t.is((await future.info()).title, 'Demo', 'records are not applied under unknown rules')
  t.is((await future.guests()).length, 0)
})

test('.ics and CSV exports', (t) => {
  const ics = toICS({ title: 'Hack, night', start: EVENT.start, location: 'NUS; COM3', description: 'Bring\nlaptops' }, { link: 'pluma://event/ab', uid: 'ab' })
  t.ok(ics.includes('DTSTART:20261101T100000Z'))
  t.ok(ics.includes('DTEND:20261101T120000Z'), 'defaults to 2 hours')
  t.ok(ics.includes('SUMMARY:Hack\\, night'))
  t.ok(ics.includes('LOCATION:NUS\; COM3'))
  t.ok(ics.includes('\r\n'))

  const csv = toCSV(
    [{ id: 'g1', name: '=HYPERLINK("x")', email: 'a@b.c', status: 'approved', ticketType: 'ga', at: 0, answers: { diet: 'Vegan', coc: true } }],
    { questions: [{ id: 'diet', label: 'Diet' }, { id: 'coc', label: 'CoC' }], ticketTypes: [{ id: 'ga', name: 'General' }] },
    new Set(['g1'])
  )
  const [head, row] = csv.trim().split('\r\n')
  t.is(head, '"Name","Email","Status","Ticket","Checked in","Registered at","Diet","CoC"')
  t.ok(row.startsWith('"\'=HYPERLINK(""x"")"'), 'formulas are neutralised')
  t.ok(row.includes('"Vegan","yes"'))
})
