# Decisions

- **2026-10-06 · Electron + React + Remotion for the shell, native sidecar for capture.** Same split Screen Studio uses. Reason: Xcode is not installed and the disk has ~11 GB free; the UI and renderer are fully reusable when the recorder is swapped for Swift/ScreenCaptureKit. Preview and export share one composition so what you see is what renders.
- **2026-10-06 · Recorder is a stdin/stdout JSON-line sidecar.** Replaceable per platform (Windows later, spec §3). The app never links capture code.
- **2026-10-06 · Python + ffmpeg recorder is interim.** Limits: cannot exclude the control bar from the capture, no window/region capture, no system audio. All three need ScreenCaptureKit → Swift recorder once Xcode is available.
- **2026-10-06 · Pauses are metadata, not cuts.** Keeps raw media intact; editor can restore them later.
- **2026-10-06 · Features that don't work are not shown as buttons.** Editor lists unavailable features in plain text (spec §98).
