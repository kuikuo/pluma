# Pluma

Event invites, RSVPs and offline check-in with no accounts and no servers, built on Pear/Holepunch.
See `SPEC.md`, `ARCHITECTURE.md` and `MOBILE.md`.

```
packages/core   shared P2P logic (runs on Node, Bare and in the Android app)
apps/cli        command-line demo
apps/mobile     Android app (Expo + React Native + Bare worklet)
```

## Core tests

```sh
npm install
npm test                                   # Node
cd packages/core && npm run test:bare      # Bare (the phone runtime)
```

## CLI demo (two terminals or two machines)

```sh
node apps/cli --store ./alice     # > create HackNight 50      (prints a pluma://event/... link)
node apps/cli --store ./bob       # > open <link>   > rsvp Bob   > status   > qr
# back in alice:                    > guests   > scan <code from bob's qr>
```

Type `help` in the CLI for all commands (approvals, privacy modes, co-hosts, scanners, blasts).

## Android APK

Needs JDK 17 and the Android SDK (installed here under `~/Android`).

```sh
export JAVA_HOME=~/Android/jdk17 ANDROID_HOME=~/Android/sdk PATH=~/Android/jdk17/bin:$PATH
cd apps/mobile
npm install
npm run bundle             # bundle packages/core into the Bare worklet
npm run link:android       # copy its native libraries into the app
npx expo prebuild --platform android --no-install    # first time only
cd android && ./gradlew assembleRelease
# APK: apps/mobile/android/app/build/outputs/apk/release/app-release.apk
```

Install on a phone with `adb install app-release.apk`, or send the file and open it (allow
"install unknown apps"). The release build is signed with the debug key, which is fine for a
hackathon but not for the Play Store.

Re-run `npm run bundle` after any change in `packages/core` or `apps/mobile/backend`.
