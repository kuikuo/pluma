# Pluma — architecture

Companion to `SPEC.md`. Holepunch module APIs change; check each module's current README before
coding against it (see `CLAUDE.md`).

## 1. Layers

```
┌──────────────────────────┐  ┌──────────────────────────────┐
│ Desktop UI (Pear app)     │  │ Mobile UI (React Native/Expo) │
└─────────────┬────────────┘  └──────────────┬───────────────┘
              │ RPC                            │ RPC (bare-kit IPC)
┌─────────────▼────────────────────────────────▼───────────────┐
│ packages/core  — runs in Pear (desktop), Bare (mobile worklet),│
│ and Node (tests). No UI code, no platform APIs.                 │
│  identity · events · registrations · tickets · checkin · sync   │
└─────────────┬───────────────────────────────────────────────────┘
              │
   Corestore · Hypercore · Autobase · Hyperbee · Hyperblobs/Hyperdrive
   Hyperswarm (DHT + holepunching) · Protomux · sodium-universal
```

- One core, two shells. Every rule (capacity, permissions, ticket validity) lives in `core` so desktop
  and mobile can't disagree.
- UI ↔ core talk over a small typed RPC (same message schema on desktop and mobile).

## 2. Identity

- Per device: an Ed25519 signing keypair (`identityKey`) and an X25519 encryption keypair, created on
  first launch, stored in the platform keystore where available (iOS Keychain / Android Keystore,
  wrapped key on desktop).
- Per event, guests use a **derived per-event key** (`HKDF(identitySecret, eventKey)`), so different
  organisers cannot link the same guest across events.
- Profile (name, avatar) is just data the guest chooses to send with an RSVP.
- Post-MVP: multi-device via a personal Autobase and blind pairing; recovery phrase.

## 3. Event data structure

### 3.1 Cores
| Structure | Writers | Readers | Contents |
|---|---|---|---|
| **Event base** (Autobase → Hyperbee view) | Organiser + co-hosts; scanner devices with restricted rights | Anyone with the event link | Public event doc, ticket types, form schema, host list, hold/ticket/revocation/check-in records (personal data encrypted, see §4) |
| **Guest feed** (one Hypercore per guest per event) | That guest | Hosts (data sealed to hosts) | RSVP request, answers, cancel, profile updates |
| **Media** (Hyperblobs) | Hosts | Anyone with link | Cover image, host avatars |

Guests are **not** writers of the event base; that prevents spam and lets hosts be the single
authority for capacity. (As built, the "guest feed" is the guest's optimistic writer core; see §3.2.)

### 3.2 Discovery and connection
- Event link = event base key (32 bytes) + a tiny signed preview snapshot (see `MOBILE.md` §3).
- Everyone interested in an event joins the Hyperswarm topic `hash("pluma:event:" + eventKey)`.
- **As built:** guests don't get a separate feed. They append RSVP/cancel records to the event base
  as Autobase *optimistic* blocks (allowed from non-writers); the apply function validates them and
  acks the writer. Peers learn about guest cores through Autobase's wakeup protocol, which must be
  attached to every replication stream (`Pluma` shares one `ProtomuxWakeup` across events).
- Optimistic blocks are not causally referenced by host records, so a host's `decide` or
  `ticket.issue` can be linearised *before* the RSVP it answers. Apply therefore parks such records
  (`parked/decision/*`, `parked/ticket/*`) and applies them when the RSVP lands. Every rule touching
  guests must stay order-independent in this way.
- Any peer holding the event base re-shares it, so guests help keep the event page reachable.

### 3.3 Records in the event base (apply function enforces permissions)
```
event.update      { fields... }                          writer: manager
host.add/remove   { hostKey, role, visible }             writer: organiser
tickettype.upsert { id, name, desc, capacity, approval } writer: manager
guestlist.mode    { public | selective | private }       writer: manager
guest.visibility  { guestRef, hidden }                    writer: manager
hold.create       { holdId, guestRef, ticketTypeId, expiresAt }  writer: manager (indexer)
reg.decision      { guestRef, status: approved|declined|pending, msg? }  writer: manager
ticket.issue      { ticket (signed, see §5) }             writer: manager (indexer)
ticket.revoke     { ticketId, reason }                    writer: manager
checkin.record    { ticketId, scannerKey, at }            writer: scanner or manager
checkin.undo      { ticketId }                            writer: manager
blast.post        { audience, body (encrypted) }          writer: manager
```
`guestRef` is an opaque per-event identifier, not the guest's key in plaintext.

### 3.4 Capacity, holds and ordering
- The **indexer** (the organiser's device or a co-host's, whichever is online; later a relay) reads
  guest feeds in arrival order and writes `hold.create` / `ticket.issue` to the base.
- Capacity check happens inside the apply function against the linearised view: issued tickets +
  unexpired holds ≤ capacity. Because only managers write holds and tickets, and Autobase gives one
  agreed order, two managers issuing concurrently cannot both win the last seat: the later record is
  rejected by apply and the guest gets "sold out" or "waitlist" on next sync.
- Hold expiry is checked against the hold record's `expiresAt` (host clock). Expired holds are ignored
  by the capacity count; no cleanup write needed.
- If no host is online, a guest's RSVP sits in their own feed as "Requested — the organiser will
  confirm" and is processed when a host or relay comes online.
- Capacity reduction never auto-cancels; the UI computes overflow and the host writes
  `ticket.revoke` for each ticket they choose.

## 4. Privacy and encryption

| Data | Encrypted to | Notes |
|---|---|---|
| Guest's RSVP, answers, email | Event host key (sealed box) | Written in guest feed; only hosts can open |
| Full guest list, contact details | Host group key | Shared among hosts via sealed copies |
| Visible guest list (`public` / `selective`) | Approved-guest group key | Hosts publish a roster containing only visible guests |
| Location / meeting link (when "guests only") | Approved-guest group key | |
| Blasts | Approved-guest group key, or host key per-audience | |

- Group keys are symmetric (XChaCha20-Poly1305), distributed by writing a copy sealed to each
  recipient's per-event X25519 key.
- Removing a guest or switching to `private` rotates the approved-guest key; new data uses the new
  key. Old data already on devices can't be clawed back; the UI warns about this.
- `private` mode: the visible roster is simply not published.

## 5. Tickets and offline check-in

### 5.1 Ticket (issued by host, stored on guest device)
```
ticket = { v:1, eventKey, ticketId, ticketTypeId, holderKey (per-event pubkey), issuedAt }
ticketSig = sign(eventTicketKey, ticket)
```
`eventTicketKey` is a dedicated signing keypair for the event; its public key is in the event doc and
its secret is shared among managers (sealed copies).

### 5.2 Dynamic QR (shown by guest device)
```
qr = encode({ ticket, ticketSig, t: floor(now/30s), holderSig: sign(holderSecret, ticketId || t) })
```
About 250 bytes binary — fits a QR code at medium error correction.

### 5.3 Scanner verification (fully offline)
1. `ticketSig` valid under the event's ticket public key.
2. `holderSig` valid under `ticket.holderKey`, and `t` within ±4 windows (±2 min clock drift).
3. `ticketId` not in local revocation set.
4. `ticketId` not already checked in locally.
→ green; write `checkin.record`.

A screenshot fails step 2 after ~2 minutes; a forwarded ticket can't produce new `holderSig`s without
the guest's device secret.

### 5.4 Multi-scanner merge
- Each scanner device is an Autobase writer with check-in rights only.
- Scanners sync with each other and hosts whenever any connection exists.
- On merge, if one `ticketId` has check-ins from different scanners, the view marks it
  `duplicate` and hosts get an alert. The first check-in in Autobase order is canonical.
- Scanner UI shows "last synced N min ago"; before doors open the host is prompted to sync all
  scanners.

## 6. Availability (the honest part)

Data is reachable while at least one peer holding it is online. Peers can be:
1. Host devices (desktop app left running is the best case).
2. Guest devices — every guest re-shares the public event base while their app is open.
3. **Relay (post-MVP, high priority):** an always-on node that stores and serves encrypted cores
   without being able to read them (Holepunch "blind peer" pattern). Run by the organiser (home PC,
   cheap VPS) or offered as an optional paid service.

Phones are poor always-on peers: iOS and Android suspend background networking. Phone-only organisers
therefore need either a relay or a co-host with a desktop for registrations to be confirmed promptly.
The organiser UI shows reachability ("Your event is reachable via 3 devices") and offers "Keep my
event online" when it's at risk.

Holds and capacity need a live indexer; with no host/relay online, guests get "Requested" instead of
an instant ticket.

## 7. Notifications without servers
- Reminders: local notifications scheduled at RSVP; updated on sync.
- Updates (time change, cancel, blasts): seen on next sync; mobile background fetch syncs
  opportunistically.
- Optional later: a push bridge (APNs/FCM) that only receives "something changed for topic X" pings,
  no content.

## 8. Repo layout (planned)
```
pluma-claude/
  SPEC.md  ARCHITECTURE.md  MOBILE.md  CLAUDE.md
  luma-feature-inventory.md  luma-features.json     # research input
  packages/
    core/        # shared P2P logic (Bare/Node/Pear compatible), brittle tests
    schema/      # record encodings (compact-encoding), RPC messages
  apps/
    desktop/     # Pear app
    mobile/      # React Native + react-native-bare-kit worklet bundling core
    invite-page/ # static invite/landing page (no backend), see MOBILE.md
    cli/         # dev/test CLI: create event, rsvp, scan
```

## 9. Testing
- Unit and property tests for the apply function (permissions, capacity, holds, revocation).
- Multi-peer integration tests with an in-process testnet (`hyperdht/testnet`), no real network.
- Simulated offline scanners: partition, scan, heal, assert duplicate detection.
- Mobile: usability sessions with people who have never used Pear (M3 gate).

## 10. Open questions to verify before coding
- Current Autobase API (apply/view/ack semantics, writer add/remove) and its handling of restricted
  writers — permissions may need to be enforced purely in apply.
- `react-native-bare-kit` maturity on iOS and Android, worklet bundle size, background limits.
- Whether to use Pear's built-in app distribution for desktop updates (`pear stage` / `release`).
- Blind-peer module availability and API for the relay.
