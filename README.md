# Recorder

Screen recorder with audio, a floating control bar, and a drawing overlay.

```bash
npm start                        # run
npm run smoke                    # drive one real recording end-to-end; prints SMOKE PASS
SMOKE=1 SMOKE_REGION=1 electron . --no-sandbox --disable-gpu --in-process-gpu   # same, through the crop path
```

## Layout

| File | What it is |
|---|---|
| `main.js` | windows, IPC, settings, hotkeys, file writing |
| `ui/index.html` + `app.js` | source picker, settings, preview — **the recording itself runs here** |
| `ui/bar.html` | floating control pill + pen toolbar |
| `ui/overlay.html` | transparent canvas for the pen |
| `ui/select.html` | drag-to-pick region overlay |

Capture is `getDisplayMedia` → `MediaRecorder` → `.webm` (VP9 + Opus). No ffmpeg, no native deps.

## Recording a region

`getDisplayMedia` cannot crop to an arbitrary screen rect — there is no constraint for it, and
Region Capture (`track.cropTo`) only works against a DOM element in a captured *tab*. So a region
capture pumps the full-screen track through a `<canvas>` and records `canvas.captureStream()`
instead. Consequences worth knowing:

- The direct path is kept when no region is set. Don't route full-screen capture through the
  canvas "for consistency" — it costs a draw per frame for nothing.
- The draw loop uses `video.requestVideoFrameCallback`, **not** `requestAnimationFrame`: rAF stops
  when the main window is hidden, which is exactly when recording happens.
- Region coords are screen CSS px and get rescaled by `videoWidth / display.width` for HiDPI.
- Canvas dimensions are forced even — odd sizes upset encoders.
- A region belongs to one screen's coordinate space, so it's dropped when the source changes.

## Things that will bite you

- **The bar must stack above the overlay.** `rec:started` creates the overlay *first* so the
  bar lands on top. Reverse it and an armed pen swallows every click on the bar.
- **A transparent window still eats clicks.** The bar window is resized to fit its visible
  content (`bar:size`); any slack becomes an invisible dead zone the pen can't draw through.
- **The pen overlay is only in the video if you record a whole screen**, not a single window —
  it's a separate window composited onto the display.
- **`MediaRecorder` omits the webm Duration header**, so players report `Infinity` and seeking
  breaks. `fix-webm-duration` patches the blob before saving. Don't remove it.
- **`setContentProtection(true)` hides the bar from the recording on Windows/macOS only.**
  Verified no-op on Linux/X11 — drag the bar aside or hide it with the pen hotkey there.
- **System audio** is `audio: 'loopback'`. Works on Windows and Linux/PulseAudio. macOS has no
  loopback device — pick BlackHole (or similar) as the mic instead.

## Platform notes

Linux needs a real session bus for audio; if `XDG_RUNTIME_DIR` is unset, PulseAudio won't
connect and capture falls back to video-only.
