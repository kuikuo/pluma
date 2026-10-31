// Calendar (.ics) and guest list (CSV) exports. Pure functions, no I/O.

function icsDate(iso) {
  return new Date(iso).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}

function icsText(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n')
}

function toICS(event, { link, uid }) {
  const start = event.start
  const end = event.end || new Date(new Date(start).getTime() + 2 * 3600_000).toISOString()
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Pluma//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}@pluma`,
    `DTSTAMP:${icsDate(new Date().toISOString())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${icsText(event.title)}`,
    event.location ? `LOCATION:${icsText(event.location)}` : null,
    `DESCRIPTION:${icsText([event.description, link ? 'Open in Pluma: ' + link : ''].filter(Boolean).join('\n\n'))}`,
    event.cancelled ? 'STATUS:CANCELLED' : 'STATUS:CONFIRMED',
    'BEGIN:VALARM',
    'TRIGGER:-PT1H',
    'ACTION:DISPLAY',
    `DESCRIPTION:${icsText(event.title)} starts in 1 hour`,
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR'
  ].filter(Boolean)
  return lines.join('\r\n') + '\r\n'
}

function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v)
  // Neutralise spreadsheet formulas and quote everything.
  const safe = /^[=+\-@]/.test(s) ? "'" + s : s
  return '"' + safe.replace(/"/g, '""') + '"'
}

function toCSV(guests, event, checkins = new Set()) {
  const questions = event.questions || []
  const types = new Map((event.ticketTypes || []).map((t) => [t.id, t.name]))
  const header = ['Name', 'Email', 'Status', 'Ticket', 'Checked in', 'Registered at', ...questions.map((q) => q.label)]
  const rows = guests.map((g) => [
    g.name, g.email, g.status, types.get(g.ticketType) || 'General', checkins.has(g.id) ? 'yes' : 'no',
    g.at ? new Date(g.at).toISOString() : '',
    ...questions.map((q) => {
      const a = g.answers ? g.answers[q.id] : undefined
      return Array.isArray(a) ? a.join('; ') : a === true ? 'yes' : a === false ? 'no' : a
    })
  ])
  return [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
}

module.exports = { toICS, toCSV }
