import type { Analysis, Chapter, Cut, DerivedAsset, RecordingEvents, RenderConfig } from '../shared/types'
import { ASSET_LABEL } from '../shared/types'
import { keptRanges, type Range } from '../video/ranges'

/**
 * Generates the standard derivative set from what the recording itself says (add-on §13–19): the Smart Director's
 * analysis, the master's cuts, chapters and highlights. Nothing is fabricated — every second of every asset is a
 * stretch of the original, chosen by activity, speech and visual change. All results stay editable.
 */
export interface GenInput { ev: RecordingEvents; analysis: Analysis | null; masterCuts: Cut[]; chapters: Chapter[]; highlights: [number, number][]; masterSavedAt: string | null }

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const len = (r: Range) => r.end - r.start

/** Speech ranges = the master's kept time minus detected silences. */
function speech(ev: RecordingEvents, analysis: Analysis | null, kept: Range[]): Range[] {
  const sil = analysis?.signals.silences ?? []
  const out: Range[] = []
  for (const k of kept) {
    let cur = k.start
    for (const [a, b] of sil) {
      if (b <= cur || a >= k.end) continue
      if (a > cur) out.push({ start: cur, end: Math.min(a, k.end) })
      cur = Math.max(cur, b)
    }
    if (cur < k.end) out.push({ start: cur, end: k.end })
  }
  return out.filter((r) => len(r) >= 0.4)
}

/** How much is happening in [a, b): cursor movement, clicks, screen changes. */
function activity(ev: RecordingEvents, analysis: Analysis | null, a: number, b: number): number {
  const t0 = ev.t0Video
  const moves = ev.moves.filter((m) => m[0] - t0 >= a && m[0] - t0 < b).length / 60
  const clicks = ev.clicks.filter((c) => c.type === 'down' && c.t - t0 >= a && c.t - t0 < b).length
  const scenes = (analysis?.signals.scenes ?? []).filter(([t]) => t >= a && t < b).length
  return moves + 3 * clicks + 4 * scenes
}

/** Cut list that keeps exactly `segments` (merged, chronological) and also honours the master's cuts. */
export function cutsFor(ev: RecordingEvents, masterCuts: Cut[], segments: Range[]): Cut[] {
  const dur = ev.videoDuration
  const segs = [...segments].sort((x, y) => x.start - y.start)
  const merged: Range[] = []
  for (const s of segs) { const l = merged[merged.length - 1]; if (l && s.start <= l.end + 0.05) l.end = Math.max(l.end, s.end); else merged.push({ ...s }) }
  const cuts: Cut[] = [...masterCuts]
  let cur = 0
  for (const s of merged) { if (s.start > cur) cuts.push([cur, s.start]); cur = s.end }
  if (cur < dur) cuts.push([cur, dur])
  return cuts
}

/** Split the kept timeline into sections at chapter boundaries (or ~30 s windows when there are none). */
function sections(kept: Range[], chapters: Chapter[], dur: number): Range[] {
  const bounds = chapters.length ? chapters.map((c) => c.t).sort((a, b) => a - b) : Array.from({ length: Math.floor(dur / 30) }, (_, i) => (i + 1) * 30)
  const out: Range[] = []
  for (const k of kept) {
    let cur = k.start
    for (const b of bounds) if (b > cur + 2 && b < k.end - 2) { out.push({ start: cur, end: b }); cur = b }
    out.push({ start: cur, end: k.end })
  }
  return out.filter((r) => len(r) >= 1)
}

/** Pick whole sections by score until the target length is reached; keep the first and last so it still has a beginning and an end. */
function pickSections(ev: RecordingEvents, analysis: Analysis | null, secs: Range[], target: number): Range[] {
  if (!secs.length) return []
  const scored = secs.map((s, i) => ({ s, i, score: activity(ev, analysis, s.start, s.end) / Math.max(3, len(s)) }))
  const chosen = new Set<number>([0, secs.length - 1])
  let total = sum([...chosen].map((i) => len(secs[i])))
  for (const { i, s } of [...scored].sort((a, b) => b.score - a.score)) {
    if (chosen.has(i)) continue
    if (total + len(s) > target * 1.15) continue
    chosen.add(i); total += len(s)
    if (total >= target) break
  }
  return [...chosen].sort((a, b) => a - b).map((i) => secs[i])
}

/** Trim a range to `max` seconds around its busiest part. */
function trimTo(ev: RecordingEvents, analysis: Analysis | null, r: Range, max: number): Range {
  if (len(r) <= max) return r
  let best = r.start, bestScore = -1
  for (let s = r.start; s + max <= r.end + 0.01; s += 0.5) {
    const sc = activity(ev, analysis, s, s + max)
    if (sc > bestScore) { bestScore = sc; best = s }
  }
  return { start: best, end: best + max }
}

function hook(spoken: Range[], max: number): Range | null {
  const first = spoken.find((r) => len(r) >= 1.5) ?? spoken[0]
  return first ? { start: first.start, end: Math.min(first.end, first.start + max) } : null
}
function ending(spoken: Range[], max: number): Range | null {
  const last = [...spoken].reverse().find((r) => len(r) >= 1.5) ?? spoken[spoken.length - 1]
  return last ? { start: Math.max(last.start, last.end - max), end: last.end } : null
}

export function generateAssets(input: GenInput): DerivedAsset[] {
  const { ev, analysis, masterCuts, chapters, highlights, masterSavedAt } = input
  const dur = ev.videoDuration
  const kept = keptRanges(ev, masterCuts)
  const keptLen = sum(kept.map(len))
  const spoken = speech(ev, analysis, kept)
  const hl: Range[] = (highlights.length ? highlights : (analysis?.proposals ?? []).filter((p) => p.type === 'HIGHLIGHT').map((p) => [p.start, p.end] as Cut))
    .map(([a, b]) => ({ start: a, end: b })).sort((a, b) => activity(ev, analysis, b.start, b.end) - activity(ev, analysis, a.start, a.end))
  const now = new Date().toISOString()
  const mk = (kind: DerivedAsset['kind'], name: string, segs: Range[], config: Partial<RenderConfig>, note: string): DerivedAsset | null => {
    const good = segs.filter((s) => len(s) >= 1)
    if (!good.length) return null
    return { id: `${kind}-${Math.random().toString(36).slice(2, 8)}`, kind, name, cuts: cutsFor(ev, masterCuts, good), config, createdAt: now, fromMasterSavedAt: masterSavedAt, note }
  }
  const out: DerivedAsset[] = []

  // Quick Demo — 2–4 minutes of whole sections (shorter recordings: about 40 %), with the first and last section kept.
  const quickTarget = Math.min(180, Math.max(10, keptLen * 0.4))
  if (keptLen > quickTarget * 1.3) {
    const q = mk('quick', ASSET_LABEL.quick, pickSections(ev, analysis, sections(kept, chapters, dur), quickTarget), {},
      `Whole sections ranked by activity, first and last kept, aiming for ${Math.round(quickTarget)} s.`)
    if (q) out.push(q)
  }

  // LinkedIn — ~60 s, 16:9: hook (first spoken stretch) → strongest moments → ending.
  const liTarget = Math.min(60, keptLen * 0.8)
  if (keptLen > 15) {
    const h = hook(spoken, 8), e = ending(spoken, 6)
    const segs: Range[] = []
    let total = 0
    if (h) { segs.push(h); total += len(h) }
    if (e) total += len(e)
    for (const r of hl) { const t = trimTo(ev, analysis, r, Math.max(6, liTarget - total)); if (total + len(t) > liTarget + 3) continue; segs.push(t); total += len(t); if (total >= liTarget) break }
    if (e) segs.push(e)
    const li = mk('linkedin', ASSET_LABEL.linkedin, segs, { aspect: '16:9' }, 'Opening words, the busiest moments, the closing words.')
    if (li) out.push(li)
  }

  // Vertical Teaser — ~30 s, 9:16, camera up top: strongest moment plus the result.
  if (keptLen > 8) {
    const strongest = hl[0] ? trimTo(ev, analysis, hl[0], 20) : trimTo(ev, analysis, kept[Math.floor(kept.length / 2)] ?? kept[0], 20)
    const e = ending(spoken, 8)
    const segs = e && e.start > strongest.end ? [strongest, e] : [strongest]
    const v = mk('vertical', ASSET_LABEL.vertical, segs, { aspect: '9:16', cameraCorner: 'tr', cameraSize: 0.3 }, 'The busiest moment, then the result.')
    if (v) out.push(v)
    // 15-second teaser — the single strongest stretch.
    const t = mk('teaser', ASSET_LABEL.teaser, [trimTo(ev, analysis, strongest, 15)], { aspect: '9:16', cameraCorner: 'tr', cameraSize: 0.3 }, 'The single strongest 15 seconds.')
    if (t) out.push(t)
  }

  // Clips — one per highlight, in the screen's own aspect.
  hl.slice(0, 4).forEach((r, i) => {
    const c = mk('clip', `Clip ${String(i + 1).padStart(2, '0')}`, [trimTo(ev, analysis, r, 20)], {}, 'A highlight that stands on its own.')
    if (c) out.push(c)
  })
  return out
}
