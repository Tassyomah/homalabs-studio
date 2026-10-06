---
name: homalabs-studio
description: Resume building the Homalabs screen studio (working name "narrate"), Tassy Omah's open-source Loom + Screen Studio alternative. Load for any request about this app, screen recording, the recorder, the editor, export, or "continue Phase N". Carries the full project context so a fresh machine or session can pick up without the original conversation.
---

# Homalabs screen studio ("narrate")

**Owner:** Tassy Omah (Esther Omah Atasie), designer, runs the agency Homalabs. Product is hers, open source, must feel like a serious Homalabs product.
**Promise:** Record once. Let the software make it look good. Loom's ease + Screen Studio's automatic polish, own identity.
**Repo:** this repository. Read, in order, before any work: `docs/SPEC.md` (her 108-section spec, governing), `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`, `README.md`.

## Rules Tassy has set (do not re-ask)
- Build vertically, Phase 1 → 8 as in SPEC §97. Phase 1 stable before moving on.
- No placeholder buttons. A visible feature works end-to-end or is marked unavailable in plain text (SPEC §98).
- Very high quality; it will be open-sourced and scaled.
- She uses the app through its window, never the terminal. Never run test recordings of her screen without telling her first.
- Desktop app, not web (SPEC §3). macOS first; Windows later via a separate recorder, same protocol.
- Brand tokens: ink #14140F, paper #EFEEE8, coral #FB8B73, indigo #6E71E8, violet #8B78D6, mustard #F5C36A. Flat shapes, no outline borders or offset shadows on UI chips. Calm, premium, no SaaS-dashboard look (SPEC §91–92).
- Never delete her files; move to the Bin after an explicit yes.

## Where things are
- `app/` Electron + React + Remotion. `npm install`, `npm run dev`. Main: `src/main` (window, control bar, Recorder driver, AssetServer, exporter). UI: `src/renderer`. Composition shared by preview and export: `src/video`. Contracts: `src/shared/types.ts`.
- `recorder/narrate.py` interim macOS recorder (ffmpeg avfoundation + PyObjC). Needs `~/bin/ffmpeg`, `~/bin/ffprobe`, `pip install --user pyobjc-core==10.3.2 pyobjc-framework-Cocoa==10.3.2 pyobjc-framework-Quartz==10.3.2`.
- `recorder/swift/` ScreenCaptureKit recorder, same stdout/stdin JSON protocol. Build with Xcode installed (`make` in that folder). This is the real recorder; the Python one is a stopgap.
- Recordings: `~/Movies/Narrate/<stamp>/` → `screen.mp4` (cursor hidden), `mic.wav`, `events.json`, `cursors/`.

## State as of 2026-10-06
Working: home (display, mic, countdown, permission explainer), record → floating control bar (pause/resume/stop, ⌘⇧P/⌘⇧S) → finalising states → editor with live preview (auto-zoom to click clusters, smoothed cursor, click ripple, padding, radius, 4 backgrounds, cursor size) → MP4 export (1080p/1440p/source) → Show in Finder. Pauses removed non-destructively.
Not built yet (Phase 1 remainder): camera recording + editable overlay, system audio, crash recovery for interrupted recordings, mic level meter, window/region capture (needs Swift recorder). Then Phase 2+ per SPEC.
Known limits of the interim recorder: control bar appears in the capture; no window/region; no system audio.

## On a new machine
1. Install Xcode (App Store) and Node 20+. `cd app && npm install`.
2. Build the Swift recorder (`cd recorder/swift && make`) and point `src/main/index.ts` RECORDER at it; keep the protocol identical.
3. Run `npm run dev`, grant Screen Recording + Microphone to the app, reopen it.
4. Continue from "Not built yet" above, updating `docs/DECISIONS.md` and this file as state changes.
