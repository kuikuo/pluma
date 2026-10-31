# Pluma invite page

Static, zero-backend page that guests see when they tap a Pluma invite link: shows the event preview, "Get your ticket" (opens `pluma://event/<key>`), an Android APK download, "Copy invite", and a QR code to open the page on a phone. No build step, no external resources, no analytics.

**Link format:** `https://<host>/#<64 lowercase hex event key>[.<preview>]`, where `<preview>` is base64url (no padding) of UTF-8 JSON `{"t":title,"s":startISO,"z":IANA tz,"l":location,"h":host name}` (all fields optional).

**Deploy (GitHub Pages):** copy this folder's contents (plus `pluma.apk`) to the root of a Pages branch or `/docs` folder, then enable Pages in the repo settings. It also works from any static host or opened straight from disk (`file://`).

**Privacy:** everything is in the URL fragment (after `#`), which browsers never send to the server, so the host learns nothing about the event or the guest.

QR codes are made by the vendored [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator) (MIT, `vendor/`).
