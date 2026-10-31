/* Pluma invite page. No network calls: everything comes from the URL fragment.
 * Fragment format: #<64 lowercase hex event key>[.<base64url(UTF-8 JSON preview)>]
 * Preview JSON (all optional): {"t":title,"s":startISO,"z":IANA tz,"l":location,"h":host name}
 */
(function (root) {
  'use strict';

  var KEY_RE = /^[0-9a-f]{64}$/;
  var MAX_FIELD = 200;

  function base64urlToUtf8(s) {
    if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error('bad base64url');
    var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  }

  function cleanStr(v) {
    if (typeof v !== 'string') return null;
    v = v.trim();
    if (!v) return null;
    return v.length > MAX_FIELD ? v.slice(0, MAX_FIELD) + '…' : v;
  }

  function isValidTz(tz) {
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch (e) { return false; }
  }

  // Returns { key: string|null, preview: object|null }. key is null when invalid.
  function parseFragment(hash) {
    var frag = String(hash || '').replace(/^#/, '').trim();
    try { frag = decodeURIComponent(frag); } catch (e) { /* keep raw */ }
    var dot = frag.indexOf('.');
    var key = (dot === -1 ? frag : frag.slice(0, dot));
    var rawPreview = dot === -1 ? '' : frag.slice(dot + 1);
    if (!KEY_RE.test(key)) return { key: null, preview: null };

    var preview = null;
    if (rawPreview) {
      try {
        var obj = JSON.parse(base64urlToUtf8(rawPreview));
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          var s = cleanStr(obj.s);
          var start = s ? new Date(s) : null;
          var z = cleanStr(obj.z);
          preview = {
            title: cleanStr(obj.t),
            start: start && !isNaN(start.getTime()) ? start : null,
            tz: z && isValidTz(z) ? z : null,
            location: cleanStr(obj.l),
            host: cleanStr(obj.h)
          };
        }
      } catch (e) {
        preview = null; // a broken preview is not fatal; show the neutral card
      }
    }
    return { key: key, preview: preview };
  }

  function viewerTz() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch (e) { return null; }
  }

  // Returns { when: string, tzNote: string|null }
  function formatWhen(date, eventTz, locale, viewerZone) {
    var opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' };
    var vz = viewerZone || viewerTz();
    var local = new Intl.DateTimeFormat(locale, Object.assign({ timeZone: vz || undefined, timeZoneName: 'short' }, opts)).format(date);
    var note = null;
    if (eventTz && vz && eventTz !== vz) {
      var there = new Intl.DateTimeFormat(locale, { timeZone: eventTz, hour: 'numeric', minute: '2-digit', weekday: 'short', timeZoneName: 'short' }).format(date);
      // Only add a note if the wall-clock time actually differs.
      var a = new Intl.DateTimeFormat('en', Object.assign({ timeZone: eventTz }, opts)).format(date);
      var b = new Intl.DateTimeFormat('en', Object.assign({ timeZone: vz }, opts)).format(date);
      if (a !== b) note = there + ' at the event (' + eventTz.replace(/_/g, ' ') + ')';
    }
    return { when: local, tzNote: note };
  }

  function appLink(key) { return 'pluma://event/' + key; }

  // ---- DOM ----
  function $(id) { return document.getElementById(id); }
  function show(el, on) { el.hidden = !on; }

  function render() {
    var res = parseFragment(location.hash);
    show($('invite'), !!res.key);
    show($('invalid'), !res.key);
    if (!res.key) {
      show($('qr-box'), false);
      document.title = 'Invite link incomplete · Pluma';
      return;
    }

    var p = res.preview;
    var title = p && p.title;
    $('ev-title').textContent = title || "You're invited to an event on Pluma";
    show($('ev-eyebrow'), !!title);
    document.title = (title ? title + ' · ' : "You're invited · ") + 'Pluma';

    if (p && p.start) {
      var w = formatWhen(p.start, p.tz);
      $('ev-when').textContent = w.when;
      $('ev-tz').textContent = w.tzNote || '';
      show($('row-when'), true);
    } else show($('row-when'), false);

    if (p && p.location) { $('ev-where').textContent = p.location; show($('row-where'), true); }
    else show($('row-where'), false);

    var hostEl = $('ev-host');
    hostEl.textContent = '';
    if (p && p.host) {
      hostEl.appendChild(document.createTextNode('Hosted by '));
      var strong = document.createElement('strong');
      strong.textContent = p.host;
      hostEl.appendChild(strong);
      show(hostEl, true);
    } else show(hostEl, false);

    $('open-app').href = appLink(res.key);
    $('copy').onclick = function () { copyInvite(appLink(res.key)); };

    renderQr();
  }

  function copyInvite(text) {
    var note = $('copy-note');
    function done(ok) {
      note.textContent = ok
        ? 'Copied. Open Pluma after installing — it will find your invite.'
        : 'Couldn’t copy automatically. Install Pluma, then open this link again on your phone.';
      note.classList.toggle('ok', ok);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(fallbackCopy(text)); });
    } else done(fallbackCopy(text));
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    return ok;
  }

  function isDesktop() {
    // Wide screen, or a mouse-driven device: worth offering a phone hand-off.
    var mq = root.matchMedia ? function (q) { return root.matchMedia(q).matches; } : function () { return false; };
    return mq('(min-width: 720px)') || mq('(hover: hover) and (pointer: fine)');
  }

  function renderQr() {
    var box = $('qr-box');
    if (typeof root.qrcode !== 'function' || !isDesktop()) { show(box, false); return; }
    try {
      var qr = root.qrcode(0, 'M');
      qr.addData(location.href);
      qr.make();
      $('qr').innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true, alt: 'QR code for this invite', title: 'QR code for this invite' });
      show(box, true);
    } catch (e) {
      show(box, false);
    }
  }

  var api = { parseFragment: parseFragment, formatWhen: formatWhen, appLink: appLink, base64urlToUtf8: base64urlToUtf8 };
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else if (typeof document !== 'undefined') {
    root.addEventListener('hashchange', render);
    root.addEventListener('resize', function () { if (!$('invalid').hidden) return; renderQr(); });
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
    else render();
  }
})(typeof window !== 'undefined' ? window : globalThis);
