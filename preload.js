const { contextBridge, ipcRenderer } = require('electron')

const inv = (ch, ...a) => ipcRenderer.invoke(ch, ...a)
const on = (ch, fn) => { ipcRenderer.on(ch, (e, ...a) => fn(...a)); return () => ipcRenderer.removeAllListeners(ch) }

contextBridge.exposeInMainWorld('api', {
  settings: { get: () => inv('settings:get'), set: p => inv('settings:set', p) },
  sources: () => inv('sources:list'),
  pickRegion: displayId => inv('region:pick', displayId),
  regionDone: rect => inv('region:done', rect),
  arm: id => inv('rec:arm', id),
  started: () => inv('rec:started'),
  stopped: () => inv('rec:stopped'),
  save: (buf, ext) => inv('rec:save', buf, ext),
  bitrate: () => inv('cfg:bitrate'),

  file: {
    reveal: f => inv('file:reveal', f),
    open: f => inv('file:open', f),
    remove: f => inv('file:delete', f),
  },
  pickDir: () => inv('dir:pick'),
  win: { minimize: () => inv('win:minimize'), close: () => inv('win:close') },

  ctl: cmd => inv(`ctl:${cmd}`),
  barState: s => inv('bar:state', s),
  barSize: (w, h) => inv('bar:size', w, h),
  onCtl: fn => on('ctl', fn),
  onState: fn => on('state', fn),
  onHotkey: fn => on('hotkey', fn),

  pen: {
    mode: m => inv('pen:mode', m),
    clear: () => inv('pen:clear'),
    onMode: fn => on('mode', fn),
    onClear: fn => on('clear', fn),
    onEndStroke: fn => on('endstroke', fn),
  },
  cursor: () => inv('cursor:pos'),
  overlayBounds: () => inv('overlay:bounds'),

  platform: process.platform,
})
