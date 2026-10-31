# Pluma

**Event invites, RSVPs and check-in with no accounts, no servers and no fees.**
A clean-room, open-source rebuild of [Luma](https://luma.com)'s core organiser features on a
peer-to-peer network ([Pear/Holepunch](https://github.com/holepunchto)). The organiser's phone *is*
the server; guests' phones help share the event; tickets and check-in work offline.

Apache-2.0 licensed. Built at Autonomous SG 2026 (NUS Hackers track).

---

## The target: Luma

Luma is the default RSVP and ticketing tool for tech meetups, hackathons and community events.

### What it costs today (seen 2026-10-31)

| | Price | Source |
|---|---|---|
| Free plan | **5% platform fee on paid tickets**, plus Stripe's 2.9% + 30¢ | [luma.com/pricing](https://luma.com/pricing) |
| Luma Plus | **$59/month, billed annually** (no monthly price published) | [luma.com/pricing](https://luma.com/pricing) |
| Extra admin seats | **$12/month** ($9 billed annually) each, beyond 5 | [help.luma.com/p/luma-plus](https://help.luma.com/p/luma-plus) |
| Extra email sends | **$50/month (10k) up to $800/month (100k)** | [luma.com/pricing](https://luma.com/pricing) |

Behind the Plus paywall ([source](https://luma.com/pricing)): the check-in manager role, Zapier/API
access, custom event URLs, separate first/last name fields, tax collection, 10× more invite sends.
Pluma gives every one of the first four away (check-in staff role, an open-source library instead of a
paid API, your own link, any registration fields you want).

### How many people use it

- **4.9★ from 20,000 ratings** on the iOS App Store, #84 in Lifestyle
  ([App Store](https://apps.apple.com/us/app/luma-events-invites/id1546150895), seen 2026-10-31).
- At its **$3M seed round (Dec 2020)**: **10,000+ hosts** whose events had drawn **500,000+ attendees**
  ([Crunchbase News](https://news.crunchbase.com/startups/exclusive-luma-raises-3m-to-enable-business-growth-on-top-of-zoom/)).
- We could not find a newer primary source for user counts, so we don't quote one.

### Before vs after, per organiser per month

Worked example (ours): one organiser selling 100 tickets at $20 = $2,000/month in ticket sales.

| Platform | Subscription | Platform fee | Card processing | **Total / month** |
|---|---|---|---|---|
| Luma Free | $0 | [5%](https://luma.com/pricing) = $100 | [2.9% + 30¢](https://luma.com/pricing) = $88 | **$188** |
| Luma Plus | [$59](https://luma.com/pricing) | [0%](https://help.luma.com/p/luma-plus) | $88 | **$147** |
| Eventbrite | $0 | [3.7% + $1.79/ticket](https://www.eventbrite.com/organizer/pricing/) = $253 | [2.9%](https://www.eventbrite.com/organizer/pricing/) = $58 | **$311** |
| **Pluma** | **$0** | **$0** | not built yet (see Limits) | **$0** |

For **free events** (most meetups) Luma Free costs $0 too, but locks the check-in staff role, API and
custom URLs behind **$59/month**; Pluma includes them at $0.

Running costs for Pluma: **$0**. There are no servers to pay for: devices find each other through
HyperDHT's public bootstrap nodes, ["publicly served on behalf of the commons"](https://github.com/holepunchto/hyperdht#readme).
Optional: an always-on helper (any cheap VPS, e.g. [Hetzner CX23 at €5.99/month](https://www.hetzner.com/cloud/cost-optimized))
can run the CLI as a co-host so events stay reachable when every organiser phone is off.

---

## What we uncovered

We mapped Luma from **public sources only**: its help centre, pricing pages, public API docs,
changelog, public event pages and reviews. No login bypass, no private APIs, no scraping of other
people's data. Full results: [`luma-feature-inventory.md`](luma-feature-inventory.md) and
[`luma-features.json`](luma-features.json):

- **261 distinct features**, each with its source URL, checked by a second pass (207 confirmed as
  written, 43 corrected, 11 added, 30 claims left unverified and listed).
- **The data model** behind them (from Luma's public OpenAPI docs): events, calendars, hosts with
  roles, ticket types, registration questions, guests with approval states, per-ticket check-in keys,
  blasts, and coupons.
- **Which features need a central server and which don't.** 167 of the 261 work peer-to-peer with no
  infrastructure, 26 need an always-on helper, and 52 genuinely need a server (email/SMS, card
  payments, search and discovery pages).
- **Luma's architecture puts everything on its servers**: event pages, guest lists, answers and
  check-in all live on Luma, and its check-in scanner needs a connection for organisers. That is the
  lock-in we remove.

## What we built

| Luma feature | Pluma |
|---|---|
| Create, edit and cancel events; co-hosts | ✅ the organiser's phone holds the event; co-hosts are added by scanning a QR code |
| Invite links and pages | ✅ static invite page with an event preview packed into the link (no server sees it) |
| RSVP, approval, capacity | ✅ never oversells, even with several hosts approving at once |
| Waitlist | ✅ seats freed by cancellations or a capacity increase go to the next in line automatically |
| Ticket types | ✅ per-type capacity and approval (e.g. General, Speaker) |
| Registration questions | ✅ text, multiple choice and agree-to-terms; **answers are end-to-end encrypted to hosts** |
| Guest list visibility | ✅ only hosts / hosts pick / all guests |
| QR tickets and check-in | ✅ **better than Luma: both the guest's ticket and the door scanner work offline** |
| Check-in staff role (Plus only on Luma) | ✅ free; staff see who's valid but not guests' emails or answers |
| Blasts to guests | ✅ messages arrive in-app |
| Reminders | ✅ notifications 1 day and 1 hour before, scheduled on the guest's own phone (no push server) |
| Add to calendar, CSV export | ✅ `.ics` file and spreadsheet-safe CSV |

**Things Luma can't do:**
- **Screenshot-proof tickets.** The QR code changes every 30 seconds and is signed by the guest's
  phone, so a forwarded image stops working within 2 minutes.
- **Offline doors that reconcile.** Several door phones can scan with no signal; when they reconnect
  their check-ins merge, and anyone scanned at two doors is flagged by name.
- **Nothing to sign up for**, and no company that can see your guest list.

### How we know it works

- **18 automated tests**, run on both Node and Bare (the phone runtime). They cover: no overselling
  under concurrent sign-ups, approvals, waitlist order, ticket types, privacy modes, a co-host
  confirming guests while the organiser is offline, offline scanners merging with duplicate
  detection, guests being unable to perform host actions, events from newer app versions not being
  misread, encrypted answers, and the exports.
- **Tested on a real Android 16 phone over mobile data**, with test devices on a laptop: the phone
  created an event, approved guests, sent messages, cancelled tickets over capacity, added a door
  helper by QR, scanned tickets with the camera (including in airplane mode), and flagged a ticket
  scanned at two doors after they reconnected.

## How it works (short version)

Each event is an [Autobase](https://github.com/holepunchto/autobase): a shared log that every device
replays through the same rules (`packages/core/lib/apply.js`), so all devices agree on who's going
without a server. Guests append signed RSVPs; only hosts can approve, issue tickets or change the
event. Tickets are signed by an event key held by hosts, so any phone can verify them offline.
Details: [`ARCHITECTURE.md`](ARCHITECTURE.md), product spec: [`SPEC.md`](SPEC.md), first-time
experience: [`MOBILE.md`](MOBILE.md).

```
packages/core     shared logic (Node, Bare and the Android app), tests
apps/mobile       Android app (Expo + React Native + Bare worklet)
apps/invite-page  static invite page (GitHub Pages)
apps/cli          command-line app, handy as a second device or an always-on co-host
```

## Run it

### Tests

```sh
npm install
npm test                                   # Node
cd packages/core && npm run test:bare      # Bare (the phone runtime)
```

### CLI (two terminals or two machines)

```sh
node apps/cli --store ./alice     # > create HackNight 50      (prints a pluma://event/... link)
node apps/cli --store ./bob       # > open <link>   > rsvp Bob   > status   > qr
# back in alice:                    > guests   > scan <code from bob's qr>
```

Type `help` in the CLI for all commands (approvals, privacy modes, co-hosts, scanners, blasts).
Add `--offline` to run a device with no networking, e.g. to simulate a door with no signal.

### Android APK

Needs JDK 17 and the Android SDK.

```sh
export JAVA_HOME=/path/to/jdk17 ANDROID_HOME=/path/to/android/sdk
cd apps/mobile
npm install
npm run bundle             # bundle packages/core into the Bare worklet
npm run link:android       # copy its native libraries into the app
npx expo prebuild --platform android --no-install
cd android && ./gradlew assembleRelease
# APK: apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

Install with `adb install app-release.apk`, or send the file to a phone and open it.

### Invite page

`apps/invite-page` is plain static files; publish it with GitHub Pages. Set `INVITE_BASE` in
`apps/mobile/app/App.js` to its URL.

## Limits (honest list)

- **Someone has to be online.** An event is reachable while any host, co-host or guest who has it has
  the app open. Phones sleep, so for big events add a co-host or run the CLI on an always-on machine.
  The "Keep sharing" switch only keeps the organiser's screen on; a true background service is future
  work.
- **No card payments yet.** Free events only; paid tickets would need Stripe (the one part that
  needs a third party).
- **Android only** for the app; iOS needs the same code built with Xcode.
- The event preview in invite links is not signed yet, so a forged link could show a wrong preview
  (the app always loads the real event).
- Reminders and updates arrive when the guest's phone syncs; there are no email or SMS messages.

## Licence

[Apache-2.0](LICENSE). Every dependency is under a compatible licence (Apache-2.0, MIT, ISC, BSD,
BlueOak, MPL-2.0 for an unmodified build tool, CC-BY-4.0 for build-time browser data). See
[`NOTICE`](NOTICE).

Luma is a trademark of its owner. Pluma is an independent clean-room project, not affiliated with
Luma; no Luma code, copy or assets are included.
