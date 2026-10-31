# Pluma — product spec (v1 / MVP)

Working name: **Pluma**. An event calendar and RSVP app for organisers, built on the Pear/Holepunch
peer-to-peer stack. No accounts, no central servers run by us, works offline.

Research input: `luma-feature-inventory.md` / `luma-features.json` (public-source inventory of Luma,
2026-10-31). This is a clean-room product: we take the user-facing ideas, not Luma's code, name,
branding, copy or assets.

> Naming note: "Pluma" is close to "Luma" in the same market. Do a trademark check before publishing
> anything under that name.

## 1. Principles

1. **First-time guest success beats everything.** A guest who has never heard of Pear must go from
   tapping a link to holding a ticket in under 60 seconds on a phone. (See `MOBILE.md`.)
2. **Never say "P2P", "keys", "hypercore" or "seeding" in the UI.** Talk about benefits: "no
   account", "works offline", "your guest list stays with you".
3. **The organiser owns the event.** Data lives on host and guest devices. Optional always-on helpers
   (relays) only store encrypted data they cannot read.
4. **Offline by default.** Tickets, check-in and reminders work with no connection.
5. **Private by default.** Anything not explicitly public is encrypted before it leaves a device.

## 2. Roles

| Role | Can do |
|---|---|
| Organiser (creator) | Everything; adds/removes hosts; owns the event's signing key |
| Co-host (manager) | Edit event, approve/decline, message guests, issue/revoke tickets |
| Check-in staff | Scan tickets and record check-ins only; optionally limited to ticket types |
| Guest | RSVP, answer questions, hold a ticket, cancel, see what the organiser allows |
| Relay (optional) | Keeps encrypted event data available when hosts are offline; cannot read it |

## 3. MVP scope

From the inventory's 40 MVP features, grouped. Each line is a requirement.

### 3.1 Events
- Create an event from the home screen in one step; it is live as soon as you tap Publish.
- Fields: title, start/end (stored UTC + IANA timezone), event type (in-person / online / hybrid),
  location text or online link, rich-text (Markdown) description, cover image.
- Times display in the viewer's timezone, with the event timezone shown when they differ.
- Visibility in MVP: **unlisted** (anyone with the link). Public discovery is post-MVP.
- Co-hosts with manager / non-manager roles; show or hide each host on the event page.
- Edit any field after publishing. Material changes (time, place, cancellation) notify guests.
- Cancel event: guests are notified and tickets marked void.
- Each event belongs to the organiser's personal calendar (a list of their events).

### 3.2 Registration and capacity
- RSVP form with name (required), optional email, custom questions (text, single/multi select,
  checkbox agreement).
- Multiple ticket types, each with a name, description, optional capacity and "requires approval".
- Event-level capacity and an "accepting registrations" toggle.
- **Holds during checkout:** when a guest starts registering for a capacity-limited ticket, a seat is
  held for them (default 10 minutes). Unfinished holds expire and release the seat.
- **Capacity reduction:** if the organiser lowers capacity below the number of issued tickets, nothing
  is cancelled automatically. The organiser sees "N over capacity" and picks individual tickets to
  cancel (most recent first is pre-selected). Each cancelled guest is notified. When payments arrive
  (post-MVP) cancellation triggers a refund for that ticket.
- Duplicate guard: one active registration per guest identity per event (multiple tickets per guest
  is post-MVP).
- Approve / decline, individually or in bulk, with an optional message.
- Guest can cancel ("Not going") at any time; their seat is released.

### 3.3 Guest list privacy (organiser's choice, per event)

| Mode | Who sees the guest list |
|---|---|
| `public` | All approved guests see all approved guests' display names and avatars |
| `selective` | Like `public`, but the organiser can hide individual guests |
| `private` | Only hosts see the guest list |

- Default for new events: `private`.
- The RSVP screen tells the guest, in one line, whether their name will be visible to other guests.
  (Required for informed consent; it does not change the organiser's control.)
- Hosts always see the full list, answers and contact details. Other guests never see answers or
  contact details in any mode.
- Changing the mode takes effect at the next sync. Names already seen by a guest's device cannot be
  unseen; the UI says so when switching from `public` to `private`.

### 3.4 Tickets and check-in (offline for both sides)
- Every approved registration gets a ticket stored on the guest's device; it shows with no connection.
- The ticket QR code is **dynamic**: it changes every 30 seconds and is signed by the guest's device,
  so a screenshot or forwarded image stops working within a minute.
- The check-in scanner works fully offline: it verifies the organiser's signature and the guest's
  signature locally.
- Several staff devices can scan at once. When they reconnect, check-ins merge; a ticket scanned on
  two devices is flagged as a duplicate for a host to review.
- Revoked or cancelled tickets are rejected by any scanner that has synced since the revocation. The
  scanner shows "last synced X min ago" so staff know how fresh its list is.
- Check-in is per ticket and can be undone by a host.

### 3.5 Updates and reminders
- Reminders 1 day and 1 hour before start, scheduled as **local notifications** on the guest's device
  at RSVP time (no push server needed). Re-scheduled when the event time changes and the device syncs.
- Organiser announcements ("blasts") to all guests or by status; delivered in-app on next sync.
- Add-to-calendar via a generated `.ics` file.
- Guest CSV export for hosts.

### 3.6 Identity and profiles
- No sign-up. A device identity is created silently on first launch.
- Profile: display name and optional photo, asked for at first RSVP, not before.
- Names and contact details are owned by the guest and shared only with the hosts of events they
  register for.
- Backup/recovery and multi-device are offered later (after the first ticket), never at onboarding.

## 4. Out of MVP (in order of likely priority)
1. Waitlist (needs the same capacity authority as holds; small step after MVP).
2. Always-on relay ("keep my event online") — see `ARCHITECTURE.md` §6. Needed early for
   phone-only organisers.
3. Multi-device and recovery for identities.
4. Payments (Stripe or crypto) and refunds — the only part that needs a third-party service.
5. Public events and discovery (curated directory feeds).
6. Themes, recurring events/cloning, feedback surveys, chat.
7. Email/SMS/push bridges (optional, operator-run, outside the zero-infra core).

## 5. Success metrics
- Link tap → ticket in hand, median, new guest on phone: **< 60 s** (install excluded), < 2.5 min
  including install.
- Install drop-off from the invite page: tracked locally on the page only via no-backend analytics, or
  not at all; measure in usability sessions instead.
- First-event organiser: create → share link in **< 2 min**.
- Check-in: scan to green tick in **< 1 s** offline.

## 6. Milestones
| # | Deliverable | Done when |
|---|---|---|
| M0 | Repo scaffold, shared `core` package, test harness | `npm test` runs core tests under Node and Bare |
| M1 | Create event + guest RSVP + host sees guest list (desktop Pear app + CLI) | Two machines, one link, RSVP appears on host within seconds |
| M2 | Tickets + offline dynamic-QR check-in, multi-scanner merge | Scan works in airplane mode; duplicate across 2 scanners flagged on reconnect |
| M3 | Mobile app shell (React Native + Bare) with guest onboarding flow | New-user usability test: 5/5 testers RSVP unaided |
| M4 | Capacity, holds, approvals, privacy modes, capacity-reduction flow | Property tests: no oversell under concurrent registrations |
| M5 | Reminders, blasts, `.ics`, CSV, cancel/edit notifications | MVP feature list complete |
