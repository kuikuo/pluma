import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator, Alert, AppState, BackHandler, KeyboardAvoidingView, Linking, Platform, Pressable,
  ScrollView, Share, StatusBar, StyleSheet, Switch, Text, TextInput, View
} from 'react-native'
import * as Clipboard from 'expo-clipboard'
import { CameraView, useCameraPermissions } from 'expo-camera'
import QRCode from 'react-native-qrcode-svg'
import * as Notifications from 'expo-notifications'
import * as Sharing from 'expo-sharing'
import { File, Paths } from 'expo-file-system'
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake'
import { call, onEvent } from './rpc'

// Invite links are web pages (apps/invite-page) carrying the event key and a
// preview in the URL fragment; the app also accepts raw pluma:// links.
const INVITE_BASE = 'https://kuikuo.github.io/pluma/'
const KEY_RE = /(?:pluma:\/\/event\/|#)([0-9a-f]{64})/
function parseInvite(text) {
  const m = KEY_RE.exec(text || '')
  return m ? 'pluma://event/' + m[1] : null
}
function inviteUrl(link, preview) {
  return INVITE_BASE + '#' + link.slice(-64) + (preview ? '.' + preview : '')
}
const LINK_RE = { exec: (text) => { const l = parseInvite(text); return l ? [l] : null } }

Notifications.setNotificationHandler({
  handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false })
})

// Reminders are local notifications scheduled on the guest's phone: no push server.
async function scheduleReminders(link, info, going) {
  const ids = ['1d', '1h'].map((x) => link.slice(-16) + '-' + x)
  for (const id of ids) await Notifications.cancelScheduledNotificationAsync(id).catch(() => {})
  if (!going || info.cancelled || !(await Notifications.getPermissionsAsync()).granted) return
  await Notifications.setNotificationChannelAsync('reminders', { name: 'Event reminders', importance: Notifications.AndroidImportance.HIGH })
  const start = new Date(info.start).getTime()
  const plan = [[ids[0], 86_400_000, 'tomorrow'], [ids[1], 3_600_000, 'in 1 hour']]
  for (const [identifier, before, label] of plan) {
    const when = start - before
    if (when < Date.now() + 5000) continue
    await Notifications.scheduleNotificationAsync({
      identifier,
      content: { title: info.title, body: `Starts ${label}${info.location ? ' · ' + info.location : ''}`, data: { link } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(when), channelId: 'reminders' }
    })
  }
}

async function shareFile(name, text, mimeType) {
  const f = new File(Paths.cache, name)
  if (f.exists) f.delete()
  f.create()
  f.write(text)
  await Sharing.shareAsync(f.uri, { mimeType, dialogTitle: name })
}

const safeName = (t) => (t || 'event').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'event'
const JOIN_PREFIX = 'pluma-join:'
const ACCENT = '#5b3df5'

// ---------- shared bits ----------

function Button({ title, onPress, kind = 'primary', disabled }) {
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [s.btn, kind === 'secondary' && s.btnSecondary, kind === 'danger' && s.btnDanger, (pressed || disabled) && { opacity: 0.6 }]}
    >
      <Text style={[s.btnText, kind === 'secondary' && { color: ACCENT }]}>{title}</Text>
    </Pressable>
  )
}

function Field({ label, ...props }) {
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={s.label}>{label}</Text>
      <TextInput style={s.input} placeholderTextColor="#999" {...props} />
    </View>
  )
}

function Segmented({ options, value, onChange }) {
  return (
    <View style={s.segment}>
      {options.map(([v, label]) => (
        <Pressable key={v} onPress={() => onChange(v)} style={[s.segmentItem, value === v && s.segmentActive]}>
          <Text style={[s.segmentText, value === v && { color: '#fff' }]}>{label}</Text>
        </Pressable>
      ))}
    </View>
  )
}

function when(start, timezone) {
  if (!start) return ''
  const d = new Date(start)
  const local = d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
  const here = Intl.DateTimeFormat().resolvedOptions().timeZone
  return timezone && timezone !== here ? `${local} (your time) · event time zone ${timezone}` : local
}

const STATUS_TEXT = {
  approved: "You're going",
  pending: 'Waiting for the organiser to approve',
  declined: 'Not approved',
  full: 'This event is full',
  waitlist: "You're on the waitlist",
  closed: 'Registration is closed',
  cancelled: "You're not going",
  revoked: 'Your spot was cancelled by the host',
  none: ''
}

const HOST_STATUS = {
  approved: 'going',
  pending: 'waiting for you',
  declined: 'declined',
  full: 'asked when full',
  waitlist: 'on waitlist',
  closed: 'asked after closing',
  cancelled: 'cancelled',
  revoked: 'cancelled by host'
}

function listNames(names) {
  return names.length <= 1 ? names.join('') : names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1]
}

// ---------- screens ----------

function Home({ go }) {
  const [events, setEvents] = useState(null)
  const [peers, setPeers] = useState(0)
  const [invite, setInvite] = useState('')

  const load = useCallback(async () => {
    setEvents(await call('events'))
    setPeers(await call('peers'))
  }, [])

  useEffect(() => {
    load()
    const off = onEvent(load)
    const t = setInterval(load, 5000)
    return () => { off(); clearInterval(t) }
  }, [load])

  async function openInvite(text) {
    const m = LINK_RE.exec(text || '')
    if (!m) return Alert.alert('That doesn’t look like a Pluma invite', 'Invites start with pluma://event/')
    go('event', { link: m[0] })
  }

  return (
    <ScrollView contentContainerStyle={s.page}>
      <Text style={s.h1}>Pluma</Text>
      <Text style={s.muted}>Events without accounts. Tickets that work offline.</Text>

      <View style={{ height: 20 }} />
      <Button title="Create an event" onPress={() => go('create')} />
      <View style={{ height: 10 }} />
      <Button title="Scan an invite" kind="secondary" onPress={() => go('scanInvite')} />

      <View style={s.card}>
        <Text style={s.label}>Got an invite link?</Text>
        <TextInput style={s.input} placeholder="Paste it here" value={invite} onChangeText={setInvite} autoCapitalize="none" placeholderTextColor="#999" />
        <View style={{ height: 8 }} />
        <Button title="Open invite" kind="secondary" onPress={() => openInvite(invite)} />
      </View>

      <Text style={s.h2}>Your events</Text>
      {events === null && <ActivityIndicator />}
      {events && events.length === 0 && <Text style={s.muted}>Nothing yet. Create one or open an invite.</Text>}
      {events && events.map((e) => (
        <Pressable key={e.link} style={s.card} onPress={() => go('event', { link: e.link })}>
          <Text style={s.cardTitle}>{e.title}{e.cancelled ? ' (cancelled)' : ''}</Text>
          <Text style={s.muted}>{when(e.start)}</Text>
          <Text style={s.tag}>{e.role === 'organiser' || e.role === 'manager' ? 'Hosting' : e.role === 'scanner' ? 'Check-in helper' : STATUS_TEXT[e.status] || 'Invited'}</Text>
        </Pressable>
      ))}

      <Text style={[s.muted, { marginTop: 24, textAlign: 'center' }]}>
        {peers > 0 ? `Connected to ${peers} device${peers === 1 ? '' : 's'}` : 'Looking for other devices…'}
      </Text>
    </ScrollView>
  )
}

// Create a new event, or edit one when `info` (the current event) is given.
function Create({ go, back, link, info }) {
  const editing = !!info
  const pad = (n) => String(n).padStart(2, '0')
  const initial = info && info.start ? new Date(info.start) : (() => { const t = new Date(Date.now() + 86400000); t.setHours(18, 0, 0, 0); return t })()
  const [title, setTitle] = useState(editing ? info.title || '' : '')
  const [date, setDate] = useState(`${initial.getFullYear()}-${pad(initial.getMonth() + 1)}-${pad(initial.getDate())}`)
  const [time, setTime] = useState(`${pad(initial.getHours())}:${pad(initial.getMinutes())}`)
  const [location, setLocation] = useState(editing ? info.location || '' : '')
  const [description, setDescription] = useState(editing ? info.description || '' : '')
  const [capacity, setCapacity] = useState(editing && info.capacity !== null ? String(info.capacity) : '')
  const [requireApproval, setRequireApproval] = useState(editing ? !!info.requireApproval : false)
  const [mode, setMode] = useState(editing ? info.guestListMode : 'private')
  const [types, setTypes] = useState(editing ? (info.ticketTypes || []).map((t) => ({ ...t, capacity: t.capacity === null ? '' : String(t.capacity) })) : [])
  const [questions, setQuestions] = useState(editing ? (info.questions || []).map((q) => ({ ...q, options: (q.options || []).join(', ') })) : [])
  const newId = (p) => p + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36)
  const editType = (i, patch) => setTypes((ts) => ts.map((t, j) => (j === i ? { ...t, ...patch } : t)))
  const editQuestion = (i, patch) => setQuestions((qs) => qs.map((q, j) => (j === i ? { ...q, ...patch } : q)))
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => { if (!editing) call('profile').then((p) => setName(p.name)) }, [editing])

  async function publish() {
    if (!title.trim()) return Alert.alert('Give your event a name')
    const start = new Date(`${date}T${time}:00`)
    if (isNaN(start)) return Alert.alert('Check the date and time', 'Use YYYY-MM-DD and HH:MM')
    setBusy(true)
    const fields = {
      title: title.trim(),
      start: start.toISOString(),
      timezone: editing ? info.timezone : Intl.DateTimeFormat().resolvedOptions().timeZone,
      location: location.trim(),
      description: description.trim(),
      capacity: capacity ? Number(capacity) : null,
      requireApproval,
      guestListMode: mode,
      ticketTypes: types.filter((t) => t.name.trim()).map((t) => ({ id: t.id, name: t.name.trim(), capacity: t.capacity ? Number(t.capacity) : null, requireApproval: !!t.requireApproval })),
      questions: questions.filter((q) => q.label.trim()).map((q) => ({
        id: q.id, label: q.label.trim(), kind: q.kind, required: !!q.required,
        options: q.kind === 'choice' ? q.options.split(',').map((o) => o.trim()).filter(Boolean) : []
      }))
    }
    try {
      if (editing) {
        await call('update', link, fields)
        back()
        return
      }
      if (name.trim()) await call('setProfile', { name: name.trim() })
      const newLink = await call('createEvent', fields)
      go('event', { link: newLink, justCreated: true })
    } catch (err) {
      Alert.alert(editing ? 'Could not save changes' : 'Could not create the event', err.message)
      setBusy(false)
    }
  }

  return (
    <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={s.page} keyboardShouldPersistTaps="handled">
        <Pressable onPress={back}><Text style={s.back}>‹ Back</Text></Pressable>
        <Text style={s.h1}>{editing ? 'Edit event' : 'New event'}</Text>
        <Field label="Event name" value={title} onChangeText={setTitle} placeholder="Hack night" />
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <View style={{ flex: 3 }}><Field label="Date" value={date} onChangeText={setDate} placeholder="YYYY-MM-DD" /></View>
          <View style={{ flex: 2 }}><Field label="Time" value={time} onChangeText={setTime} placeholder="18:00" /></View>
        </View>
        <Field label="Where" value={location} onChangeText={setLocation} placeholder="Address or video link" />
        <Field label="About" value={description} onChangeText={setDescription} placeholder="What should guests know?" multiline />
        <Field label="Capacity (optional)" value={capacity} onChangeText={(t) => setCapacity(t.replace(/\D/g, ''))} keyboardType="number-pad" placeholder="No limit" />
        <View style={s.row}>
          <Text style={s.body}>I approve each guest</Text>
          <Switch value={requireApproval} onValueChange={setRequireApproval} />
        </View>
        <Text style={s.label}>Who can see the guest list?</Text>
        <Segmented value={mode} onChange={setMode} options={[['private', 'Only hosts'], ['selective', 'Guests (I pick)'], ['public', 'All guests']]} />

        <Text style={s.h2}>Ticket types</Text>
        {types.length === 0 && <Text style={[s.muted, { marginBottom: 8 }]}>One general ticket. Add types for things like Speaker or Volunteer.</Text>}
        {types.map((t, i) => (
          <View key={t.id} style={s.card}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <View style={{ flex: 3 }}><Field label="Name" value={t.name} onChangeText={(v) => editType(i, { name: v })} placeholder="General" /></View>
              <View style={{ flex: 2 }}><Field label="Capacity" value={t.capacity} onChangeText={(v) => editType(i, { capacity: v.replace(/\D/g, '') })} keyboardType="number-pad" placeholder="No limit" /></View>
            </View>
            <View style={[s.row, { marginBottom: 0 }]}>
              <Text style={s.body}>I approve these guests</Text>
              <Switch value={!!t.requireApproval} onValueChange={(v) => editType(i, { requireApproval: v })} />
            </View>
            {!editing && <Pressable onPress={() => setTypes((ts) => ts.filter((_, j) => j !== i))}><Text style={s.small}>Remove</Text></Pressable>}
          </View>
        ))}
        <View style={{ height: 8 }} />
        <Button title="+ Add ticket type" kind="secondary" onPress={() => setTypes((ts) => [...ts, { id: newId('t'), name: ts.length === 0 ? 'General' : '', capacity: '', requireApproval: false }])} />

        <Text style={s.h2}>Questions for guests</Text>
        {questions.map((q, i) => (
          <View key={q.id} style={s.card}>
            <Field label="Question" value={q.label} onChangeText={(v) => editQuestion(i, { label: v })} placeholder="Dietary needs?" />
            <Segmented value={q.kind} onChange={(v) => editQuestion(i, { kind: v })} options={[['text', 'Text'], ['choice', 'Choice'], ['agree', 'Checkbox']]} />
            {q.kind === 'choice' && <View style={{ marginTop: 10 }}><Field label="Options (comma separated)" value={q.options} onChangeText={(v) => editQuestion(i, { options: v })} placeholder="None, Vegetarian, Halal" /></View>}
            <View style={[s.row, { marginTop: 10, marginBottom: 0 }]}>
              <Text style={s.body}>Required</Text>
              <Switch value={!!q.required} onValueChange={(v) => editQuestion(i, { required: v })} />
            </View>
            <Pressable onPress={() => setQuestions((qs) => qs.filter((_, j) => j !== i))}><Text style={s.small}>Remove</Text></Pressable>
          </View>
        ))}
        <View style={{ height: 8 }} />
        <Button title="+ Add question" kind="secondary" onPress={() => setQuestions((qs) => [...qs, { id: newId('q'), label: '', kind: 'text', options: '', required: false }])} />
        <View style={{ height: 20 }} />
        {!editing && <Field label="Your name (shown as host)" value={name} onChangeText={setName} placeholder="Your name" />}
        {editing && <Text style={[s.muted, { marginBottom: 12 }]}>Guests see changes the next time their app syncs. Lowering capacity never cancels anyone automatically.</Text>}
        <Button title={busy ? (editing ? 'Saving…' : 'Publishing…') : (editing ? 'Save changes' : 'Publish')} onPress={publish} disabled={busy} />
      </ScrollView>
    </KeyboardAvoidingView>
  )
}

function Ticket({ link }) {
  const [code, setCode] = useState(null)
  useEffect(() => {
    let alive = true
    const refresh = async () => { const c = await call('ticketQR', link); if (alive) setCode(c) }
    refresh()
    const t = setInterval(refresh, 10_000)
    return () => { alive = false; clearInterval(t) }
  }, [link])
  if (!code) return null
  return (
    <View style={[s.card, { alignItems: 'center' }]}>
      <Text style={s.cardTitle}>Your ticket</Text>
      <View style={{ padding: 12, backgroundColor: '#fff' }}><QRCode value={code} size={240} /></View>
      <Text style={[s.muted, { textAlign: 'center', marginTop: 8 }]}>Saved on this phone — works offline.{'\n'}The code refreshes itself, so screenshots won’t work.</Text>
    </View>
  )
}

function RsvpSheet({ link, info, types, onDone }) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [ticketType, setTicketType] = useState(types[0] ? types[0].id : null)
  const [answers, setAnswers] = useState({})
  const [busy, setBusy] = useState(false)
  useEffect(() => { call('profile').then((p) => { setName(p.name); setEmail(p.email) }) }, [])
  const questions = info.questions || []
  const setAnswer = (id, v) => setAnswers((a) => ({ ...a, [id]: v }))

  const visibility = info.guestListMode === 'private'
    ? 'Only the hosts will see your name, details and answers.'
    : 'Other guests will see your name. Only hosts see your email and answers.'

  async function submit() {
    if (!name.trim()) return Alert.alert('Add your name so the host knows who’s coming')
    for (const q of questions) {
      const a = answers[q.id]
      if (q.required && (q.kind === 'agree' ? a !== true : !a)) return Alert.alert('Please answer: ' + q.label)
    }
    setBusy(true)
    try {
      await call('setProfile', { name: name.trim(), email: email.trim() })
      await call('rsvp', link, { name: name.trim(), email: email.trim() || null, answers, ticketType })
      onDone()
    } catch (err) {
      Alert.alert('Could not send', err.message)
      setBusy(false)
    }
  }

  return (
    <View style={s.card}>
      {types.length > 1 && (
        <View style={{ marginBottom: 14 }}>
          <Text style={s.label}>Ticket</Text>
          {types.map((t) => (
            <Pressable key={t.id} onPress={() => setTicketType(t.id)} style={[s.option, ticketType === t.id && s.optionActive]}>
              <Text style={[s.body, ticketType === t.id && { color: ACCENT, fontWeight: '600' }]}>{t.name}</Text>
              <Text style={s.muted}>{t.left === 0 ? 'Full — join the waitlist' : t.left !== null ? `${t.left} left` : ''}{t.requireApproval ? (t.left !== null ? ' · ' : '') + 'host approves' : ''}</Text>
            </Pressable>
          ))}
        </View>
      )}
      <Field label="Your name" value={name} onChangeText={setName} placeholder="Name" />
      <Field label="Email (optional)" value={email} onChangeText={setEmail} placeholder="For the host only" keyboardType="email-address" autoCapitalize="none" />
      {questions.map((q) => (
        <View key={q.id} style={{ marginBottom: 14 }}>
          {q.kind === 'agree' ? (
            <View style={s.row}>
              <Text style={[s.body, { flex: 1, marginRight: 10 }]}>{q.label}{q.required ? ' *' : ''}</Text>
              <Switch value={answers[q.id] === true} onValueChange={(v) => setAnswer(q.id, v)} />
            </View>
          ) : q.kind === 'choice' ? (
            <>
              <Text style={s.label}>{q.label}{q.required ? ' *' : ''}</Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {q.options.map((o) => (
                  <Pressable key={o} onPress={() => setAnswer(q.id, o)} style={[s.chip, answers[q.id] === o && s.chipActive]}>
                    <Text style={[s.chipText, answers[q.id] === o && { color: '#fff' }]}>{o}</Text>
                  </Pressable>
                ))}
              </View>
            </>
          ) : (
            <Field label={q.label + (q.required ? ' *' : '')} value={answers[q.id] || ''} onChangeText={(v) => setAnswer(q.id, v)} placeholder="Your answer" />
          )}
        </View>
      ))}
      <Text style={[s.muted, { marginBottom: 10 }]}>{visibility}</Text>
      <Button title={busy ? 'Sending…' : 'Confirm'} onPress={submit} disabled={busy} />
    </View>
  )
}

function GuestView({ d, link, refresh }) {
  const [rsvping, setRsvping] = useState(false)
  const [remind, setRemind] = useState(null)
  const status = d.mine.status
  const canRsvp = status === 'none' || status === 'cancelled'
  const going = status === 'approved'

  useEffect(() => {
    Notifications.getPermissionsAsync().then((p) => setRemind(p.granted))
  }, [])
  useEffect(() => {
    scheduleReminders(link, d.info, going).catch(() => {})
  }, [link, d.info.start, d.info.cancelled, d.info.title, going, remind])

  async function turnOnReminders() {
    const p = await Notifications.requestPermissionsAsync()
    setRemind(p.granted)
    if (!p.granted) Alert.alert('Reminders are off', 'You can allow notifications for Pluma in Android settings.')
  }

  return (
    <>
      {status !== 'none' && <Text style={[s.status, status === 'approved' && { color: '#0a7d32' }]}>{STATUS_TEXT[status]}{d.mine.message ? ` — ${d.mine.message}` : ''}</Text>}
      {status === 'pending' && <Text style={s.muted}>We’ll keep trying in the background. You can close the app.</Text>}
      {status === 'waitlist' && <Text style={s.muted}>{d.mine.position ? `You're number ${d.mine.position} in line. ` : ''}If a spot opens up, your ticket appears here automatically.</Text>}
      {status === 'approved' && !d.mine.ticket && <Text style={s.muted}>Your ticket is on its way — it arrives as soon as a host is online.</Text>}
      {d.mine.ticket && <Ticket link={link} />}
      {(going || status === 'pending' || status === 'waitlist') && (
        <View style={{ flexDirection: 'row', gap: 10, marginTop: 10, marginBottom: 6 }}>
          <View style={{ flex: 1 }}><Button title="Add to calendar" kind="secondary" onPress={async () => shareFile(safeName(d.info.title) + '.ics', await call('ics', link), 'text/calendar')} /></View>
          {going && remind === false && <View style={{ flex: 1 }}><Button title="Remind me" kind="secondary" onPress={turnOnReminders} /></View>}
        </View>
      )}
      {going && remind && <Text style={[s.muted, { marginBottom: 8 }]}>🔔 We'll remind you a day and an hour before.</Text>}
      {canRsvp && !d.info.cancelled && (rsvping
        ? <RsvpSheet link={link} info={d.info} types={d.ticketTypes} onDone={() => { setRsvping(false); refresh() }} />
        : <Button title="I’m going" onPress={() => setRsvping(true)} />)}
      {(status === 'approved' || status === 'pending' || status === 'waitlist') && (
        <View style={{ marginTop: 10 }}>
          <Button title="I can’t make it" kind="secondary" onPress={() => Alert.alert('Cancel your spot?', 'Your ticket will stop working.', [
            { text: 'Keep it' },
            { text: 'Cancel my spot', style: 'destructive', onPress: async () => { await call('cancelRsvp', link); refresh() } }
          ])} />
        </View>
      )}
    </>
  )
}

function HostView({ d, link, refresh, go }) {
  const [blast, setBlast] = useState('')
  const [keepOn, setKeepOn] = useState(false)
  const typeNames = new Map(d.ticketTypes.map((t) => [t.id, t.name]))
  const questions = d.info.questions || []
  useEffect(() => () => deactivateKeepAwake('hosting'), [])
  function toggleKeepOn(v) {
    setKeepOn(v)
    if (v) activateKeepAwakeAsync('hosting')
    else deactivateKeepAwake('hosting')
  }
  const guests = d.guests || []
  const counts = guests.reduce((a, g) => ({ ...a, [g.status]: (a[g.status] || 0) + 1 }), {})
  const over = new Set(d.overCapacity)

  async function act(fn) {
    try { await fn(); refresh() } catch (err) { Alert.alert('Something went wrong', err.message) }
  }

  return (
    <>
      <View style={s.card}>
        <Text style={s.cardTitle}>Invite people</Text>
        <View style={{ alignItems: 'center', padding: 10, backgroundColor: '#fff' }}><QRCode value={inviteUrl(link, d.preview)} size={200} /></View>
        <Button title="Share invite link" onPress={() => Share.share({ message: `You're invited to ${d.info.title}! ${inviteUrl(link, d.preview)}` })} />
        <View style={{ height: 8 }} />
        <Button title="Copy link" kind="secondary" onPress={() => Clipboard.setStringAsync(inviteUrl(link, d.preview))} />
        <View style={[s.row, { marginTop: 12, marginBottom: 0 }]}>
          <View style={{ flex: 1, marginRight: 10 }}>
            <Text style={s.body}>Keep sharing</Text>
            <Text style={s.muted}>Keeps the screen on so guests can reach your event. Or add a co-host.</Text>
          </View>
          <Switch value={keepOn} onValueChange={toggleKeepOn} />
        </View>
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Guests</Text>
        <Text style={s.muted}>
          {counts.approved || 0} going{d.info.capacity !== null ? ` of ${d.info.capacity}` : ''} · {counts.pending || 0} waiting · {d.checkins} checked in
        </Text>
        {over.size > 0 && <Text style={[s.status, { color: '#b42318' }]}>{over.size} {over.size === 1 ? 'guest' : 'guests'} over capacity. The most recent sign-ups are highlighted; cancel tickets to fit.</Text>}
        {d.duplicates.length > 0 && <Text style={[s.status, { color: '#b42318' }]}>{listNames(d.duplicates)} {d.duplicates.length === 1 ? 'was' : 'were'} checked in at two doors. Worth a look.</Text>}
        <View style={{ height: 6 }} />
        {d.ticketTypes.length > 1 && <Text style={s.muted}>{d.ticketTypes.map((t) => `${t.name}: ${t.taken}${t.capacity !== null ? '/' + t.capacity : ''}`).join(' · ')}</Text>}
        {guests.length === 0 && <Text style={s.muted}>No one yet. Share the invite!</Text>}
        {guests.map((g) => (
          <View key={g.id} style={[s.guest, over.has(g.id) && { backgroundColor: '#fff1f0' }]}>
            <View style={{ flex: 1 }}>
              <Text style={s.body}>{g.name || 'Unknown'}{g.hidden ? ' (hidden)' : ''}</Text>
              <Text style={s.muted}>{HOST_STATUS[g.status] || g.status}{d.ticketTypes.length > 1 ? ` · ${typeNames.get(g.ticketType) || g.ticketType}` : ''}{g.email ? ` · ${g.email}` : ''}</Text>
              {questions.length > 0 && g.answers && <Text style={[s.muted, { fontSize: 13 }]}>{questions.filter((q) => g.answers[q.id] !== undefined && g.answers[q.id] !== '').map((q) => `${q.label}: ${g.answers[q.id] === true ? 'yes' : g.answers[q.id]}`).join(' · ')}</Text>}
            </View>
            {g.status === 'pending' || g.status === 'full' || g.status === 'waitlist' ? (
              <View style={{ flexDirection: 'row', gap: 6 }}>
                <Pressable onPress={() => act(() => call('approve', link, g.id))}><Text style={s.action}>Approve</Text></Pressable>
                <Pressable onPress={() => act(() => call('decline', link, g.id))}><Text style={[s.action, { color: '#b42318' }]}>Decline</Text></Pressable>
              </View>
            ) : g.status === 'approved' ? (
              <View style={{ flexDirection: 'row', gap: 6 }}>
                {d.info.guestListMode === 'selective' && <Pressable onPress={() => act(() => call('hide', link, g.id, !g.hidden))}><Text style={s.action}>{g.hidden ? 'Show' : 'Hide'}</Text></Pressable>}
                <Pressable onPress={() => Alert.alert(`Cancel ${g.name}'s ticket?`, 'They will be told their spot was cancelled.', [
                  { text: 'Keep' },
                  { text: 'Cancel ticket', style: 'destructive', onPress: () => act(() => call('revoke', link, g.id)) }
                ])}><Text style={[s.action, { color: '#b42318' }]}>Cancel</Text></Pressable>
              </View>
            ) : null}
          </View>
        ))}
      </View>

      {guests.length > 0 && <Button title="Export guest list (CSV)" kind="secondary" onPress={async () => shareFile(safeName(d.info.title) + '-guests.csv', await call('csv', link), 'text/csv')} />}
      <View style={s.card}>
        <Text style={s.cardTitle}>Who can see the guest list?</Text>
        <Segmented value={d.info.guestListMode} onChange={(m) => act(() => call('setMode', link, m))} options={[['private', 'Only hosts'], ['selective', 'I pick'], ['public', 'All guests']]} />
        {d.info.guestListMode !== 'private' && <Text style={[s.muted, { marginTop: 6 }]}>Switching to “Only hosts” stops sharing names from now on, but guests who already saw them may remember.</Text>}
      </View>

      <View style={s.card}>
        <Text style={s.cardTitle}>Message guests</Text>
        <TextInput style={s.input} value={blast} onChangeText={setBlast} placeholder="e.g. Doors open at 6:30" placeholderTextColor="#999" multiline />
        <View style={{ height: 8 }} />
        <Button title="Send to everyone going" kind="secondary" onPress={() => blast.trim() && act(async () => { await call('blast', link, blast.trim()); setBlast('') })} />
      </View>

      <Button title="Check in guests" onPress={() => go('scanTickets', { link })} />
      <View style={{ height: 10 }} />
      <Button title="Edit event details" kind="secondary" onPress={() => go('edit', { link, info: d.info })} />
      <View style={{ height: 10 }} />
      {d.role === 'organiser' && <Button title="Add a co-host or door helper" kind="secondary" onPress={() => go('scanHelper', { link })} />}
      <View style={{ height: 10 }} />
      {d.role === 'organiser' && !d.info.cancelled && (
        <Button title="Cancel event" kind="danger" onPress={() => Alert.alert('Cancel this event?', 'All guests will see it is cancelled.', [
          { text: 'Keep event' },
          { text: 'Cancel event', style: 'destructive', onPress: () => act(() => call('cancelEvent', link)) }
        ])} />
      )}
    </>
  )
}

function Event({ link, justCreated, back, go }) {
  const [d, setD] = useState(null)
  const [showJoin, setShowJoin] = useState(false)

  const refresh = useCallback(async () => {
    try { setD(await call('detail', link)) } catch (err) { console.warn(err) }
  }, [link])

  useEffect(() => {
    refresh()
    const off = onEvent((m) => { if (m.link === link) refresh() })
    const t = setInterval(refresh, 4000)
    return () => { off(); clearInterval(t) }
  }, [link, refresh])

  useEffect(() => {
    if (justCreated) Share.share({ message: `You're invited! ${inviteUrl(link)}` }).catch(() => {})
  }, [justCreated, link])

  if (!d || !d.info) {
    return (
      <View style={[s.page, { flex: 1, justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator size="large" />
        <Text style={[s.muted, { marginTop: 14, textAlign: 'center' }]}>Finding the event…{'\n'}This works as soon as the host or another guest is online.</Text>
        <View style={{ height: 20 }} />
        <Button title="Back" kind="secondary" onPress={back} />
      </View>
    )
  }

  const manager = d.role === 'organiser' || d.role === 'manager'
  if (d.needsUpdate) {
    return (
      <View style={[s.page, { flex: 1, justifyContent: 'center' }]}>
        <Text style={s.h2}>{d.info.title}</Text>
        <Text style={[s.body, { marginBottom: 16 }]}>This event was made with a newer version of Pluma. Update the app to see it and join.</Text>
        <Button title="Back" kind="secondary" onPress={back} />
      </View>
    )
  }
  return (
    <ScrollView contentContainerStyle={s.page}>
      <Pressable onPress={back}><Text style={s.back}>‹ Events</Text></Pressable>
      {d.info.cancelled && <Text style={[s.status, { color: '#b42318' }]}>This event has been cancelled.</Text>}
      <Text style={s.h1}>{d.info.title}</Text>
      <Text style={s.body}>{when(d.info.start, d.info.timezone)}</Text>
      {!!d.info.location && <Text style={s.body}>📍 {d.info.location}</Text>}
      {d.hosts.length > 0 && <Text style={s.muted}>Hosted by {d.hosts.join(', ')}</Text>}
      {!!d.info.description && <Text style={[s.body, { marginTop: 10 }]}>{d.info.description}</Text>}
      <View style={{ height: 16 }} />

      {d.blasts.length > 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>Updates from the host</Text>
          {d.blasts.slice().reverse().map((b, i) => <Text key={i} style={s.body}>• {b.body}</Text>)}
        </View>
      )}

      {manager ? <HostView d={d} link={link} refresh={refresh} go={go} /> : d.role === 'scanner' ? (
        <Button title="Check in guests" onPress={() => go('scanTickets', { link })} />
      ) : <GuestView d={d} link={link} refresh={refresh} />}

      {!manager && d.roster.length > 0 && (
        <View style={s.card}>
          <Text style={s.cardTitle}>Who’s going</Text>
          <Text style={s.body}>{d.roster.join(', ')}</Text>
        </View>
      )}

      {!manager && d.role !== 'scanner' && (
        <Pressable onPress={() => setShowJoin(!showJoin)}><Text style={[s.muted, { textAlign: 'center', marginTop: 24 }]}>Helping run this event?</Text></Pressable>
      )}
      {showJoin && (
        <View style={[s.card, { alignItems: 'center' }]}>
          <Text style={[s.body, { textAlign: 'center', marginBottom: 10 }]}>Ask the organiser to scan this with “Add a co-host or door helper”.</Text>
          <View style={{ padding: 10, backgroundColor: '#fff' }}><QRCode value={JOIN_PREFIX + JSON.stringify(d.joinRequest)} size={200} /></View>
        </View>
      )}
    </ScrollView>
  )
}

function Scanner({ title, hint, onCode, back }) {
  const [permission, requestPermission] = useCameraPermissions()
  const [result, setResult] = useState(null)
  const busy = useRef(false)

  if (!permission) return <View style={s.page} />
  if (!permission.granted) {
    return (
      <View style={[s.page, { flex: 1, justifyContent: 'center' }]}>
        <Text style={[s.body, { textAlign: 'center', marginBottom: 16 }]}>Pluma needs the camera to scan codes.</Text>
        <Button title="Allow camera" onPress={requestPermission} />
        <View style={{ height: 10 }} />
        <Button title="Back" kind="secondary" onPress={back} />
      </View>
    )
  }

  async function scanned({ data }) {
    if (busy.current) return
    busy.current = true
    const r = await onCode(data)
    if (r) {
      setResult(r)
      setTimeout(() => { setResult(null); busy.current = false }, 1800)
    } else {
      busy.current = false
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView style={{ flex: 1 }} facing="back" barcodeScannerSettings={{ barcodeTypes: ['qr'] }} onBarcodeScanned={scanned} />
      <View style={s.scanTop}>
        <Pressable onPress={back}><Text style={[s.back, { color: '#fff' }]}>‹ Done</Text></Pressable>
        <Text style={[s.h2, { color: '#fff' }]}>{title}</Text>
        {!!hint && <Text style={{ color: '#ddd' }}>{hint}</Text>}
      </View>
      {result && (
        <View style={[s.scanResult, { backgroundColor: result.ok ? '#0a7d32' : '#b42318' }]}>
          <Text style={s.scanResultText}>{result.ok ? '✓' : '✕'}</Text>
          <Text style={[s.h2, { color: '#fff', textAlign: 'center' }]}>{result.text}</Text>
        </View>
      )}
    </View>
  )
}

const SCAN_REASONS = {
  'already-checked-in': 'Already checked in',
  revoked: 'Ticket was cancelled',
  'expired-code': 'Old code — ask them to open the app',
  'not-holder': 'Copied ticket — not their phone',
  forged: 'Not a valid ticket',
  'wrong-event': 'Ticket for a different event',
  unreadable: 'Not a Pluma ticket',
  'event-not-synced': 'Event not loaded on this phone yet'
}

// ---------- app shell ----------

export default function App() {
  const [stack, setStack] = useState([{ name: 'home' }])
  const screen = stack[stack.length - 1]
  const go = (name, params = {}) => setStack((st) => [...st, { name, ...params }])
  const back = () => setStack((st) => (st.length > 1 ? st.slice(0, -1) : st))
  const asked = useRef(false)
  const depth = useRef(1)
  depth.current = stack.length

  // Android's Back button steps back through screens; it leaves the app only from home.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (depth.current <= 1) return false
      setStack((st) => st.slice(0, -1))
      return true
    })
    return () => sub.remove()
  }, [])

  // Invites: deep links, plus the clipboard on first open (how links survive an app install).
  useEffect(() => {
    const openUrl = (url) => { const m = LINK_RE.exec(url || ''); if (m) go('event', { link: m[0] }) }
    Linking.getInitialURL().then(openUrl)
    const sub = Linking.addEventListener('url', ({ url }) => openUrl(url))

    const checkClipboard = async () => {
      if (asked.current) return
      asked.current = true
      const text = await Clipboard.getStringAsync().catch(() => '')
      const m = LINK_RE.exec(text || '')
      if (!m) return
      const mine = (await call('events')).some((e) => e.link === m[0])
      if (!mine) Alert.alert('Open your invite?', 'We found an event invite you copied.', [{ text: 'Not now' }, { text: 'Open', onPress: () => go('event', { link: m[0] }) }])
    }
    checkClipboard()
    const appSub = AppState.addEventListener('change', (st) => { if (st === 'active') { asked.current = false; checkClipboard() } })
    return () => { sub.remove(); appSub.remove() }
  }, [])

  let body
  if (screen.name === 'home') body = <Home go={go} />
  else if (screen.name === 'create') body = <Create go={(n, p) => setStack([{ name: 'home' }, { name: n, ...p }])} back={back} />
  else if (screen.name === 'edit') body = <Create link={screen.link} info={screen.info} back={back} go={go} />
  else if (screen.name === 'event') body = <Event key={screen.link} link={screen.link} justCreated={screen.justCreated} back={back} go={go} />
  else if (screen.name === 'scanInvite') {
    body = <Scanner title="Scan an invite" hint="Point at the host’s invite code" back={back} onCode={async (data) => {
      const m = LINK_RE.exec(data)
      if (!m) return { ok: false, text: 'Not a Pluma invite' }
      setStack((st) => [...st.slice(0, -1), { name: 'event', link: m[0] }])
      return null
    }} />
  } else if (screen.name === 'scanTickets') {
    body = <Scanner title="Check in" hint="Works offline" back={back} onCode={async (data) => {
      const r = await call('scan', screen.link, data)
      return r.ok ? { ok: true, text: r.name ? `Welcome, ${r.name}` : 'Valid ticket' } : { ok: false, text: (SCAN_REASONS[r.reason] || r.reason) + (r.name ? ` — ${r.name}` : '') }
    }} />
  } else if (screen.name === 'scanHelper') {
    body = <Scanner title="Add a helper" hint="Scan the code on their phone" back={back} onCode={async (data) => {
      if (!data.startsWith(JOIN_PREFIX)) return { ok: false, text: 'Not a helper code' }
      const req = JSON.parse(data.slice(JOIN_PREFIX.length))
      return new Promise((resolve) => Alert.alert('What can they do?', '', [
        { text: 'Check-in only', onPress: async () => { await call('addHelper', screen.link, req, 'scanner'); resolve({ ok: true, text: 'Door helper added' }) } },
        { text: 'Co-host (full access)', onPress: async () => { await call('addHelper', screen.link, req, 'manager'); resolve({ ok: true, text: 'Co-host added' }) } },
        { text: 'Cancel', style: 'cancel', onPress: () => resolve(null) }
      ]))
    }} />
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#f6f5fb', paddingTop: StatusBar.currentHeight || 0 }}>
      <StatusBar barStyle="dark-content" />
      {body}
    </View>
  )
}

const s = StyleSheet.create({
  page: { padding: 20, paddingTop: 16, paddingBottom: 60 },
  h1: { fontSize: 30, fontWeight: '700', color: '#1a1a2e', marginBottom: 6 },
  h2: { fontSize: 20, fontWeight: '600', color: '#1a1a2e', marginTop: 24, marginBottom: 8 },
  body: { fontSize: 16, color: '#222', marginBottom: 4 },
  muted: { fontSize: 14, color: '#6b6b80' },
  label: { fontSize: 13, fontWeight: '600', color: '#555', marginBottom: 6 },
  back: { fontSize: 17, color: ACCENT, marginBottom: 12 },
  input: { backgroundColor: '#fff', borderRadius: 10, borderWidth: 1, borderColor: '#ddd', padding: 12, fontSize: 16, color: '#111' },
  btn: { backgroundColor: ACCENT, borderRadius: 12, paddingVertical: 15, alignItems: 'center' },
  btnSecondary: { backgroundColor: '#ece8ff' },
  btnDanger: { backgroundColor: '#b42318' },
  btnText: { color: '#fff', fontSize: 17, fontWeight: '600' },
  card: { backgroundColor: '#fff', borderRadius: 14, padding: 16, marginTop: 14, gap: 4 },
  cardTitle: { fontSize: 17, fontWeight: '600', color: '#1a1a2e', marginBottom: 6 },
  tag: { marginTop: 6, color: ACCENT, fontWeight: '600' },
  status: { fontSize: 17, fontWeight: '600', color: '#1a1a2e', marginBottom: 8 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 },
  segment: { flexDirection: 'row', backgroundColor: '#ece8ff', borderRadius: 10, padding: 3 },
  segmentItem: { flex: 1, paddingVertical: 9, alignItems: 'center', borderRadius: 8 },
  segmentActive: { backgroundColor: ACCENT },
  segmentText: { color: ACCENT, fontWeight: '600', fontSize: 13 },
  guest: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, borderTopColor: '#eee', gap: 8 },
  action: { color: ACCENT, fontWeight: '600', padding: 4 },
  option: { borderWidth: 1, borderColor: '#ddd', borderRadius: 10, padding: 12, marginBottom: 8, backgroundColor: '#fff' },
  optionActive: { borderColor: ACCENT, backgroundColor: '#f3f0ff' },
  chip: { borderWidth: 1, borderColor: ACCENT, borderRadius: 18, paddingHorizontal: 14, paddingVertical: 8 },
  chipActive: { backgroundColor: ACCENT },
  chipText: { color: ACCENT, fontWeight: '600' },
  small: { color: '#b42318', fontWeight: '600', padding: 6 },
  scanTop: { position: 'absolute', top: 0, left: 0, right: 0, padding: 20, backgroundColor: 'rgba(0,0,0,0.45)' },
  scanResult: { position: 'absolute', left: 30, right: 30, bottom: 80, borderRadius: 18, padding: 20, alignItems: 'center' },
  scanResultText: { fontSize: 64, color: '#fff', fontWeight: '700' }
})
