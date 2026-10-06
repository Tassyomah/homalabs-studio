# HOMALABS SCREEN STUDIO
Master Product Specification + End-to-End Engineering Prompt

(Written by Tassy Omah, 2026-10-06. This is the governing product specification for the app in this repository. Working name of the codebase: `narrate`.)

You are the principal product engineer, desktop application engineer, video-processing engineer, UX engineer, and QA engineer responsible for building this product from start to finish.
Do not treat this as a prototype, mockup, landing page, or collection of disconnected features.
Build a real, production-quality desktop application for recording, editing, polishing, exporting, and sharing professional screen recordings.
The product is being developed by Homalabs.
The product category is:
Professional screen recorder + automatic video polish + lightweight video editor + demo/tutorial creator + optional video sharing/hosting.
The core inspiration is the ease of Loom combined with the visual polish and automatic editing philosophy of Screen Studio.
Do NOT copy their branding, UI, names, proprietary assets, source code, or exact visual design.
The product must have its own visual identity and interaction model.

## 1. PRODUCT PHILOSOPHY
The core promise is: **Record once. Let the software make it look good.**
The user should not need to become a video editor to create a polished: product demo, software walkthrough, YouTube tutorial, course lesson, design presentation, bug report, engineering walkthrough, sales demo, onboarding video, educational tutorial, social media clip, internal update, how-to video.
The product should eliminate unnecessary editing work. A user should be able to:
1. Open the app. 2. Select what to record. 3. Select microphone/camera/system audio. 4. Start recording. 5. Perform the workflow naturally. 6. Stop recording. 7. Receive an automatically polished recording. 8. Make small adjustments if desired. 9. Export or share.
The software should do the heavy lifting.

## 2. PRIMARY DESIGN PRINCIPLE
Do not build a traditional complicated video editor first. The product should feel like: screen recorder → intelligent post-production system, rather than a Premiere Pro clone. The default experience should be extremely simple. Advanced controls should exist without overwhelming first-time users. Progressive disclosure is required.

## 3. PLATFORM
Native-feeling desktop application. Primary target: macOS. Architecture should allow Windows later without a rewrite. Do not create a web-only screen recorder: screen capture, cursor capture, microphone, system audio, webcam, local processing and high-quality export require native capabilities.

## 4. CORE APPLICATION AREAS
A. Home / Projects · B. Recording Studio (configuration) · C. Recording Experience · D. Editor · E. Export · F. Share (optional hosted) · G. Settings (application, recording, audio, camera, appearance, shortcuts, storage, account).

## 5. FIRST-RUN EXPERIENCE
No long onboarding questionnaire. Short welcome: "Create beautiful screen recordings without spending hours editing them." Primary: Start Recording. Secondary: Explore a sample. Request only the OS permissions required for what the user chooses; explain each before requesting. Categories: Screen Recording, Microphone, Camera, System Audio, Accessibility/Input Monitoring where technically necessary. Never request every permission immediately.

## 6. HOME SCREEN
Header: New Recording, Search, Settings, account state if implemented. Main: recent projects. Card: thumbnail, title, duration, created, last edited, resolution, recording type, status, local/cloud. Actions: Open, Rename, Duplicate, Export, Share, Reveal in Finder, Delete. Grid and list views. Search over title, transcript, metadata, tags.

## 7. RECORDING FLOW
New Recording opens configuration. Source: entire screen, specific display, specific application/window, custom rectangular area. Visually preview the selected region.

## 8. MULTI-DISPLAY SUPPORT
Display 1/2/3, specific application, specific window, custom region. Never accidentally capture other displays. Space/desktop switching behaviour must be predictable and documented.

## 9. RECORDING MODES
Screen Only · Screen + Camera · Camera Only · Camera + Screen · Custom.

## 10. WEBCAM
Camera selection, resolution, frame rate, circular / rounded rectangle / square / custom frame, size, position, border, shadow, opacity, background, crop. Placement editable after recording; do not bake it in.

## 11. CAMERA LAYOUTS
Screen only, camera overlay, split screen, fullscreen camera, camera cutout, picture-in-picture, custom. Switchable during editing; timeline-aware (one recording can move through several layouts).

## 12. CAMERA CUTOUT
Optional local background removal: remove, colour, soft/transparent, image, gradient preset, edge softness. Local where feasible.

## 13. FACE TRACKING
Keep the face framed if supported: on/off, framing, zoom, smoothing. Fail gracefully.

## 14. MICROPHONE
Multiple mics: name, live level, input level, mute, selection, monitoring. Clear signal indicator before recording. Say clearly if none detected.

## 15. SYSTEM AUDIO
On/off, mic on/off, both, app-specific where supported, volume monitoring. Never silently capture audio; active sources must be obvious.

## 16. AUDIO ENHANCEMENT
Optional: noise reduction, voice enhancement, normalisation, silence detection, background suppression. Adjustable or off. Preserve the raw recording.

## 17. RECORDING COUNTDOWN
3 s, 5 s, custom, immediate; can be disabled.

## 18. RECORDING CONTROLS
Minimal floating control: Pause, Resume, Stop, Restart, Mute mic, Toggle camera, Show/hide controls. The control UI should not appear in the recorded screen.

## 19. KEYBOARD SHORTCUTS
Configurable global shortcuts: start, pause, resume, stop, cancel, toggle mic, toggle camera, add marker, toggle drawing, hide/show controls. Avoid OS conflicts.

## 20. RECORDING METADATA
Capture: frames, display dimensions and scale, frame timing, mouse position, clicks, button, keyboard shortcuts (when enabled), mic, system audio, webcam, recording dimensions, app/window context, event timestamps. Mouse data stored separately from the raw video.

## 21. CURSOR SYSTEM
Do not burn the native cursor in. Renderer can: hide original, render custom, size, appearance, smooth, animate, highlight, click indicators, left/right click, ripple, hide when idle, restore on movement. Stay synchronised.

## 22. CURSOR SMOOTHING
Raw coordinates → smoothed trajectory; reduce jitter and micro movement without making deliberate movement unnatural. Off / Low / Medium (default) / High.

## 23. CURSOR CLICK EFFECTS
Ripple, ring, left/right style, colour, size, duration, animation, enabled. Editable after recording.

## 24. AUTOMATIC ZOOM ENGINE
Analyse interaction data: clicks, double clicks, drags, sustained movement, app transitions, clusters. Generate zoom in → hold → interaction → zoom out. Do not zoom into every click; cluster; avoid excess.

## 25. AUTO-ZOOM RULES
Identify meaningful clusters, ignore insignificant repetitive clicks, avoid rapid in/out, preserve context, keep important UI visible, account for webcam placement, aspect ratio, safe areas. Settings: on/off, intensity, minimum time between zooms, duration, lead-in, hold, maximum zoom, smart clustering.

## 26. MANUAL ZOOM
Add anywhere: timestamp, duration, target, level, easing, transition, optional pan. Drag, resize, retarget, change level, delete, duplicate.

## 27. ZOOM ANIMATION
Ease in/out/in-out, linear, spring where appropriate. Polished default; technical controls only under advanced.

## 28. SMART FRAMING
On aspect change (16:9, 1:1, 9:16, custom) recalculate zoom targets, camera placement, cursor, captions, keycaps, safe areas.

## 29. SOCIAL MEDIA MODES
Presets: YouTube 16:9, Shorts 9:16, TikTok 9:16, Reels 9:16, Instagram Feed 1:1, LinkedIn 4:5 / 1:1 / 16:9, Custom. Presets define output and safe areas only; no platform branding in the engine.

## 30. REEL SAFE AREA
Optional overlays for top/bottom UI obstruction, caption safe zone, central area. Never in the export.

## 31. BACKGROUND SYSTEM
Solid, gradient, image, transparent, presets. Colour, angle, stops, image position/scale, blur, opacity.

## 32. SCREEN FRAME
Raw, rounded rectangle, browser-like, desktop window, custom. Radius, shadow, border, inset, padding, scale, position.

## 33. SHADOW
On/off, opacity, blur, spread, offset, colour. Sensible defaults.

## 34. SCREEN SPACING
Compact, balanced, spacious, custom.

## 35. MOTION BLUR
Optional for cursor, zoom, camera and layout transitions; auto-disable on performance problems.

## 36. EDITOR
Timeline-based but simpler than pro NLEs. Canvas (preview), Timeline (bottom), Inspector (right), Project controls (top).

## 37. TIMELINE
Tracks: video, mic, system audio, camera, cursor events, zooms, layouts, captions, masks, annotations, cuts. Zoomable. Playhead, snapping, frame-accurate seek, markers, selection, trim, split, delete, undo, redo.

## 38. NON-DESTRUCTIVE EDITING
Edits are project instructions. Preserve raw recording, edit state, rendered outputs. Return later to change zoom, cursor, layout, captions, background, crop, speed.

## 39. CUTTING
Trim start/end, split, delete, ripple delete, restore, undo/redo.

## 40. SPEED
0.5×–2× and custom; keep audio quality; optional pitch preservation.

## 41. SILENCE REMOVAL
Detect, preview, remove all/selected, threshold, minimum duration. Never delete without showing.

## 42. FILLER WORD DETECTION
With transcription: um, uh, like, you know, basically, so, actually. Show, remove all/selected, ignore, undo. Keep sync.

## 43. TRANSCRIPTION
Timestamps, speaker, confidence, editable; synced; click sentence → seek.

## 44. EDIT BY TRANSCRIPT
Delete text → mark segment for deletion. Word/sentence/paragraph selection. Reversible.

## 45. CAPTIONS
Auto from transcript. Font, size, weight, colour, background, outline, shadow, position, alignment, max lines, animation, word highlighting, capitalisation, timing. Presets: Minimal, YouTube, Social, Bold, Clean, Custom.

## 46. KEYBOARD SHORTCUT VISUALIZATION
Animated keycaps (⌘ + K). Enable, position, size, theme, animation, duration.

## 47. ANNOTATIONS
Pen, highlighter, arrow, rectangle, circle, spotlight, text, blur, pixelation; timeline duration; non-destructive.

## 48. SPOTLIGHT
Darken/blur/dim outside target; radius; intensity.

## 49. MASKING / PRIVACY
Rectangle, rounded, blur, pixelation, custom; attached to screen coordinates; optional tracking. Export must guarantee masked pixels are actually obscured.

## 50. HIGHLIGHTING
Spotlight, outline, glow, dim, zoom.

## 51. MARKERS
Shortcut creates a marker; shown on timeline; renamable; usable by AI for chapters.

## 52. AI FEATURES
Title, summary, chapters, description, key moments, filler detection, silence detection, editing suggestions (cut, speed up, emphasise). User approves destructive edits.

## 53. AI PRIVACY
Prefer local; clearly label local vs cloud; never send recordings without explicit permission.

## 54. EXPORT ENGINE
MP4, GIF; possibly WebM, MOV.

## 55. EXPORT RESOLUTIONS
720p, 1080p, 1440p, 4K (source permitting); 24/30/60 fps; no needless upscaling.

## 56. EXPORT PRESETS
YouTube, Shorts, TikTok, Instagram, LinkedIn, Web (compressed 1080p), GIF, Custom.

## 57. COPY TO CLIPBOARD
Where supported.

## 58. EXPORT QUEUE
Multiple exports: filename, format, resolution, progress, ETA, cancel, open folder. Async.

## 59. BACKGROUND RENDERING
Never freeze the UI; workers/background processes; hardware acceleration.

## 60. PROJECT FILE FORMAT
References raw media, edit instructions, cursor data, zooms, transcript, captions, masks, annotations, layout, export settings. Not dependent on one MP4. Reopenable.

## 61. AUTOSAVE
Continuous. On crash: "We recovered an unsaved project." Restore / Discard.

## 62. CRASH RECOVERY
Recover recordings after a crash; safe temporary chunks.

## 63. STORAGE MANAGEMENT
Show project/raw/rendered sizes and free space; warn before critical; move, archive, delete raw, relink. Never silently delete sources.

## 64. LOCAL-FIRST ARCHITECTURE
Recording, editing, local export and project management work offline. Internet only for cloud sharing/AI/transcript/sync.

## 65. SHARING / HOSTED VIDEO
Separate layer. Export locally or upload and share. Viewer: player, title, description, transcript, chapters, captions, comments, reactions, download permission, speed, fullscreen.

## 66. SHARING PRIVACY
Public, Unlisted, Password, Private. Optional download, comments, reactions, expiry, disable. Not public by default.

## 67. VIDEO VIEWER
Fast; adaptive; fullscreen; captions; transcript; chapters; speed; seek; keyboard; mobile.

## 68. TIMESTAMPED COMMENTS
Comment at a timestamp; click to seek; owner resolves/deletes/replies.

## 69. VIEW ANALYTICS
Views, unique viewers (privacy permitting), average watch, completion, drop-off, replays. Privacy-conscious.

## 70. VIDEO LIBRARY
Search, sort, filter, folders, tags, favourites, archive. Filters: date, duration, resolution, type, folder, tags.

## 71. DUPLICATE PROJECT
New editable copy for YouTube/TikTok/LinkedIn/client/clean versions.

## 72. VERSIONING
Demo v1, v2, YouTube, Short; return to earlier versions.

## 73. THEMES / BRANDING
Defaults for background, cursor, zoom, camera style, captions, font, spacing, shadow; saved as presets.

## 74. SHAREABLE PRESETS
Export/import style presets (no private data). Example: Homalabs Demo Style.

## 75. ACCESSIBILITY
Keyboard navigation, focus states, readable text, contrast, reduced motion, screen-reader-friendly controls, captions, transcript, shortcuts.

## 76. PERFORMANCE REQUIREMENTS
Responsive during recording, editing, playback, processing, export. Stability over effects; separate processes if needed.

## 77. VIDEO QUALITY
Sharp text and cursor; zoomed UI not needlessly blurry; proper scaling and interpolation; high-quality upscaling where feasible.

## 78. HIGH-DPI SUPPORT
Retina, multiple DPI, scaling, mixed monitors. Correct mapping between physical, logical, recording and output coordinates. Critical.

## 79. MULTI-MONITOR COORDINATE SYSTEM
Normalised coordinates for capture, cursor, clicks, zooms, annotations, masks, camera. Extensively tested.

## 80. RECORDING SYNCHRONIZATION
Screen, mouse, mic, system audio, camera on one timebase; no drift on long recordings.

## 81. LONG RECORDINGS
30 min, 60 min, 2 h+; streaming/chunked storage; not all in memory.

## 82. TEMPORARY FILE MANAGEMENT
Unique IDs, safe writes, recoverable, cleaned after finalisation, never overwrite unrelated files.

## 83. ERROR HANDLING
Human-readable errors; no stack traces for ordinary users. e.g. "Your selected microphone is no longer available. Choose another microphone." / "You don't have enough disk space to continue recording." / "Export couldn't complete. Your project is safe. Try again or choose a lower resolution."

## 84. SETTINGS
General, Recording, Audio, Camera, Editor, Export, Shortcuts, AI, Sharing.

## 85. ACCOUNT SYSTEM
No account for local recording. Account only for cloud storage, hosted sharing, sync, teams. Local projects never behind a login wall.

## 86. SECURITY
Protect local project files; never expose API keys; OS-native credential storage; signed cloud requests; validate uploads; sanitise metadata; protect hosted URLs; server-side authorisation; never trust the client.

## 87. CLOUD ARCHITECTURE
Desktop client · API · Object storage · CDN · Database · Processing workers. No raw recordings to the server unless an explicitly selected feature needs them.

## 88. PRODUCT ANALYTICS
Only what improves the product (recording_started, recording_completed, export_started, export_completed, export_failed, zoom_added, caption_enabled, share_created). Never screen contents, mic, private transcripts.

## 89. TESTING REQUIREMENTS
Recording (single/multi display, window, region, mic, system audio, webcam, long), Cursor (clicks, smoothing, transforms, DPI), Zoom (auto, manual, clusters, transitions, aspect), Editing (trim, split, delete, undo, redo, speed, transcript), Export (720p–4K, 30/60, 16:9, 1:1, 9:16, GIF), Recovery (crash during recording/export, interrupted export, missing media).

## 90. END-TO-END ACCEPTANCE TEST
Launch → New Recording → display → mic → system audio → webcam → camera overlay → record → move/click → pause → resume → marker → stop → project generated → cursor processed → zooms generated → audio normalised → transcript → captions → editor → delete section → manual zoom → cursor size → mask → background → camera position → 9:16 → reframing → export 1080p → verify → export GIF → verify → save → close → reopen → edits intact → export again → optionally share → open URL → plays → captions → chapters → privacy. All without touching code or project files.

## 91. UI/UX QUALITY BAR
Modern, calm, premium, fast, intentional, approachable, professional. Avoid excessive gradients, generic SaaS dashboards, unnecessary cards, excessive borders, cluttered toolbars, tiny controls, confusing terminology. Recorder almost invisible; editor powerful without intimidating.

## 92. DESIGN LANGUAGE
Clarity over decoration. Motion communicates state. Controls appear when needed. Excellent defaults. Advanced functionality does not clutter the basics. Consistent spacing, typography, iconography. All controls: hover, pressed, focused, disabled, loading.

## 93. EMPTY STATES
"Your recordings will appear here." Primary: Start recording. Secondary: Watch a sample.

## 94. LOADING STATES
Preparing recording… Processing cursor… Generating zooms… Creating transcript… Rendering captions… Exporting video… Never let the user wonder if it froze.

## 95. FIRST RECORDING SHOULD BE FAST
Launch → recording in seconds. No manual project creation, naming, settings or account.

## 96. DEFAULT RECORDING PRESET
Primary display; mic if permitted; camera off; system audio off; 30 fps; high quality; auto zoom on; cursor smoothing on; standard cursor; 16:9; balanced background; autosave.

## 97. IMPLEMENTATION STRATEGY
Build vertically. Phase 1 Recording Core (shell, screen, mic, basic system audio, webcam, controls, saving, recovery) — stable before moving on. Phase 2 Intelligent Recording Data (cursor, clicks, sync, metadata, shortcuts). Phase 3 Rendering Engine (cursor, smoothing, zoom, camera overlays, backgrounds, shadows, aspect). Phase 4 Editor (timeline, trim, split, zoom/cursor/camera editing, annotations, masks). Phase 5 Audio + AI (transcription, captions, silence, fillers, transcript editing, summaries, chapters). Phase 6 Export (MP4, 1080p, 4K, 30/60, GIF, presets). Phase 7 Sharing. Phase 8 Polish.

## 98. IMPORTANT AGENT BEHAVIOR
No placeholder buttons declared complete. A displayed feature works end-to-end or is explicitly marked unavailable. No fake functionality, mocked recordings, hard-coded fake data, or hidden breakage.

## 99. CODE QUALITY
Modular: capture, media, audio, cursor, timeline, rendering, AI, export, storage, cloud, UI. No giant files. Clear interfaces, strong typing, explicit errors, tests for critical paths.

## 100. DOCUMENTATION
README.md, ARCHITECTURE.md, DEVELOPMENT.md, TESTING.md, MEDIA_PIPELINE.md, RECORDING_ENGINE.md, EXPORT_ENGINE.md, SECURITY.md, DECISIONS.md.

## 101. AGENT WORKFLOW
Inspect → identify modules → dependencies → plan → implement → test → run → verify manually → fix regressions → document → next. No needless rewrites or fashionable frameworks; mature technology.

## 102. NO PREMATURE CLOUD DEPENDENCY
Local recording/editing independent of the cloud.

## 103. OFFLINE-FIRST RECORDING
Recording continues if the internet disappears.

## 104. DESIGN FOR FUTURE EXTENSIONS
Windows, mobile, iPhone/iPad capture, teams, shared projects, sync, AI editing, brand kits, templates, plugins, integrations, API, SDK. Clean boundaries now.

## 105. IMPORTANT PRODUCT DIFFERENTIATION
Not a "Loom clone"; not Loom's social model; not Screen Studio's interface. Compete on Speed, Automatic polish, Control, Privacy, Creator workflow (one recording → YouTube, short, social, tutorial, demo, GIF), Simplicity.

## 106. CORE PRODUCT LOOP
RECORD → UNDERSTAND → AUTO-POLISH → ADJUST → EXPORT → SHARE.

## 107. DEFINITION OF DONE
Complete when a real user can open → record real screen, audio, camera → get polished zooms/cursor → edit → caption → change aspect → export high quality → reopen later → continue → optionally share. Usable for YouTube, demos, tutorials, teaching, courses, social, internal comms.

## 108. FINAL INSTRUCTION TO THE BUILD AGENT
Treat this as the specification. Do not reduce scope to a toy. Do not build only UI. Do not stop at mocks. Build the recording, media, timeline, rendering, export, storage and recovery systems. At every stage: can a real person use this to create a real video? Smallest complete vertical slice first, verified end-to-end, then expand systematically.
