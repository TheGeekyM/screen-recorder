const { app, BrowserWindow, desktopCapturer, session, ipcMain, globalShortcut, screen, shell, dialog, Menu } = require('electron')
const fs = require('fs')
const path = require('path')

// ponytail: plain JSON file instead of electron-store — it's a read and a write.
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json')
const DEFAULTS = {
  quality: 'ultra',            // high | ultra | max
  fps: 60,
  micId: 'default',
  systemAudio: true,
  micEnabled: true,
  denoise: true,               // suppress steady background noise on the mic
  saveDir: app.getPath('videos'),
  countdown: 3,
  showCursor: true,
  hotkeys: { record: 'CommandOrControl+Shift+R', pause: 'CommandOrControl+Shift+P', pen: 'CommandOrControl+Shift+D' },
}
const BITRATES = { high: 8e6, ultra: 40e6, max: 80e6 }

let settings = { ...DEFAULTS }
const loadSettings = () => {
  try { settings = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8')) } } catch { /* first run */ }
}
const saveSettings = () => fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2))

let mainWin, barWin, overlayWin
let selectedSource = null   // set before recording; read by the display-media handler
let hoverTimer = null

// ---------- windows ----------

function createMain() {
  mainWin = new BrowserWindow({
    width: 940, height: 680, minWidth: 820, minHeight: 560,
    show: false,
    backgroundColor: '#0d0e12',
    // Own header instead of the OS chrome; macOS keeps its traffic lights.
    frame: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false, // recording runs here while the window is hidden
    },
  })
  mainWin.loadFile(path.join(__dirname, 'ui', 'index.html'))
  mainWin.once('ready-to-show', () => mainWin.show())
  mainWin.on('closed', () => { mainWin = null; closeBar(); closeOverlay() })
}

function createBar() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize
  // Sized to the pill; the renderer re-measures whenever the pen toolbar opens.
  // A transparent window still swallows clicks, so any slack here would become an
  // invisible dead zone the pen can't draw on.
  const W = 340, H = 52
  barWin = new BrowserWindow({
    width: W, height: H, x: Math.round((width - W) / 2), y: height - H - 16,
    frame: false, transparent: true, resizable: false, movable: true,
    alwaysOnTop: true, skipTaskbar: true, fullscreenable: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  barWin.setAlwaysOnTop(true, 'screen-saver')
  barWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  // Hides the bar from the recording on Windows/macOS. Verified no-op on Linux/X11,
  // where the bar is draggable + hotkey-hideable instead.
  // ponytail: not building a canvas-crop pipeline for the Linux case; that's the
  // upgrade path if the sliver/hotkey turns out not to be good enough.
  barWin.setContentProtection(true)

  barWin.loadFile(path.join(__dirname, 'ui', 'bar.html'))
  return barWin
}
const closeBar = () => { barWin && !barWin.isDestroyed() && barWin.close(); barWin = null }

function createOverlay() {
  const d = screen.getPrimaryDisplay()
  overlayWin = new BrowserWindow({
    ...d.bounds,
    frame: false, transparent: true, resizable: false, movable: false,
    alwaysOnTop: true, skipTaskbar: true, focusable: false,
    hasShadow: false, enableLargerThanScreen: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  })
  overlayWin.setAlwaysOnTop(true, 'screen-saver')
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  overlayWin.setIgnoreMouseEvents(true, { forward: true }) // click-through until the pen is armed
  overlayWin.loadFile(path.join(__dirname, 'ui', 'overlay.html'))
  return overlayWin
}
const closeOverlay = () => {
  clearInterval(hoverTimer); hoverTimer = null
  overlayWin && !overlayWin.isDestroyed() && overlayWin.close()
  overlayWin = null
}

// An armed pen makes the overlay grab the whole screen, which would bury the
// control bar. Window stacking alone doesn't save us on X11, so hand the mouse
// back whenever the cursor is over the bar.
function trackBarHover(armed) {
  clearInterval(hoverTimer)
  hoverTimer = null
  if (!armed) return
  let over = null
  hoverTimer = setInterval(() => {
    if (!overlayWin || overlayWin.isDestroyed() || !barWin || barWin.isDestroyed()) return
    const p = screen.getCursorScreenPoint()
    const b = barWin.getBounds()
    const now = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height
    if (now === over) return
    over = now
    overlayWin.setIgnoreMouseEvents(now, { forward: true })
    // don't strand a half-drawn stroke when the mouse is taken away mid-drag
    if (now) { toOverlay('endstroke'); barWin.moveTop() }
  }, 60)
}

const toMain = (ch, ...a) => mainWin && !mainWin.isDestroyed() && mainWin.webContents.send(ch, ...a)
const toBar = (ch, ...a) => barWin && !barWin.isDestroyed() && barWin.webContents.send(ch, ...a)
const toOverlay = (ch, ...a) => overlayWin && !overlayWin.isDestroyed() && overlayWin.webContents.send(ch, ...a)

// ---------- app ----------

app.whenReady().then(() => {
  loadSettings()
  Menu.setApplicationMenu(null)

  session.defaultSession.setDisplayMediaRequestHandler((req, cb) => {
    if (!selectedSource) return cb({})
    // 'loopback' = system audio. Works on Windows and Linux/PulseAudio; macOS has no
    // loopback device, so system audio there needs BlackHole et al. selected as the mic.
    cb({ video: selectedSource, audio: settings.systemAudio ? 'loopback' : undefined })
  }, { useSystemPicker: false })

  createMain()
  registerHotkeys()

  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createMain())
})

app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit())
app.on('will-quit', () => globalShortcut.unregisterAll())

function registerHotkeys() {
  globalShortcut.unregisterAll()
  const bind = (accel, fn) => { try { accel && globalShortcut.register(accel, fn) } catch { /* bad accelerator */ } }
  const { record, pause, pen } = settings.hotkeys
  bind(record, () => toMain('hotkey', 'record'))
  bind(pause, () => toMain('hotkey', 'pause'))
  bind(pen, () => toMain('hotkey', 'pen'))
}

// ---------- ipc ----------

ipcMain.handle('settings:get', () => settings)
ipcMain.handle('settings:set', (e, patch) => {
  settings = { ...settings, ...patch }
  saveSettings()
  registerHotkeys()
  return settings
})

ipcMain.handle('sources:list', async () => {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  })
  return sources.map(s => ({
    id: s.id,
    name: s.name,
    isScreen: s.id.startsWith('screen:'),
    displayId: s.display_id || null,
    thumb: s.thumbnail.toDataURL(),
    icon: s.appIcon ? s.appIcon.toDataURL() : null,
  }))
})

// ---------- region selection ----------

let selectWin = null
let regionResolve = null

const displayFor = id =>
  screen.getAllDisplays().find(d => String(d.id) === String(id)) || screen.getPrimaryDisplay()

ipcMain.handle('region:pick', (e, displayId) => {
  if (selectWin) return null
  const d = displayFor(displayId)
  const wasVisible = mainWin && mainWin.isVisible()
  if (wasVisible) mainWin.hide()   // get the picker out of the way of its own selection

  return new Promise(resolve => {
    regionResolve = r => {
      resolve(r && { ...r, display: { width: d.bounds.width, height: d.bounds.height } })
      if (wasVisible && mainWin && !mainWin.isDestroyed()) { mainWin.show(); mainWin.focus() }
    }
    selectWin = new BrowserWindow({
      ...d.bounds,
      frame: false, transparent: true, resizable: false, movable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, enableLargerThanScreen: true,
      webPreferences: { preload: path.join(__dirname, 'preload.js') },
    })
    selectWin.setAlwaysOnTop(true, 'screen-saver')
    selectWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    selectWin.loadFile(path.join(__dirname, 'ui', 'select.html'))
    selectWin.once('ready-to-show', () => selectWin.focus())
    // closing the window by any other route must still settle the promise
    selectWin.on('closed', () => {
      selectWin = null
      if (regionResolve) { const r = regionResolve; regionResolve = null; r(null) }
    })
  })
})

ipcMain.handle('region:done', (e, rect) => {
  const done = regionResolve
  regionResolve = null
  if (selectWin && !selectWin.isDestroyed()) selectWin.close()
  selectWin = null
  done && done(rect)
})

// The renderer only ever holds an id; the real source object stays in main.
ipcMain.handle('rec:arm', async (e, sourceId) => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } })
  selectedSource = sources.find(s => s.id === sourceId) || null
  return !!selectedSource
})

ipcMain.handle('rec:started', () => {
  mainWin && mainWin.hide()
  // Overlay first, bar second: same always-on-top level, so creation order decides
  // stacking. The bar must stay above, or an armed pen eats its clicks.
  createOverlay()
  createBar()
})

ipcMain.handle('rec:stopped', () => {
  closeBar()
  closeOverlay()
  selectedSource = null
  if (mainWin) { mainWin.show(); mainWin.focus() }
})

ipcMain.handle('rec:save', (e, buf, ext) => {
  const dir = settings.saveDir
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const file = path.join(dir, `recording-${stamp}.${ext || 'webm'}`)
  fs.writeFileSync(file, Buffer.from(buf))
  return { file, size: fs.statSync(file).size }
})

ipcMain.handle('win:minimize', () => mainWin && mainWin.minimize())
ipcMain.handle('win:close', () => mainWin && mainWin.close())

ipcMain.handle('file:reveal', (e, f) => shell.showItemInFolder(f))
ipcMain.handle('file:open', (e, f) => shell.openPath(f))
ipcMain.handle('file:delete', (e, f) => { try { fs.unlinkSync(f); return true } catch { return false } })
ipcMain.handle('dir:pick', async () => {
  const r = await dialog.showOpenDialog(mainWin, { properties: ['openDirectory', 'createDirectory'], defaultPath: settings.saveDir })
  return r.canceled ? null : r.filePaths[0]
})

ipcMain.handle('cfg:bitrate', () => BITRATES[settings.quality] || BITRATES.ultra)

// bar -> recorder
for (const cmd of ['pause', 'resume', 'stop', 'mute', 'unmute']) {
  ipcMain.handle(`ctl:${cmd}`, () => toMain('ctl', cmd))
}
// recorder -> bar (timer, state)
ipcMain.handle('bar:state', (e, s) => toBar('state', s))

// The bar keeps its window glued to its visible content, anchored bottom-centre
// wherever the user dragged it.
ipcMain.handle('bar:size', (e, w, h) => {
  if (!barWin || barWin.isDestroyed()) return
  const b = barWin.getBounds()
  const cx = b.x + b.width / 2
  const bottom = b.y + b.height
  barWin.setBounds({ x: Math.round(cx - w / 2), y: Math.round(bottom - h), width: w, height: h })
})

// pen
ipcMain.handle('pen:mode', (e, mode) => {
  if (!overlayWin) return
  // Click-through unless a drawing tool is armed. The laser follows the OS cursor,
  // so it stays click-through too.
  const grabs = ['pen', 'marker', 'arrow', 'rect'].includes(mode.tool)
  overlayWin.setIgnoreMouseEvents(!grabs, { forward: true })
  // re-assert stacking: an armed pen must never end up above the controls
  if (barWin && !barWin.isDestroyed()) barWin.moveTop()
  trackBarHover(grabs)
  toOverlay('mode', mode)
})
ipcMain.handle('pen:clear', () => toOverlay('clear'))
ipcMain.handle('cursor:pos', () => screen.getCursorScreenPoint())
ipcMain.handle('overlay:bounds', () => (overlayWin ? overlayWin.getBounds() : screen.getPrimaryDisplay().bounds))

// ponytail: env-guarded smoke hook instead of a test harness — drives one real
// recording so `npm run smoke` fails if capture, the bar, the overlay, or the
// duration patch break. Nothing here runs unless SMOKE is set.
if (process.env.SMOKE) {
  const sleep = ms => new Promise(r => setTimeout(r, ms))
  // Electron can dump core while tearing down software GL, so the verdict is a
  // printed line rather than an exit code. `npm run smoke` greps for it.
  const done = (ok, why) => { console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL: ' + why); app.exit(ok ? 0 : 1) }
  app.whenReady().then(() => {
    mainWin.webContents.once('did-finish-load', async () => {
      const js = s => mainWin.webContents.executeJavaScript(s)
      try {
        await sleep(1500)

        // settings form must reflect the real values, not silently fall back to option 0
        const st = JSON.parse(await js(`(async () => {
          document.querySelector('[data-tab=settings]').click()
          await new Promise(r => setTimeout(r, 600))
          const v = [...document.querySelectorAll('#settings-form select')].map(s => s.value)
          document.querySelector('[data-tab=record]').click()
          return JSON.stringify({ v, quality: S.quality, fps: S.fps, countdown: S.countdown })
        })()`))
        const want = [String(st.quality), String(st.fps), String(st.countdown)]
        const got = [st.v[0], st.v[1], st.v[3]]
        const ok = want.every((w, i) => w === got[i])
        console.log(`SMOKE settings ${ok ? 'ok' : 'MISMATCH'} want=${want} got=${got}`)
        if (!ok) return done(false, 'settings form does not reflect stored values')

        // region crop: the canvas must come out at exactly the requested size
        const crop = JSON.parse(await js(`(async () => {
          await window.api.arm(picked)
          const d = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 } })
          const c = await cropStream(d.getVideoTracks()[0],
            { x: 100, y: 80, width: 640, height: 360, display: { width: screen.width, height: screen.height } }, 30)
          await new Promise(r => setTimeout(r, 600))
          const s = c.stream.getVideoTracks()[0].getSettings()
          c.stop(); d.getTracks().forEach(t => t.stop())
          return JSON.stringify(s)
        })()`))
        console.log(`SMOKE crop ${crop.width}x${crop.height}`)
        if (crop.width !== 640 || crop.height !== 360) {
          return done(false, `region crop produced ${crop.width}x${crop.height}, expected 640x360`)
        }

        await js('S.countdown = 0')
        // SMOKE_REGION=1 records through the crop pipeline instead of the direct path
        if (process.env.SMOKE_REGION) {
          await js('region = { x: 100, y: 80, width: 640, height: 360, display: { width: screen.width, height: screen.height } }')
          console.log('SMOKE recording via region crop')
        }
        console.log('SMOKE source=' + (await js('picked')))
        await js('start()')
        await sleep(4000)
        console.log('SMOKE bar=' + !!barWin + ' overlay=' + !!overlayWin)
        await js('window.api.pen.mode({tool:"pen",color:"#ff0000",size:4,fade:true})')
        await js('stop()')
        for (let i = 0; i < 30 && !(await js('lastFile')); i++) await sleep(500)
        const f = await js('lastFile')
        console.log('SMOKE file=' + f)
        console.log('SMOKE bar_closed=' + !barWin + ' overlay_closed=' + !overlayWin)
        if (!f) return done(false, 'no file was written')
        const { size } = fs.statSync(f)
        if (size < 10000) return done(false, `file is suspiciously small (${size}b)`)
        // the duration patch is the whole reason preview/seeking works
        const hasDuration = fs.readFileSync(f).subarray(0, 4096).includes(Buffer.from([0x44, 0x89]))
        if (!hasDuration) return done(false, 'webm has no EBML Duration element')
        done(true)
      } catch (e) {
        done(false, e.message)
      }
    })
  })
}
