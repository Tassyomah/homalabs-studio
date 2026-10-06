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
| media / storage | project folder `~/Movies/Narrate/<stamp>/` (Windows: `~/Videos/Narrate/`): `screen.mp4`, `mic.wav`, `events.json`, `cursors/`. Raw media is never modified after finalisation. |
| cursor + zoom (rendering) | `app/src/video/motion.ts` (camera keyframes, smoothing), `ranges.ts` (kept ranges), `Screencast.tsx` |
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

## Non-destructive edits
Pauses are stored as `pauses: [[t0,t1]]` and skipped at render time (`ranges.ts`), never cut from the media. User cuts, zoom edits and masks will follow the same pattern: instructions in the project, raw media untouched (spec §38, §60).
