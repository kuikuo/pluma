# Pluma — mobile and first-time experience

Most guests will meet Pluma on a phone, from a link in a group chat, without knowing what Pear is.
This document designs that moment.

## 1. Constraints we design around
- **Phones can't open `pear://` links.** Pear's runtime is desktop-only, so mobile needs a native app
  (React Native + `react-native-bare-kit`, running `packages/core` in a Bare worklet — the approach
  Keet uses).
- **Browsers can't join the P2P network directly** (no UDP holepunching), so a pure web view of live
  event data would need a gateway server. We avoid that in MVP.
- **Phones sleep.** Background networking is suspended, so a phone is a poor host (see
  `ARCHITECTURE.md` §6).
- **Installing an app is the biggest drop-off point.** Every step around it must be fast and obvious.

## 2. Guest journey (target: link tap → ticket in < 60 s, plus install)

```
1. Tap link in WhatsApp/iMessage   →  https://pluma.<domain>/e#<event-key>.<preview>
2. Static invite page (no backend)  →  shows event preview, "Get your ticket"
3a. App installed  → opens straight into the event (universal/app link)
3b. Not installed  → App Store / Play Store; link is copied to clipboard
4. App first launch → picks up the invite (clipboard paste prompt or "Scan / paste invite")
5. Event screen     → [ I'm going ]
6. One sheet        → name (+ optional photo), the organiser's questions,
                      one line on guest-list visibility
7. Done             → ticket on screen, "Saved on this phone — works offline",
                      reminders scheduled, [Add to calendar]
```

Rules for this flow:
- **No account, no email verification, no password, no permission prompts before step 7.**
  Notification permission is asked *after* the ticket appears, framed as "Remind me before the event".
- The event screen loads from the preview in the link instantly; live data fills in once peers are
  found. If no peer is reachable, the guest can still RSVP; it shows "Requested — confirming with the
  organiser" and completes later.
- Never block on the network with a spinner and no explanation. Say what's happening in plain words:
  "Finding the organiser… you can close the app; we'll finish in the background."
- Backup / recovery is offered later ("Keep your tickets if you lose this phone"), after the first
  event or the second ticket, not during onboarding.

## 3. The invite link and page (zero backend)
- Link format: `https://pluma.<domain>/e#<eventKey>.<signedPreview>`.
  Everything after `#` is never sent to the web server, so the page host learns nothing.
- `signedPreview` = compressed {title, start, timezone, area/venue name, host display name, cover
  thumbnail hash} signed by the event's key. The page renders it with no server call and the app
  shows it before sync. It may be stale; the app replaces it with live data.
- The page is static files (GitHub Pages, Cloudflare Pages, IPFS — any free host) plus the
  `apple-app-site-association` and `assetlinks.json` files for universal/app links. This is the only
  web presence, and it is optional for desktop users (`pear://` works there).
- Page content: preview card, "Get your ticket" (opens app or store), "On a computer? Open in Pear",
  a QR code of the same link for cross-device, and a two-line "Why an app?" — "No account. Your
  ticket works offline. Your details go only to the organiser."

## 4. Organiser on a phone
Goal: create → share in under 2 minutes.

1. Open app → [Create event] → title, date/time, place or link, optional cover → **Publish**.
2. Share sheet opens immediately with the invite link (and a QR poster).
3. Event dashboard: guest list, approvals, capacity, and a **reachability indicator**:
   - 🟢 "Reachable — your event is being shared by 4 devices"
   - 🟡 "Only this phone is sharing. Keep Pluma open, add a co-host, or turn on Keep online."
4. Check-in: [Scan tickets] works in airplane mode; staff phones are added by scanning a one-time
   staff QR shown on the organiser's phone.

Phone-only organisers are the hardest case. Until the relay exists (post-MVP), the app should
recommend, at the moment it matters (first RSVP waiting), one of: keep Pluma open, add a co-host,
or install the desktop app on a computer that stays on.

## 5. Language guide
| Don't say | Say |
|---|---|
| Peer-to-peer, P2P, Pear, Hypercore | (nothing) / "works without our servers" if asked |
| Seeding, peers online | "Your event is being shared by N devices" |
| Keypair, identity key | (nothing) / "this phone" |
| Recovery phrase | "Backup code to keep your tickets if you lose this phone" |
| Sync failed | "Couldn't reach the organiser yet — we'll keep trying" |
| Encrypted | "Only the organiser can see your answers" |

## 6. Technical notes for the mobile app
- Expo / React Native UI; `react-native-bare-kit` runs a Bare worklet bundle of `packages/core`.
  UI ↔ worklet over the same RPC schema as desktop.
- Storage: Corestore in app-private storage; identity secrets in Keychain / Keystore.
- Background: use platform background fetch to sync opportunistically; never rely on it.
- Local notifications for reminders (scheduled at RSVP, rescheduled on sync).
- Camera-based QR scanner for check-in; ticket QR rendered locally, refreshed every 30 s, screen
  brightness raised while shown.
- Wallet passes (Apple/Google) need a signing server, so they're post-MVP.
- Android: Play Store primary; a sideload APK can be offered for privacy-minded users.

## 7. How we'll test first-time ease of use (M3 gate)
- 5+ people who have never used Pear, each given only a WhatsApp link on their own phone.
- Measure: time to ticket, where they hesitate, whether they understand "works offline".
- Pass: 5/5 complete unaided; median < 60 s after install.
- Repeat for organisers: create and share an event with no instructions.
