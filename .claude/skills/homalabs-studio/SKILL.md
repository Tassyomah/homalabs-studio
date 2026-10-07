---
name: homalabs-studio
description: Resume building the Homalabs screen studio (working name "narrate"), Tassy Omah's open-source Loom + Screen Studio alternative. Load for any request about this app, screen recording, the recorder, the editor, export, or "continue Phase N". Carries the full project context so a fresh machine or session can pick up without the original conversation.
---

# Homalabs screen studio ("narrate")

**Owner:** Tassy Omah (Esther Omah Atasie), designer, runs the agency Homalabs. Product is hers, open source, must feel like a serious Homalabs product.
**Promise:** Record once. Let the software make it look good. Loom's ease + Screen Studio's automatic polish, own identity.
**Repo:** this repository. Read, in order, before any work: `docs/SPEC.md` (her 108-section spec, governing), `docs/SPEC-ADDON.md` (Smart Director / derivative assets / Asset Studio add-on, also governing; its text is cut off in §19 — ask her for the rest), `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `README.md`.

## Rules Tassy has set (do not re-ask)
- Build vertically, Phase 1 → 8 as in SPEC §97. Phase 1 stable before moving on.
- No placeholder buttons. A visible feature works end-to-end or is marked unavailable in plain text (SPEC §98).
- Very high quality; it will be open-sourced and scaled.
- She uses the app through its window, never the terminal. Never run test recordings of her screen without telling her first.
- Desktop app, not web (SPEC §3). macOS and Windows, one Electron app, one recorder sidecar per OS with the same protocol. Development currently happens on a Windows laptop; the Mac recorders are untouched.
- She is not a terminal user: give her plain steps (open Settings, click X), never a command to run unless asked.
- Brand tokens: ink #14140F, paper #EFEEE8, coral #FB8B73, indigo #6E71E8, violet #8B78D6, mustard #F5C36A. Flat shapes, no outline borders or offset shadows on UI chips. Calm, premium, no SaaS-dashboard look (SPEC §91–92).
- Never delete her files; move to the Bin after an explicit yes.

## Where things are
- `app/` Electron + React + Remotion. `npm install`, `npm run dev`. Main: `src/main` (window, control bar, Recorder driver, AssetServer, exporter). UI: `src/renderer`. Composition shared by preview and export: `src/video`. Contracts: `src/shared/types.ts`.
- `recorder/narrate.py` interim macOS recorder (ffmpeg avfoundation + PyObjC). Needs `~/bin/ffmpeg`, `~/bin/ffprobe`, `pip install --user pyobjc-core==10.3.2 pyobjc-framework-Cocoa==10.3.2 pyobjc-framework-Quartz==10.3.2`.
- `recorder/swift/` ScreenCaptureKit recorder, same stdout/stdin JSON protocol. Build with Xcode installed (`make` in that folder). This is the real macOS recorder; the Python one is a stopgap.
- `recorder/narrate_win.py` Windows recorder (Python stdlib + ffmpeg: ddagrab→gdigrab, dshow mic, Win32 cursor log). `recorder/tests/smoke_win.py` records 5 s and validates `events.json`. Needs `winget install Gyan.FFmpeg Python.Python.3.12`.
- `app/scripts/export.ts` exports a recording from the CLI through the app's own pipeline (`npx tsx scripts/export.ts <dir> [height]`).
- Recordings: macOS `~/Movies/Narrate/<stamp>/`, Windows `%USERPROFILE%\Videos\Narrate\<stamp>\` → `screen.mp4` (cursor hidden), `mic.wav`, `events.json`, `cursors/`.
- `docs/DEVELOPMENT.md` has the full setup for both platforms.

## State as of 2026-10-06 (evening, Windows laptop)
Working on both platforms: home (display, mic, countdown, permission notices) → record → floating control bar (pause/resume/stop, ⌘⇧P/⌘⇧S or Ctrl+Shift+P/S) → finalising states → editor with live preview (auto-zoom to click clusters, smoothed cursor, click ripple, padding, radius, 4 backgrounds, cursor size) → MP4 export (1080p/1440p/source) → Show in Finder/Explorer. Pauses removed non-destructively.
Windows recorder verified by `smoke_win.py` on this laptop: ddagrab ≈ 52 fps at 1080p with Quick Sync, mic on the same clock (offset ≈ 0.4 s, recorded in events.json), cursor PNG correct. Encoder choice cached in `%LOCALAPPDATA%\Narrate\encoder.json`.
Windows also has: crash recovery (journal + `finalize`; home screen shows Restore / Discard for unfinished recordings; tested by killing recorder + ffmpeg mid-recording), live mic level meter on the home screen (`meter` subcommand), ffmpeg children in a kill-on-close job object, camera recording (`--camera N` → `camera.mp4` on the shared clock) with an editable overlay in the editor (Hidden / Circle / Rounded, size, corner, mirror), system audio (`--system-audio` → `system.wav` via `win_loopback.py`, WASAPI loopback) with voice / computer-sound volume sliders in the editor.
Editor also has: project.json autosave (config + cuts, merged over defaults), timeline in source time (kept / pause / cut / clicks / playhead, click to seek), Trim start/end here, Cut from here…to here, Restore per cut, Undo/Redo (Ctrl+Z / Ctrl+Y), output vs recorded duration readout.
Phase 1 on Windows is feature-complete except window/region capture and a camera preview before recording. macOS lacks recovery, meter, camera and system audio (needs the same subcommands/flags in narrate.py / Swift).

## Roadmap (SPEC-ADDON, agreed 2026-10-06)
1. Aspect presets (16:9 / 9:16 / 1:1 / 4:5 / source) with content-aware reframing: the viewport follows the zoom target; camera repositions. Needed by every derivative asset.
2. Analysis layer (local, ffmpeg + events.json → `analysis.json` per recording): mic silences (`silencedetect`), screen changes (`select=gt(scene,…)`), idle stretches, click clusters, interaction density. Smart Director panel: proposals (REMOVE / ZOOM / SPEED / CHAPTER) with reason + confidence, Apply all / Review / Dismiss; accepted ones become cuts / zoom keys / chapters in project.json.
3. Project model: master + `assets[]` derivatives (segments, aspect, config overrides, createdFromVersion). Asset Studio list on the editor; Quick Demo / LinkedIn / Vertical teaser / Clips generated from analysis; each opens in the same editor; Export all.
4. Then transcript/captions (Phase 5), zoom editing, masks, GIF export.
Known limits of both interim recorders: control bar appears in the capture; no window/region; no system audio. Windows multi-monitor ddagrab index order is assumed, untested (one display here).

## On a new machine
- **Windows:** `winget install Gyan.FFmpeg Python.Python.3.12 OpenJS.NodeJS.LTS` (Node needs admin; otherwise unzip node into `%LOCALAPPDATA%\Programs\nodejs`). `cd app && npm install && npm approve-scripts esbuild electron`; if Electron's binary is missing run `node node_modules/electron/install.js`. `npm run dev`.
- **macOS:** Install Xcode (App Store) and Node 20+. `cd app && npm install`. Build the Swift recorder (`cd recorder/swift && make`) and point `src/main/index.ts` RECORDER at it; keep the protocol identical. `npm run dev`, grant Screen Recording + Microphone, reopen.
- Continue from "Not built yet" above, updating `docs/DECISIONS.md` and this file as state changes.
