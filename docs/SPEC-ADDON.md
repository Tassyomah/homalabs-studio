# HOMALABS SCREEN RECORDING PRODUCT
ADVANCED DIFFERENTIATION, SMART DIRECTOR & AUTOMATED CONTENT PRODUCTION — ADD-ON SPECIFICATION

(Written by Tassy Omah, 2026-10-06. Extension to `SPEC.md`; both govern. The pasted text ended mid-sentence in §19 — sections after "important ex…" are still to be added.)

This specification is an extension to the existing Homalabs screen recording and editing master specification.
Do NOT treat this document as a separate product.
Do NOT create a separate application, separate editor, or disconnected AI feature set.
Integrate everything below directly into the existing recording engine, event-based editing architecture, timeline, rendering pipeline, project model, and export system.
The existing product remains a premium, Screen Studio-style desktop screen recording and editing application.
However, the product must go substantially beyond being "a better Screen Studio."
The central product differentiator is:
RECORD ONCE → UNDERSTAND THE RECORDING → AUTOMATICALLY EDIT IT → GENERATE EVERY ASSET THE USER NEEDS.
The user should be able to complete an entire video-production workflow inside this application without needing to move the recording into another video editor.

## 1. PRODUCT DIFFERENTIATION
The product should NOT compete primarily by saying: "We have better screen recording." Recording quality and editing quality are foundational requirements. The larger differentiation is: the application does the repetitive post-production work automatically.
A user records one master recording. The system analyzes the recording. The system understands: what happened on screen · where the cursor moved · what was clicked · what changed · when the user paused · when the user spoke · when the user stopped speaking · which parts were repetitive · which moments appear important · which screen regions received attention · where camera presence is useful · what sections could become standalone clips.
It then uses that information to produce a polished master video and multiple derivative assets.

## 2. THE CORE PROMISE
RECORD ONCE → UNDERSTAND → EDIT AUTOMATICALLY → REVIEW → GENERATE → EXPORT.
The user should not have to manually perform the same editing work repeatedly. The product should eliminate: record → open another editor → trim → add zooms → fix cursor → add captions → make horizontal version → open another editor → make vertical version → find a good clip → make another clip → create GIF → take screenshot → make thumbnail → write social caption → export everything.
Instead: Record → Application analyzes recording → Master video generated → Short-form assets generated → User reviews → Export all.

## 3. MASTER RECORDING AS THE SOURCE OF TRUTH
Every recording must have a canonical master representation (e.g. 12:04 · 3840×2160 · 30 FPS · Microphone · System Audio · Camera · Cursor Events · Click Events · Window Events · Screen Changes · Transcript · Markers). The master must remain intact. Every generated asset derives from the master. Do not create independent duplicated source recordings for each output. Use the existing non-destructive event-based architecture.

## 4. MASTER → DERIVATIVE ARCHITECTURE
Explicit parent/child relationship between the master recording and generated assets (Master → Full Demo / Short Demo / LinkedIn → Vertical / Clips / GIFs).
Every derivative stores: source project · source recording · selected timeline ranges · composition · aspect ratio · duration · camera configuration · cursor configuration · caption configuration · background · zoom configuration · audio configuration · brand configuration · generated content metadata · version of master from which it was created.

## 5. DERIVATIVE ASSETS MUST REMAIN EDITABLE
Do NOT render generated assets and treat them as final immutable files. A generated LinkedIn video remains a project configuration referencing the master, e.g.
```json
{ "assetType": "linkedin", "duration": 60, "aspectRatio": "16:9", "source": "master-recording",
  "segments": [ { "start": 42.2, "end": 68.7 }, { "start": 131.1, "end": 164.4 } ],
  "captions": true, "camera": true, "smartReframe": true }
```
The user must be able to modify the generated asset.

## 6. CONTENT MAP
After recording analysis completes, generate a visual content map (00:00 Introduction · 00:42 Dashboard · 02:18 Creating a Project · …). The system should identify sections, topic transitions, screen transitions, major interactions, meaningful results, pauses, repeated actions, highlight candidates. Users can edit these boundaries manually.

## 7. SMART DIRECTOR
An intelligent editing layer that acts like an experienced editor reviewing the raw recording. It analyzes:
- Visual signals: cursor movement, click locations, screen changes, application changes, UI transitions, significant visual changes, interaction density, camera state.
- Audio signals: speech, silence, pauses, sentence boundaries, emphasis, repeated statements, filler words, audio quality.
- Metadata: markers, recording pauses, application context, window context, keyboard shortcuts, user-selected important regions.
- Semantic signals (where AI processing is enabled): topic transitions, feature demonstrations, explanations, outcomes, introductions, conclusions, repeated content, important moments.

## 8. SMART DIRECTOR OUTPUT
After analysis, show e.g. "Your 12:04 recording has been analyzed. Suggested improvements: ✓ 8 long pauses ✓ 4 automatic zoom opportunities ✓ 3 repetitive sections ✓ 6 chapter boundaries ✓ 5 highlight moments ✓ 2 potential short clips ✓ 1 sensitive-information warning ✓ 3 areas where cursor emphasis could improve clarity". Provide Apply All / Review / Dismiss. The user must never lose control.

## 9. AUTOMATIC EDIT PROPOSAL
The Smart Director creates an editable proposal rather than modifying the master. Proposed edits are timeline operations, e.g. REMOVE (start, end, reason: prolonged silence, confidence: high) · ZOOM (start, duration, target region, reason: meaningful interaction, confidence: high) · SPEED (start, end, speed 1.5×, reason: repetitive navigation, confidence: medium). The user can accept or reject each operation.

## 10. SMART ZOOM ENGINE
Expand the automatic zoom engine: do not simply detect clicks; determine whether the click is meaningful. Consider cursor trajectory, click, UI change after click, time spent on target, subsequent action, screen transition, repeated clicks in the same region, whether zoom would obscure context, whether another zoom happened recently. Pattern: cursor approaches CTA → click → interface changes → new state remains visible ⇒ Zoom In → Interaction → Hold → Zoom Out. Avoid excessive zooming, rapid zoom changes, zooming on insignificant clicks, zooming repeatedly into the same area, losing the overall context.

## 11. SMART DIRECTOR SHOULD UNDERSTAND SCREEN CONTEXT
When possible identify the active application / window / browser / IDE / terminal / design tool / presentation app / document, and major interface transitions. A click inside a design canvas may deserve emphasis; a click on an empty area probably not; repeated menu navigation may be condensed; a major screen transition may become a chapter boundary.

## 12. "NEVER RECORD TWICE" PRINCIPLE
One master → long-form video → short video → vertical video → social clip → GIF → screenshot → thumbnail. Changing the output format should not require another recording.

## 13. AUTOMATIC ASSET STUDIO
After the master is processed, display YOUR CONTENT: MASTER 12:04; GENERATED ASSETS: Polished Demo 12:04 · Quick Demo 3:14 · LinkedIn 0:58 · Vertical Teaser 0:29 · Feature Clip 01 0:17 · Feature Clip 02 0:21 · GIF 01 0:08 · GIF 02 0:11. Also CONTENT: Transcript · Chapters · Titles · Description · Social Copy · Thumbnail Candidates. Clicking any asset opens it for editing.

## 14. POLISHED MASTER VIDEO
The first generated asset is the polished master (same duration). Apply the user's editing profile: cursor smoothing, cursor enhancement, meaningful zooms, silence removal, audio normalization, audio enhancement, camera positioning, background, screen frame, captions if enabled, annotations if suggested, privacy masks, transitions where appropriate. Do not over-edit; it should still feel like the user's original recording.

## 15. AUTOMATIC 3-MINUTE VERSION ("Quick Demo")
Identify the most important information and create a coherent shorter version. Not a speed-up, not the first three minutes. Understand the full recording → identify important sections → remove repetition → remove unnecessary setup → preserve narrative coherence → preserve important interactions → maintain context → standalone beginning and ending. Target 2–4 minutes; user chooses 2 / 3 / 4 / custom.

## 16. AUTOMATIC 60-SECOND LINKEDIN VERSION
~60 s, 16:9 or 1:1. Strongest narrative: HOOK → WHAT IS BEING SHOWN → IMPORTANT INTERACTION → RESULT → ENDING. Do not fabricate a hook; use actual content. User can edit selected segments, captions, framing, title, camera, background, duration. Also generate optional LinkedIn copy based only on the recording.

## 17. AUTOMATIC 30-SECOND VERTICAL TEASER
~30 s, 9:16. Prioritize strongest visual moment, strongest interaction, strongest spoken moment, clear context, fast pacing. Content-aware reframing: the vertical viewport follows the relevant screen region; camera repositioned automatically if enabled; captions adapted for vertical.

## 18. 15-SECOND TEASER
15 s, 9:16, optimized for immediate visual communication: strongest moment, minimal setup, clear visual result, captions, appropriate zoom.

## 19. HIGHLIGHT CLIP GENERATION
Identify moments that can stand alone. Potential highlight signals: feature reveal · visual transformation · successful interaction · before/after · impressive result · important ex… *(text ends here — remainder to be supplied)*
