const $ = s => document.querySelector(s)
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n }

let S = {}                 // settings
let sources = []
let picked = null
let rec = null             // MediaRecorder
let stream = null          // what we record (video + merged audio)
let raw = []               // tracks/contexts to tear down
let micTrack = null
let chunks = []
let t0 = 0, paused = 0, pausedAt = 0, tick = null
let penOn = false
let lastFile = null
let region = null          // {x,y,width,height,display:{width,height}} — null = whole source

const toast = msg => {
  const t = $('#toast')
  t.textContent = msg
  t.classList.add('on')
  clearTimeout(toast._t)
  toast._t = setTimeout(() => t.classList.remove('on'), 2600)
}
const fmt = ms => {
  const s = Math.floor(ms / 1000)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
const mb = b => (b / 1048576).toFixed(1) + ' MB'

// ---------- sources ----------

async function loadSources() {
  sources = await window.api.sources()
  const box = $('#sources')
  box.innerHTML = ''

  const section = (title, list) => {
    if (!list.length) return
    box.append(el('div', 'group-label', title))
    const g = el('div', 'grid')
    list.forEach(s => {
      const c = el('div', 'card')
      c.dataset.id = s.id
      c.append(Object.assign(new Image(), { className: 'shot', src: s.thumb }))
      const m = el('div', 'meta')
      if (s.icon) m.append(Object.assign(new Image(), { src: s.icon }))
      m.append(el('span', '', s.name))
      c.append(m, el('div', 'tick', '&#10003;'))
      c.onclick = () => pick(s.id)
      g.append(c)
    })
    box.append(g)
  }
  section('Screens', sources.filter(s => s.isScreen))
  section('Windows', sources.filter(s => !s.isScreen))

  if (picked && !sources.some(s => s.id === picked)) picked = null
  if (!picked) picked = (sources.find(s => s.isScreen) || {}).id || null
  pick(picked)
  renderRegion()
}

function pick(id) {
  picked = id
  const src = sources.find(s => s.id === id)
  // a region is defined in one screen's coordinates, so it can't survive a source change
  if (region && (!src || !src.isScreen)) { region = null; renderRegion() }
  document.querySelectorAll('.card').forEach(c => c.classList.toggle('sel', c.dataset.id === id))
  $('#btn-rec').disabled = !id
  const screenPicked = !!(src && src.isScreen)
  $('#btn-region').disabled = !screenPicked
  $('#btn-region').title = screenPicked ? '' : 'Pick a screen to select an area'
}

function renderRegion() {
  const chip = $('#region-chip')
  chip.classList.toggle('on', !!region)
  $('#btn-region').classList.toggle('on', !!region)
  if (region) $('#region-dims').textContent = `${region.width} × ${region.height}`
}

async function chooseRegion() {
  const src = sources.find(s => s.id === picked)
  if (!src || !src.isScreen) return
  const r = await window.api.pickRegion(src.displayId)
  if (r) { region = r; renderRegion() }
}

// ---------- region crop ----------

// getDisplayMedia can't crop to an arbitrary screen rect, so for a region we pump
// the full-screen track through a canvas and record that instead. Only used when a
// region is set — full screen and window capture stay on the direct path.
const even = n => Math.max(2, Math.round(n / 2) * 2)

async function cropStream(track, region, fps) {
  const v = Object.assign(document.createElement('video'), { muted: true, playsInline: true })
  v.srcObject = new MediaStream([track])
  await v.play()
  if (!v.videoWidth) await new Promise(r => (v.onloadedmetadata = r))

  // the captured frame may not be 1:1 with screen coords (HiDPI), so rescale the rect
  const sx = v.videoWidth / region.display.width
  const sy = v.videoHeight / region.display.height
  const c = Object.assign(document.createElement('canvas'), {
    width: even(region.width * sx),
    height: even(region.height * sy),
  })
  const ctx = c.getContext('2d', { alpha: false })
  const src = [region.x * sx, region.y * sy, region.width * sx, region.height * sy]

  let live = true
  // requestVideoFrameCallback fires per captured frame — no duplicate draws, and it
  // keeps running while the main window is hidden (rAF does not).
  const pump = () => {
    if (!live) return
    ctx.drawImage(v, ...src, 0, 0, c.width, c.height)
    v.requestVideoFrameCallback(pump)
  }
  v.requestVideoFrameCallback(pump)

  return {
    stream: c.captureStream(fps),
    stop: () => { live = false; try { v.pause(); v.srcObject = null } catch {} },
  }
}

// ---------- audio ----------

async function buildStream() {
  const ok = await window.api.arm(picked)
  if (!ok) throw new Error('That source disappeared. Refresh and pick again.')

  const display = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: S.fps, cursor: S.showCursor ? 'always' : 'never' },
    audio: S.systemAudio,
  })
  raw.push(...display.getTracks())

  let mic = null
  if (S.micEnabled) {
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: S.micId === 'default' ? undefined : { exact: S.micId },
          // WebRTC's denoiser targets steady noise (fans, hiss, hum) and keeps
          // speech and transients like key clicks. echoCancellation also stops
          // speaker output bleeding back in and double-tracking system audio.
          noiseSuppression: S.denoise,
          echoCancellation: S.denoise,
          autoGainControl: S.denoise,
        },
      })
      raw.push(...mic.getTracks())
      micTrack = mic.getAudioTracks()[0]
    } catch (e) {
      // A missing/busy mic must not kill the whole recording.
      toast('No mic available — recording without it')
      mic = null
    }
  }

  const sys = display.getAudioTracks()
  if (S.systemAudio && !sys.length) toast('System audio unavailable on this device')

  const parts = [...sys, ...(mic ? mic.getAudioTracks() : [])]

  let video = display.getVideoTracks()
  if (region) {
    const c = await cropStream(video[0], region, S.fps)
    raw.push({ stop: c.stop })
    video = c.stream.getVideoTracks()
  }
  const out = new MediaStream(video)

  if (parts.length === 1) {
    out.addTrack(parts[0])
  } else if (parts.length > 1) {
    // Two sources -> one track, so the file has a single mixed audio stream.
    const ctx = new AudioContext()
    const dest = ctx.createMediaStreamDestination()
    parts.forEach(t => ctx.createMediaStreamSource(new MediaStream([t])).connect(dest))
    out.addTrack(dest.stream.getAudioTracks()[0])
    raw.push({ stop: () => ctx.close() })
  }
  return out
}

function pickMime() {
  // For mp4 we record H.264 up front so the rewrap can stream-copy the video
  // instead of transcoding it. VP9 is better for webm: smaller at the same quality.
  const want = S.format === 'mp4'
    ? ['video/webm;codecs=h264,opus', 'video/webm;codecs=vp9,opus', 'video/webm']
    : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
  return want.find(m => MediaRecorder.isTypeSupported(m)) || ''
}

// ---------- record ----------

async function start() {
  if (rec || !picked) return
  $('#btn-rec').disabled = true
  try {
    stream = await buildStream()
  } catch (e) {
    $('#btn-rec').disabled = false
    return toast(e.message || 'Could not start capture')
  }

  await window.api.started()          // hides main window, spawns bar + overlay
  await countdown(S.countdown)

  chunks = []
  rec = new MediaRecorder(stream, { mimeType: pickMime(), videoBitsPerSecond: await window.api.bitrate() })
  rec.ondataavailable = e => e.data.size && chunks.push(e.data)
  rec.onstop = finish
  // The screen track ends if the user revokes the share from the OS.
  stream.getVideoTracks()[0].onended = () => rec && rec.state !== 'inactive' && stop()

  rec.start(1000)
  t0 = performance.now(); paused = 0
  tick = setInterval(pushState, 250)
  pushState()
}

const elapsed = () => (rec && rec.state === 'paused' ? pausedAt : performance.now()) - t0 - paused

function pushState() {
  window.api.barState({
    time: fmt(elapsed()),
    paused: rec ? rec.state === 'paused' : false,
    muted: micTrack ? !micTrack.enabled : true,
    hasMic: !!micTrack,
    pen: penOn,
  })
}

function countdown(n) {
  if (!n) return Promise.resolve()
  return new Promise(res => {
    let i = n
    const go = () => {
      window.api.pen.mode({ tool: 'off', countdown: i })
      if (i-- <= 0) return res()
      setTimeout(go, 1000)
    }
    go()
  })
}

function stop() {
  if (!rec || rec.state === 'inactive') return
  clearInterval(tick)
  rec.stop()
}

async function finish() {
  const ms = elapsed()
  raw.forEach(t => { try { t.stop() } catch { /* already gone */ } })
  raw = []; micTrack = null; stream = null
  const type = rec.mimeType || 'video/webm'
  rec = null
  penOn = false

  let blob = new Blob(chunks, { type })
  chunks = []

  // MediaRecorder omits the EBML Duration element -> <video> reports Infinity and
  // seeking breaks. Patch it before anything tries to play the file.
  try { blob = await fixDuration(blob, ms) } catch { /* keep the unpatched blob */ }

  await window.api.stopped()          // closes bar + overlay, reshows main

  if (!blob.size) return toast('Nothing was recorded')
  const { file, size, warning } = await window.api.save(await blob.arrayBuffer(), S.format)
  if (warning) toast(warning)
  lastFile = file

  $('#pv').src = 'file://' + file
  $('#pv-name').textContent = file.split(/[\\/]/).pop()
  $('#pv-meta').textContent = `${fmt(ms)} · ${mb(size)} · ${S.quality} quality`
  $('#preview').classList.add('on')
  $('#btn-rec').disabled = false
  loadSources()
}

function fixDuration(blob, ms) {
  const fn = window.ysFixWebmDuration
  if (!fn) return Promise.resolve(blob)
  const r = fn(blob, ms)                       // newer builds return a promise
  if (r && typeof r.then === 'function') return r
  return new Promise(res => fn(blob, ms, res)) // older builds are callback-style
}

// ---------- control bar + hotkeys ----------

window.api.onCtl(cmd => {
  if (!rec) return
  if (cmd === 'pause' && rec.state === 'recording') { pausedAt = performance.now(); rec.pause() }
  if (cmd === 'resume' && rec.state === 'paused') { paused += performance.now() - pausedAt; rec.resume() }
  if (cmd === 'stop') return stop()
  if ((cmd === 'mute' || cmd === 'unmute') && micTrack) micTrack.enabled = cmd === 'unmute'
  pushState()
})

window.api.onHotkey(k => {
  if (k === 'record') rec ? stop() : start()
  if (k === 'pause' && rec) window.api.ctl(rec.state === 'paused' ? 'resume' : 'pause')
  if (k === 'pen' && rec) { penOn = !penOn; window.api.pen.mode({ tool: penOn ? 'pen' : 'off' }); pushState() }
})

// the bar owns the pen UI while recording; keep our copy of the flag in sync
window.api.onState && window.api.onState(s => { if (s && 'pen' in s) penOn = s.pen })

// ---------- settings ----------

const QUALITY = [['high', 'High · 8 Mbps'], ['ultra', 'Ultra · 40 Mbps'], ['max', 'Max · 80 Mbps']]

async function renderSettings() {
  const mics = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audioinput')
  const f = $('#settings-form')
  f.innerHTML = ''

  const row = (title, sub, ctrl) => {
    const r = el('div', 'row')
    r.append(el('div', 'lbl', `<b>${title}</b><small>${sub}</small>`), ctrl)
    f.append(r)
    return ctrl
  }
  const sel = (opts, val, on) => {
    const s = el('select')
    // compare as strings — option values are always strings once in the DOM,
    // so a raw === against a number silently selects nothing.
    opts.forEach(([v, t]) => s.append(new Option(t, v, false, String(v) === String(val))))
    s.onchange = () => on(s.value)
    return s
  }
  const sw = (val, on) => {
    const w = el('label', 'sw')
    const i = Object.assign(document.createElement('input'), { type: 'checkbox', checked: val })
    i.onchange = () => on(i.checked)
    w.append(i, el('i'))
    return w
  }
  const set = p => window.api.settings.set(p).then(n => { S = n; syncFooter() })
  const K = (node, k) => { node.dataset.k = k; return node }

  row('Format', 'mp4 plays everywhere; webm is smaller at the same quality',
    K(sel([['mp4', 'mp4 · H.264'], ['webm', 'webm · VP9']], S.format, v => set({ format: v })), 'format'))
  row('Quality', 'Higher bitrate = sharper text, bigger files',
    K(sel(QUALITY, S.quality, v => set({ quality: v })), 'quality'))
  row('Frame rate', 'Smoothness of motion and scrolling',
    K(sel([[30, '30 fps'], [60, '60 fps']], String(S.fps), v => set({ fps: +v })), 'fps'))
  row('Microphone', 'Voice track mixed into the recording', K(sel(
    [['default', 'System default'], ...mics.map(d => [d.deviceId, d.label || 'Microphone'])],
    S.micId, v => set({ micId: v })), 'micId'))
  row('Clean up mic audio', 'Filters fans, hiss and room hum — keeps voice and clicks', sw(S.denoise, v => set({ denoise: v })))
  row('System audio', window.api.platform === 'darwin'
    ? 'macOS needs a loopback device (e.g. BlackHole) selected as the mic'
    : 'Records what you hear', sw(S.systemAudio, v => set({ systemAudio: v })))
  row('Show cursor', 'Include the mouse pointer in the video', sw(S.showCursor, v => set({ showCursor: v })))
  row('Countdown', 'Delay before recording actually starts',
    K(sel([[0, 'Off'], [3, '3 seconds'], [5, '5 seconds']], String(S.countdown), v => set({ countdown: +v })), 'countdown'))

  const dir = el('button', 'btn', 'Change…')
  dir.onclick = async () => { const d = await window.api.pickDir(); if (d) { await set({ saveDir: d }); renderSettings() } }
  row('Save to', S.saveDir, dir)

  const hk = (key, label) => {
    const i = Object.assign(el('input'), { type: 'text', value: S.hotkeys[key] })
    i.onchange = () => set({ hotkeys: { ...S.hotkeys, [key]: i.value } }).then(syncFooter)
    row(label, 'Global shortcut — works while the app is hidden', i)
  }
  hk('record', 'Start / stop')
  hk('pause', 'Pause / resume')
  hk('pen', 'Toggle pen')

  if (window.api.platform === 'linux') {
    f.append(el('div', 'row', `<div class="lbl"><b>Note — Linux</b><small>X11 can't hide the control bar from a capture. Drag it out of the way, or press the pen hotkey to hide it.</small></div>`))
  }
}

function syncFooter() {
  $('#t-mic').classList.toggle('on', S.micEnabled)
  $('#t-sys').classList.toggle('on', S.systemAudio)
  $('#kbd-rec').textContent = (S.hotkeys.record || '').replace('CommandOrControl', window.api.platform === 'darwin' ? '⌘' : 'Ctrl')
}

// ---------- wiring ----------

document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x === b))
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('on', p.id === 'pane-' + b.dataset.tab))
  if (b.dataset.tab === 'settings') renderSettings()
})

$('#btn-rec').onclick = start
$('#btn-region').onclick = chooseRegion
$('#region-clear').onclick = () => { region = null; renderRegion() }
$('#w-min').onclick = () => window.api.win.minimize()
$('#w-close').onclick = () => window.api.win.close()
if (window.api.platform === 'darwin') $('#wctl').classList.add('mac')
$('#t-mic').onclick = () => window.api.settings.set({ micEnabled: !S.micEnabled }).then(n => { S = n; syncFooter() })
$('#t-sys').onclick = () => window.api.settings.set({ systemAudio: !S.systemAudio }).then(n => { S = n; syncFooter() })

$('#pv-done').onclick = () => { $('#pv').src = ''; $('#preview').classList.remove('on') }
$('#pv-folder').onclick = () => window.api.file.reveal(lastFile)
$('#pv-del').onclick = async () => {
  $('#pv').src = ''
  await window.api.file.remove(lastFile)
  $('#preview').classList.remove('on')
  toast('Recording deleted')
}

;(async () => {
  S = await window.api.settings.get()
  syncFooter()
  // Labels for enumerateDevices stay blank until mic permission is granted once.
  try { (await navigator.mediaDevices.getUserMedia({ audio: true })).getTracks().forEach(t => t.stop()) } catch { /* no mic */ }
  await loadSources()
})()
