const $ = s => document.querySelector(s)
const el = (t, c, h) => { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n }
const clamp = (n, a, b) => Math.min(b, Math.max(a, n))
const tc = s => {
  s = Math.max(0, s)
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`
}

const v = $('#v')
const layer = $('#layer')

// The whole edit is this object. Preview renders it via DOM/CSS; export translates
// the same values into an ffmpeg filter graph, so what you see is what you get.
let D = null
const blank = src => ({
  src, dur: 0,
  trim: { a: 0, b: 0 },
  eq: { brightness: 1, contrast: 1, saturate: 1 },
  texts: [],
  blurs: [],
  music: null,   // { path, name, volume, duck }
})
let sel = null   // {kind:'text'|'blur', i}

// ---------- load ----------

async function load(src, name) {
  D = blank(src)
  v.src = 'file://' + src
  await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('Could not read that video')) })
  D.dur = v.duration
  D.trim.b = v.duration
  $('#fname').textContent = name || src.split(/[\\/]/).pop()
  $('#export').disabled = false
  sel = null
  v.currentTime = 0
  drawAll()
}

$('#open').onclick = async () => {
  const f = await window.api.ed.pickVideo()
  if (f) { try { await load(f) } catch (e) { alert(e.message) } }
}
$('#close').onclick = () => window.api.ed.close()

// ---------- preview ----------

function applyEq() {
  const { brightness, contrast, saturate } = D.eq
  v.style.filter = `brightness(${brightness}) contrast(${contrast}) saturate(${saturate})`
}

// text fade in/out — the "animation". Mirrored by ffmpeg's alpha fade on export.
const FADE = 0.35
function alphaAt(o, t) {
  if (t < o.from || t > o.to) return 0
  if (!o.fade) return 1
  return clamp(Math.min((t - o.from) / FADE, (o.to - t) / FADE), 0, 1)
}

function drawOverlays() {
  layer.innerHTML = ''
  const t = v.currentTime

  D.blurs.forEach((b, i) => {
    const n = el('div', 'blur-box' + (sel && sel.kind === 'blur' && sel.i === i ? ' sel-ring' : ' idle'))
    n.style.cssText += `left:${b.x}%;top:${b.y}%;width:${b.w}%;height:${b.h}%;--b:${b.strength}px`
    n.style.display = t >= b.from && t <= b.to ? 'block' : 'none'
    n.onmousedown = e => drag(e, n, b, 'blur', i)
    const h = el('div', 'handle'); h.onmousedown = e => resize(e, b, 'blur', i)
    n.append(h)
    layer.append(n)
  })

  D.texts.forEach((o, i) => {
    const n = el('div', 'txt' + (sel && sel.kind === 'text' && sel.i === i ? ' sel-ring' : ''), '')
    n.textContent = o.text
    n.style.cssText += `left:${o.x}%;top:${o.y}%;font-size:${o.size}px;color:${o.color};opacity:${alphaAt(o, t)}`
    if (alphaAt(o, t) === 0) n.style.pointerEvents = 'none'
    n.onmousedown = e => drag(e, n, o, 'text', i)
    layer.append(n)
  })
}

function drawClock() {
  $('#clock').textContent = `${tc(v.currentTime)} / ${tc(D ? D.dur : 0)}`
  const lane = $('#lane-v')
  $('#ph').style.left = (D && D.dur ? (v.currentTime / D.dur) * lane.clientWidth : 0) + 'px'
}

// ---------- drag / resize in the frame ----------

function pct(e) {
  const r = layer.getBoundingClientRect()
  return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100, r }
}
function drag(e, node, obj, kind, i) {
  e.preventDefault(); e.stopPropagation()
  select(kind, i)
  const s = pct(e), ox = obj.x, oy = obj.y
  const mv = m => {
    const p = pct(m)
    obj.x = clamp(ox + (p.x - s.x), 0, 98)
    obj.y = clamp(oy + (p.y - s.y), 0, 98)
    node.style.left = obj.x + '%'; node.style.top = obj.y + '%'
  }
  const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); drawSide() }
  addEventListener('mousemove', mv); addEventListener('mouseup', up)
}
function resize(e, b, kind, i) {
  e.preventDefault(); e.stopPropagation()
  select(kind, i)
  const s = pct(e), ow = b.w, oh = b.h
  const mv = m => {
    const p = pct(m)
    b.w = clamp(ow + (p.x - s.x), 3, 100 - b.x)
    b.h = clamp(oh + (p.y - s.y), 3, 100 - b.y)
    drawOverlays()
  }
  const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up) }
  addEventListener('mousemove', mv); addEventListener('mouseup', up)
}

// ---------- inspector ----------

function fld(label, node) { const f = el('div', 'fld'); f.append(el('label', '', label), node); return f }
function range(min, max, step, val, on) {
  const wrap = el('div', 'fld')
  const r = Object.assign(el('input'), { type: 'range', min, max, step, value: val })
  const out = el('span', 'val', (+val).toFixed(step < 1 ? 2 : 0))
  r.oninput = () => { out.textContent = (+r.value).toFixed(step < 1 ? 2 : 0); on(+r.value) }
  wrap.append(r, out)
  return { wrap, r }
}

function drawSide() {
  const s = $('#side')
  s.innerHTML = ''
  if (!D) { s.append(el('p', 'empty-note', 'Open a video to start editing.')); return }

  s.append(el('h4', '', 'Colour'))
  const eqRow = (name, key, min, max) => {
    const row = el('div', 'fld')
    row.append(el('label', '', name))
    const { wrap } = range(min, max, .05, D.eq[key], val => { D.eq[key] = val; applyEq() })
    row.append(...wrap.childNodes)
    s.append(row)
  }
  eqRow('Bright', 'brightness', .2, 2)
  eqRow('Contrast', 'contrast', .2, 2)
  eqRow('Saturate', 'saturate', 0, 2)
  const reset = el('button', 'btn', 'Reset colour')
  reset.onclick = () => { D.eq = { brightness: 1, contrast: 1, saturate: 1 }; applyEq(); drawSide() }
  s.append(reset)

  if (D.music) {
    s.append(el('h4', '', 'Music'))
    s.append(el('div', 'empty-note', D.music.name))
    const row = el('div', 'fld'); row.append(el('label', '', 'Volume'))
    const { wrap } = range(0, 1, .05, D.music.volume, val => (D.music.volume = val))
    row.append(...wrap.childNodes); s.append(row)
    const rm = el('button', 'btn danger', 'Remove music')
    rm.onclick = () => { D.music = null; drawSide(); drawTimeline() }
    s.append(rm)
  }

  if (!sel) { s.append(el('h4', '', 'Selection'), el('p', 'empty-note', 'Pick a text or blur block on the FX track, or add one below.')); return }
  const o = sel.kind === 'text' ? D.texts[sel.i] : D.blurs[sel.i]
  if (!o) { sel = null; return }

  s.append(el('h4', '', sel.kind === 'text' ? 'Text' : 'Blur'))
  if (sel.kind === 'text') {
    const i = Object.assign(el('input'), { type: 'text', value: o.text })
    i.oninput = () => { o.text = i.value; drawOverlays(); drawTimeline() }
    s.append(fld('Text', i))
    const sz = el('div', 'fld'); sz.append(el('label', '', 'Size'))
    sz.append(...range(12, 120, 1, o.size, val => { o.size = val; drawOverlays() }).wrap.childNodes)
    s.append(sz)
    const col = Object.assign(el('input'), { type: 'text', value: o.color })
    col.oninput = () => { o.color = col.value; drawOverlays() }
    s.append(fld('Colour', col))
    const fade = Object.assign(el('input'), { type: 'checkbox', checked: o.fade })
    fade.onchange = () => { o.fade = fade.checked; drawOverlays() }
    s.append(fld('Fade', fade))
  } else {
    const st = el('div', 'fld'); st.append(el('label', '', 'Strength'))
    st.append(...range(4, 60, 1, o.strength, val => { o.strength = val; drawOverlays() }).wrap.childNodes)
    s.append(st)
  }

  const time = el('div', 'fld')
  time.append(el('label', '', 'From'))
  const a = Object.assign(el('input'), { type: 'number', step: .1, min: 0, max: D.dur, value: o.from.toFixed(1) })
  a.onchange = () => { o.from = clamp(+a.value, 0, o.to - .1); drawTimeline(); drawOverlays() }
  time.append(a); s.append(time)
  const time2 = el('div', 'fld')
  time2.append(el('label', '', 'To'))
  const b = Object.assign(el('input'), { type: 'number', step: .1, min: 0, max: D.dur, value: o.to.toFixed(1) })
  b.onchange = () => { o.to = clamp(+b.value, o.from + .1, D.dur); drawTimeline(); drawOverlays() }
  time2.append(b); s.append(time2)

  const here = el('button', 'btn', 'Set range from playhead (3s)')
  here.onclick = () => {
    o.from = v.currentTime; o.to = Math.min(D.dur, v.currentTime + 3)
    drawTimeline(); drawOverlays(); drawSide()
  }
  const del = el('button', 'btn danger', 'Delete')
  del.onclick = () => {
    (sel.kind === 'text' ? D.texts : D.blurs).splice(sel.i, 1)
    sel = null; drawAll()
  }
  const btns = el('div', 'row-btns'); btns.append(here, del)
  s.append(btns)
}

const select = (kind, i) => { sel = { kind, i }; drawSide(); drawOverlays(); drawTimeline() }

// ---------- timeline ----------

function drawTimeline() {
  const laneV = $('#lane-v'), laneFx = $('#lane-fx'), laneA = $('#lane-a')
  const W = laneV.clientWidth
  const px = t => (D.dur ? (t / D.dur) * W : 0)

  // ruler
  const ruler = $('#ruler'); ruler.innerHTML = ''
  if (D.dur) {
    const step = D.dur <= 10 ? 1 : D.dur <= 60 ? 5 : D.dur <= 300 ? 30 : 60
    for (let t = 0; t <= D.dur; t += step) {
      const m = el('span', '', tc(t).slice(0, 5)); m.style.left = px(t) + 'px'; ruler.append(m)
    }
  }

  // video lane: clip + trim handles + shaded-out regions
  laneV.querySelectorAll('.clip,.trim,.shade').forEach(n => n.remove())
  const clip = el('div', 'clip'); clip.style.cssText = `left:0;width:${W}px`
  laneV.prepend(clip)
  const s1 = el('div', 'shade'); s1.style.cssText = `left:0;width:${px(D.trim.a)}px`
  const s2 = el('div', 'shade'); s2.style.cssText = `left:${px(D.trim.b)}px;right:0`
  laneV.append(s1, s2)
  const ha = el('div', 'trim a'); ha.style.left = px(D.trim.a) + 'px'
  const hb = el('div', 'trim b'); hb.style.left = (px(D.trim.b) - 10) + 'px'
  ha.onmousedown = e => trimDrag(e, 'a'); hb.onmousedown = e => trimDrag(e, 'b')
  laneV.append(ha, hb)

  // fx lane: text + blur blocks
  laneFx.innerHTML = ''
  // blurs and texts get their own row — overlapping time ranges would otherwise
  // stack on top of each other and the lower one becomes unclickable
  const put = (o, i, kind, label, row) => {
    const n = el('div', 'item' + (kind === 'blur' ? ' blur' : '') + (sel && sel.kind === kind && sel.i === i ? ' on' : ''), label)
    n.style.cssText += `left:${px(o.from)}px;width:${Math.max(18, px(o.to - o.from))}px;top:${row}px`
    n.title = label
    n.onmousedown = e => { e.stopPropagation(); select(kind, i); itemDrag(e, o) }
    laneFx.append(n)
  }
  D.blurs.forEach((o, i) => put(o, i, 'blur', 'blur', 3))
  D.texts.forEach((o, i) => put(o, i, 'text', o.text || 'text', 26))

  // music lane
  laneA.innerHTML = ''
  if (D.music) {
    const m = el('div', 'clip music'); m.style.cssText = `left:0;width:${W}px;border-radius:7px`
    laneA.append(m)
  }
  drawClock()
}

function laneT(e) {
  const r = $('#lane-v').getBoundingClientRect()
  return clamp(((e.clientX - r.left) / r.width) * D.dur, 0, D.dur)
}
function trimDrag(e, which) {
  e.preventDefault()
  const mv = m => {
    const t = laneT(m)
    if (which === 'a') D.trim.a = clamp(t, 0, D.trim.b - .2)
    else D.trim.b = clamp(t, D.trim.a + .2, D.dur)
    v.currentTime = which === 'a' ? D.trim.a : D.trim.b
    drawTimeline()
  }
  const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up) }
  addEventListener('mousemove', mv); addEventListener('mouseup', up)
}
function itemDrag(e, o) {
  e.preventDefault()
  const t0 = laneT(e), a0 = o.from, len = o.to - o.from
  const mv = m => {
    const d = laneT(m) - t0
    o.from = clamp(a0 + d, 0, D.dur - len)
    o.to = o.from + len
    drawTimeline(); drawOverlays()
  }
  const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); drawSide() }
  addEventListener('mousemove', mv); addEventListener('mouseup', up)
}

// scrub by clicking the video lane
$('#lane-v').onmousedown = e => {
  if (e.target.classList.contains('trim')) return
  v.currentTime = laneT(e)
  const mv = m => (v.currentTime = laneT(m))
  const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up) }
  addEventListener('mousemove', mv); addEventListener('mouseup', up)
}

// ---------- transport ----------

const PLAY = '<path d="M7 4l12 8-12 8V4z"/>'
const PAUSE = '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>'
$('#play').onclick = () => (v.paused ? v.play() : v.pause())
v.onplay = () => ($('#play-i').innerHTML = PAUSE)
v.onpause = () => ($('#play-i').innerHTML = PLAY)
v.ontimeupdate = () => { drawClock(); drawOverlays() }
// playback obeys the trim range, so preview matches the export
v.onseeking = () => { if (D && v.currentTime > D.trim.b + .05) v.currentTime = D.trim.b }
setInterval(() => {
  if (!D || v.paused) return
  if (v.currentTime >= D.trim.b) { v.pause(); v.currentTime = D.trim.b }
  if (v.currentTime < D.trim.a - .05) v.currentTime = D.trim.a
}, 80)

// ---------- add things ----------

$('#add-text').onclick = () => {
  if (!D) return
  D.texts.push({
    text: 'Your text', x: 34, y: 44, size: 44, color: '#ffffff', fade: true,
    from: v.currentTime, to: Math.min(D.dur, v.currentTime + 3),
  })
  select('text', D.texts.length - 1)
}
$('#add-blur').onclick = () => {
  if (!D) return
  D.blurs.push({
    x: 30, y: 30, w: 30, h: 20, strength: 16,
    from: v.currentTime, to: Math.min(D.dur, v.currentTime + 3),
  })
  select('blur', D.blurs.length - 1)
}
$('#add-music').onclick = async () => {
  if (!D) return
  const f = await window.api.ed.pickAudio()
  if (!f) return
  D.music = { path: f, name: f.split(/[\\/]/).pop(), volume: .5 }
  drawSide(); drawTimeline()
}

// ---------- export ----------

// Text is rasterised to a PNG and composited by ffmpeg, rather than using drawtext.
// That keeps fonts/emoji identical to the preview and avoids fontconfig in the AppImage.
function textPng(o) {
  const scale = v.videoHeight / layer.clientHeight   // preview px -> source px
  const size = o.size * scale
  const c = document.createElement('canvas')
  const ctx = c.getContext('2d')
  const font = `700 ${size}px Inter, system-ui, sans-serif`
  ctx.font = font
  const lines = String(o.text).split('\n')
  const wid = Math.max(...lines.map(l => ctx.measureText(l).width))
  const lh = size * 1.15
  c.width = Math.ceil(wid + size * 0.5)
  c.height = Math.ceil(lh * lines.length + size * 0.4)
  const x = ctx.getContext ? 0 : 0
  const c2 = c.getContext('2d')
  c2.font = font
  c2.textBaseline = 'top'
  c2.shadowColor = 'rgba(0,0,0,.5)'; c2.shadowBlur = size * 0.25; c2.shadowOffsetY = size * 0.05
  c2.fillStyle = o.color
  lines.forEach((l, i) => c2.fillText(l, size * 0.25, size * 0.2 + i * lh))
  return {
    data: c.toDataURL('image/png'),
    x: Math.round((o.x / 100) * v.videoWidth),
    y: Math.round((o.y / 100) * v.videoHeight),
    from: o.from, to: o.to, fade: o.fade,
  }
}

$('#export').onclick = async () => {
  if (!D) return
  const out = await window.api.ed.saveAs(D.src)
  if (!out) return
  $('#busy').classList.add('on')
  $('#busy-b').style.width = '8%'
  $('#busy-s').textContent = 'Preparing…'

  const job = {
    src: D.src, out,
    trim: { a: +D.trim.a.toFixed(3), b: +D.trim.b.toFixed(3) },
    eq: D.eq,
    w: v.videoWidth, h: v.videoHeight,
    blurs: D.blurs.map(b => ({
      x: Math.round((b.x / 100) * v.videoWidth), y: Math.round((b.y / 100) * v.videoHeight),
      w: Math.round((b.w / 100) * v.videoWidth), h: Math.round((b.h / 100) * v.videoHeight),
      strength: b.strength, from: b.from, to: b.to,
    })),
    texts: D.texts.map(textPng),
    music: D.music,
    fade: FADE,
  }
  const off = window.api.ed.onProgress(p => {
    $('#busy-b').style.width = clamp(p.pct, 5, 99) + '%'
    $('#busy-s').textContent = p.label || ''
  })
  const r = await window.api.ed.export(job)
  off && off()
  $('#busy-b').style.width = '100%'
  setTimeout(() => $('#busy').classList.remove('on'), 350)
  if (r.ok) window.api.ed.reveal(r.file)
  else alert('Export failed:\n' + r.error)
}

// ---------- boot ----------

function drawAll() { applyEq(); drawTimeline(); drawOverlays(); drawSide() }
addEventListener('resize', () => D && drawTimeline())
window.api.ed.onOpen(async f => { try { await load(f) } catch (e) { alert(e.message) } })
drawSide()
