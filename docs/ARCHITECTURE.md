# Architecture

Spec: `docs/SPEC.md` (governing). This file records how the code is shaped to meet it.

## Processes
```
┌──────────────── Electron main (app/src/main) ────────────────┐
│ window + control-bar windows · IPC · global shortcuts        │
│ Recorder driver ── JSON lines ──▶ recorder sidecar per OS    │
│ AssetServer: localhost HTTP with Range for project media     │
│ Exporter: @remotion/bundler + @remotion/renderer (h264)      │
└──────────────────────────────────────────────────────────────┘
          ▲ contextBridge (app/src/preload)
┌──────── renderer (React, app/src/renderer) ────────┐
│ Home · Recording · Editor · ControlBar (#bar hash) │
│ Editor preview = @remotion/player of the SAME      │
│ composition the exporter renders (app/src/video)   │
└────────────────────────────────────────────────────┘
```

## Modules
| area (spec §99) | where |
|---|---|
| capture (macOS) | `recorder/narrate.py` (ffmpeg avfoundation + PyObjC cursor log). Swift/ScreenCaptureKit replacement in `recorder/swift/`, same protocol. |
| capture (Windows) | `recorder/narrate_win.py` (ffmpeg ddagrab → gdigrab fallback, dshow mic, Win32 cursor log; standard library only). Smoke test: `recorder/tests/smoke_win.py`. |
| media / storage | project folder `~/Movies/Narrate/<stamp>/` (Windows: `~/Videos/Narrate/`): `screen.mp4`, `mic.wav`, `camera.mp4` (optional), `events.json`, `cursors/`. Raw media is never modified after finalisation. |
| system audio (Windows) | `recorder/win_loopback.py`: WASAPI loopback of the default output via ctypes/raw COM, float32 WAV, silence gaps filled from the device position so sample N is always at `t0System + N/rate`. Converted to `system.wav` at finalisation; mixed in the composition with its own volume. |
| camera overlay | `app/src/video/Screencast.tsx` `cameraRect` + `TimedVideo`: the camera is its own file on the shared clock (`cameraOffset`), composited over the screen frame at render time with shape / size / corner / mirror from `RenderConfig`, so placement stays editable (spec §10). It does not move with the zoom. |
| cursor + zoom (rendering) | `app/src/video/motion.ts` (viewport keyframes over the screen, cursor smoothing, cursor-follow for cropping aspects), `ranges.ts` (kept ranges, output↔source time), `Screencast.tsx` (`layout()`: canvas / frame / viewport per aspect; segments; camera overlay; audio tracks) |
| aspect presets | `layout()` in `Screencast.tsx`: `source` = screen + padding; 16:9 fits the whole screen; 9:16 / 4:5 / 1:1 fill the frame, crop the screen and let the viewport follow the smoothed cursor and zoom to clicks (content-aware reframing, add-on §17). Output "1080p" names the shorter side. |
| export | `app/src/main/exporter.ts` |
| UI | `app/src/renderer/**` |
| shared contracts | `app/src/shared/types.ts` |

## Recorder protocol
stdout, one JSON per line: `started`, `paused`, `resumed`, `stopped` (capture ended — the user is free), `finalizing {step}`, `ready`, `error {code,message}`.
stdin: `{"cmd":"pause"|"resume"|"stop"}`. Closing stdin stops the recording (app crash ⇒ recording is still finalised).
`--list` devices, `--check [--request]` permissions.

## Time base
One host clock per platform, shared by media timestamps and the cursor log, so nothing needs an offset measurement:
- macOS: `CLOCK_UPTIME_RAW` = `CACurrentMediaTime` = avfoundation pts.
- Windows: system time as Unix seconds (`time.time()`); every ffmpeg input runs with `-use_wallclock_as_timestamps 1 -copyts`, in its own process (measured: ddagrab is 0-based, dshow is machine uptime, gdigrab is wall clock — one process with mixed clocks starves a stream). Video is captured to Matroska because fragmented MP4 drops the start time. dshow stamps a packet on arrival, so `t0Mic` is corrected by one audio buffer (50 ms).

`events.json` keeps `t0Video`, `t0Mic`, `micOffset`; media files are remuxed to start at 0 so Chromium can play them. Cursor positions are display pixels, origin top-left; `display.scale` maps points → pixels (spec §78). Cursor PNGs are stored in points on both platforms (Windows divides the physical bitmap by the monitor scale), so the renderer's `size × display.scale × cursorScale` holds everywhere.

## Master and derivative assets (add-on §3–5, §13–19)
`project.json` holds the **master** (config + cuts) and `assets[]`, each a `DerivedAsset`: its own `cuts` (the complement of the segments it keeps, plus the master's cuts at generation time) and `config` overrides (aspect, camera corner…). A derivative is never a rendered file; the same `Screencast` composition renders it from the same media, so every asset stays editable and re-exportable (§5). `app/src/renderer/generate.ts` builds the standard set from the recording itself — Quick Demo (whole sections ranked by activity, first and last kept), LinkedIn (first spoken words → busiest moments → closing words, 16:9), Vertical Teaser and 15 s Teaser (strongest stretch, 9:16, camera top-right), Clips (one per highlight) — using the Smart Director's signals, the master's cuts, chapters and highlights; nothing is invented. The editor's asset strip switches which asset the timeline and panel edit; **Export all** renders the master and every derivative in sequence as `<stamp>-<asset>.mp4`. `scripts/assets.ts` prints (or writes) the generated set for a recording.

## Transcript and captions (spec §42–45; Windows today)
`narrate_win.py transcribe --out DIR` runs local Whisper (faster-whisper on CPU, `base.en` by default) in a private virtual environment at `%LOCALAPPDATA%\Narrate\speech`, created and populated on first use (~300 MB incl. the model; the only network access the product makes). `recorder/transcribe_worker.py` runs inside that environment and writes word-level timestamps; the recorder shifts them by `micOffset` into source time and writes `transcript.json`. The editor shows sentences (click to seek, Remove = cut, Restore), derives filler-word REMOVE proposals for the Smart Director (`fillerRanges`), and `video/Captions.tsx` burns captions into the frame (Minimal / Bold presets, current word highlighted, safe-area aware, larger in portrait). Captions are a `RenderConfig` setting, so derivatives can differ from the master.

## Smart Director (add-on §7–9; Windows recorder today)
`narrate_win.py analyze --out DIR` reads `events.json` and runs two ffmpeg passes (mic `silencedetect`; screen `select=gte(scene,0.25)` at 320 px) plus interaction maths (idle stretches, click groups, activity windows), and writes `analysis.json`: raw `signals` + `proposals` (`REMOVE` / `CHAPTER` / `ZOOM` / `HIGHLIGHT`, each with start, end, reason, confidence, id). Local and deterministic; no network. The app runs it on first open of a recording (cached afterwards) and shows the **Smart Director** card under the timeline: summary, Apply all / Review / Dismiss, and per-proposal Accept / Reject. Accepting writes ordinary edits into `project.json` (REMOVE → `cuts`, CHAPTER → `chapters`, HIGHLIGHT → `highlights`); ZOOM proposals are informational because the renderer's auto-zoom already applies them. Decisions are remembered by proposal id in `project.json#director`.

## Crash recovery (Windows; spec §61–62)
The recorder writes `recording.json` at start and journals the cursor log and pauses to `events.partial.jsonl` every 0.5 s. Media go to Matroska, which stays readable when truncated. `events.json` is written atomically at the end and the journal removed. On launch the app lists folders that have `recording.json` but no `events.json` and offers **Restore** (runs `narrate_win.py finalize --out DIR`, which rebuilds `events.json` from the journal and remuxes the media) or **Discard** (Bin, after confirmation). ffmpeg children live in a kill-on-close job object so a dead recorder cannot leave a capture running.

## Non-destructive edits
Pauses are stored as `pauses: [[t0,t1]]` and skipped at render time (`ranges.ts`), never cut from the media. Manual zooms (`zooms`: t, duration, x, y, level) become extra groups in `buildCamera` and override automatic ones they overlap; speed ranges (`speeds`: start, end, rate) split the kept ranges and set each segment's `playbackRate` for screen, camera and audio, with `outToSrc`/`srcToOut` mapping through the rate. Editor settings (`RenderConfig`: zoom, padding, background, cursor, camera overlay, volumes, export size) are autosaved to `project.json` in the recording folder ~0.4 s after each change, written atomically; the editor and the CLI exporter both start from it. User cuts, zoom edits and masks will follow the same pattern: instructions in the project, raw media untouched (spec §38, §60, §61).
