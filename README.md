# narrate (working name) — Homalabs screen studio

Record once. Let the software make it look good. See `docs/SPEC.md`.

Pipeline (same shape as Screen Studio's own project files, so those import too):

1. **capture** — `bin/narrate record` → `recordings/<stamp>/`
   `screen.mp4` (native pixels, cursor hidden) + `mic.mov` + `events.json`
   (cursor path, clicks, cursor PNGs; all on the host clock so nothing drifts).
2. **narrate** — (next) cut the take into segments at clicks/pauses, record a voice line
   per segment with retakes; zoom timing follows the narration.
3. **render** — (next) Remotion composition: smooth cursor, auto-zoom to click groups,
   padding + Homalabs background, export via ffmpeg.

## Run (development)
```
cd app && npm run dev
```
Opens the Narrate window. Record → control bar appears bottom-right (Pause / Stop, ⌘⇧P / ⌘⇧S) → editor opens with the polished preview → Export MP4.
Recordings live in `~/Movies/Narrate/`. First run: allow Screen Recording (and Microphone) for the app, then reopen it.

Docs: `docs/SPEC.md` (product spec), `docs/ARCHITECTURE.md`, `docs/DECISIONS.md`.
