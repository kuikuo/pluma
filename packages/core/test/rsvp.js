const test = require('brittle')
const { network, eventually } = require('./helpers')

test('organiser creates, guest RSVPs over the network, host sees details', async (t) => {
  const [org, guest] = await network(t, 2)
  const ev = await org.createEvent({ title: 'Hack night', start: '2026-11-01T18:00:00Z', timezone: 'Europe/London' }, { name: 'Kui' })

  const gev = await guest.openEvent(ev.link)
  const info = await eventually(() => gev.info())
  t.is(info.title, 'Hack night')

  await gev.rsvp({ name: 'Ada', email: 'ada@example.com', answers: { diet: 'vegan' } })

  const list = await eventually(async () => { const l = await ev.guests(); return l.length === 1 && l })
  t.is(list[0].name, 'Ada')
  t.is(list[0].email, 'ada@example.com')
  t.is(list[0].status, 'approved')

  const mine = await eventually(async () => { const s = await gev.myStatus(); return s.ticket && s })
  t.is(mine.status, 'approved')
  t.ok(await gev.ticketQR(), 'guest can show a QR')
})
