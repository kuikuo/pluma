#!/usr/bin/env node
// Dev/demo CLI. Usage: node apps/cli --store ./alice [--offline]
const readline = require('readline')
const { Pluma } = require('@pluma/core')

const args = process.argv.slice(2)
const storage = args.includes('--store') ? args[args.indexOf('--store') + 1] : './pluma.storage'
const offline = args.includes('--offline') // no networking: simulates a device without signal

const HELP = `
  create <title> [capacity] [approval]   create an event (approval = "yes" to require it)
  open <link>                            open an event link
  info                                   show the current event
  rsvp <name> [email]                    register for the current event
  status                                 my registration and ticket
  qr                                     show my ticket code (valid ~2 minutes)
  guests                                 full guest list (hosts)
  approve <guestId> | decline <guestId>  decide on a guest (prefix of id is enough)
  mode <public|selective|private>        guest list visibility
  hide <guestId>                         hide a guest in selective mode
  roster                                 names visible to guests
  joinreq                                print my co-host/scanner join request
  cohost <key> <boxKey> | scanner <key>  add a co-host or scanner (organiser)
  scan <code>                            check in a ticket code (works offline)
  dupes                                  duplicate scans
  blast <message>                        message approved guests
  updates                                messages from the hosts
  events                                 my events
  quit`

async function main() {
  const pluma = new Pluma(storage, { swarm: !offline })
  await pluma.ready()
  let ev = null
  console.log(`Pluma CLI — storage ${storage}${offline ? ' (OFFLINE)' : ''}. Type "help".`)

  const use = (e) => {
    ev = e
    ev.on('update', () => {})
  }
  const need = () => { if (!ev) throw new Error('No event open: create or open one first') }
  const findGuest = async (prefix) => {
    const g = (await ev.guests()).find((x) => x.id.startsWith(prefix))
    if (!g) throw new Error('No guest with id ' + prefix)
    return g.id
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: '> ' })
  rl.prompt()
  for await (const line of rl) {
    const [cmd, ...rest] = line.trim().split(/\s+/)
    try {
      switch (cmd) {
        case '': break
        case 'help': console.log(HELP); break
        case 'create': {
          const [title, cap, approval] = rest
          use(await pluma.createEvent({
            title: title || 'Untitled',
            start: new Date(Date.now() + 86400000).toISOString(),
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
            capacity: cap ? Number(cap) : null,
            requireApproval: approval === 'yes'
          }))
          console.log('Created. Share this link:\n' + ev.link)
          break
        }
        case 'open': use(await pluma.openEvent(rest[0])); console.log('Opened; syncing…'); break
        case 'info': need(); console.log(await ev.info(), 'my role:', await ev.role()); break
        case 'rsvp': need(); await ev.rsvp({ name: rest[0], email: rest[1] || null }); console.log('Requested.'); break
        case 'status': need(); { const s = await ev.myStatus(); console.log(s.status, s.message || '', s.ticket ? '(ticket ready — type qr)' : '') } break
        case 'qr': need(); console.log((await ev.ticketQR()) || 'No ticket yet'); break
        case 'guests': need(); for (const g of await ev.guests()) console.log(g.id.slice(0, 8), g.status.padEnd(9), g.hidden ? 'hidden' : '      ', g.name, g.email || ''); break
        case 'approve': need(); await ev.approve(await findGuest(rest[0])); console.log('Approved.'); break
        case 'decline': need(); await ev.decline(await findGuest(rest[0]), rest.slice(1).join(' ') || undefined); console.log('Declined.'); break
        case 'mode': need(); await ev.setGuestListMode(rest[0]); console.log('Guest list:', rest[0]); break
        case 'hide': need(); await ev.hideGuest(await findGuest(rest[0])); console.log('Hidden.'); break
        case 'roster': need(); console.log((await ev.roster()).map((r) => r.name).join(', ') || '(none visible)'); break
        case 'joinreq': need(); { const j = ev.joinRequest; console.log(`cohost ${j.key} ${j.boxKey}\nscanner ${j.key}`) } break
        case 'cohost': need(); await ev.addCohost({ key: rest[0], boxKey: rest[1] }); console.log('Co-host added.'); break
        case 'scanner': need(); await ev.addScanner({ key: rest[0] }); console.log('Scanner added.'); break
        case 'scan': need(); { const r = await ev.scan(rest[0]); console.log(r.ok ? `✅ ${r.name || 'Valid ticket'}` : `❌ ${r.reason}${r.name ? ' — ' + r.name : ''}`) } break
        case 'dupes': need(); console.log(await ev.duplicateScans()); break
        case 'blast': need(); await ev.blast(rest.join(' ')); console.log('Sent.'); break
        case 'updates': need(); { const b = await ev.blasts(); console.log(b.map((x) => '• ' + x.body).join('\n') || '(no updates)') } break
        case 'events': console.log((await pluma.myEvents()).join('\n') || '(none)'); break
        case 'quit': case 'exit': rl.close(); break
        default: console.log('Unknown command. Type "help".')
      }
    } catch (err) {
      console.log('Error:', err.message)
    }
    rl.prompt()
  }
  await pluma.close()
  process.exit(0)
}

main()
