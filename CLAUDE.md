# Pluma — notes for Claude

P2P event/RSVP app on Pear/Holepunch. Read before working:
- `SPEC.md` — what we build (MVP scope, decisions, milestones)
- `ARCHITECTURE.md` — data structures, permissions, crypto, check-in
- `MOBILE.md` — mobile app and first-time UX
- `luma-feature-inventory.md` — research input only (public sources); clean-room, never copy Luma
  code, copy text, branding or assets

## Rules
- All business rules (permissions, capacity, holds, ticket validity) live in `packages/core`, which
  must run under Pear, Bare and Node. No UI or platform APIs in core.
- Holepunch APIs change: before using a module (autobase, corestore, hyperswarm, hyperbee,
  hyperblobs, protomux, blind-pairing, blind-peer, react-native-bare-kit), read its current README /
  source in `node_modules` or on GitHub. Don't code from memory.
- Tests use `brittle`. Multi-peer tests use an in-process DHT testnet, never the public network.
- Any change to the event-base apply function needs tests for permissions and capacity.
- UI copy follows the language guide in `MOBILE.md` §5: no P2P jargon.
- Personal data (answers, contact details, guest lists) is encrypted before leaving a device.
- Work milestone by milestone (`SPEC.md` §6); keep `SPEC.md`/`ARCHITECTURE.md` updated when a
  decision changes.
