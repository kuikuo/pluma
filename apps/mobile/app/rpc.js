// UI side of the worklet bridge: newline-delimited JSON over IPC.
import { Worklet } from 'react-native-bare-kit'
import { Paths } from 'expo-file-system'
import b4a from 'b4a'
import bundle from './worklet.bundle.js'

const worklet = new Worklet()
const dir = decodeURIComponent(Paths.document.uri.replace(/^file:\/\//, '')).replace(/\/$/, '')
worklet.start('/app.bundle', bundle, [dir])

const pending = new Map()
const listeners = new Set()
let nextId = 1
let buffered = ''

worklet.IPC.on('data', (data) => {
  buffered += b4a.toString(data)
  let i
  while ((i = buffered.indexOf('\n')) !== -1) {
    const msg = JSON.parse(buffered.slice(0, i))
    buffered = buffered.slice(i + 1)
    if (msg.event) {
      for (const fn of listeners) fn(msg)
      continue
    }
    const p = pending.get(msg.id)
    if (!p) continue
    pending.delete(msg.id)
    if (msg.error) p.reject(new Error(msg.error))
    else p.resolve(msg.result)
  }
})

export function call(method, ...args) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    worklet.IPC.write(b4a.from(JSON.stringify({ id, method, args }) + '\n'))
  })
}

export function onEvent(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}
