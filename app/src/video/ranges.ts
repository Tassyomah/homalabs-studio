import type { Cut, RecordingEvents, SpeedRange } from '../shared/types'

/** A stretch of the recording in source seconds; `rate` is its playback speed (1 = normal). */
export interface Range { start: number; end: number; rate: number }

/** Everything removed from the output: recorder pauses plus the user's cuts, merged and clipped to the video. */
export function removedRanges(ev: RecordingEvents, cuts: Cut[] = []): Range[] {
  const dur = ev.videoDuration
  const all = [
    ...(ev.pauses ?? []).map(([a, b]) => ({ start: a - ev.t0Video, end: b - ev.t0Video })),
    ...cuts.map(([a, b]) => ({ start: a, end: b })),
  ].map((r) => ({ start: Math.max(0, Math.min(r.start, r.end)), end: Math.min(dur, Math.max(r.start, r.end)), rate: 1 }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start)
  const merged: Range[] = []
  for (const r of all) {
    const last = merged[merged.length - 1]
    if (last && r.start <= last.end) last.end = Math.max(last.end, r.end)
    else merged.push({ ...r })
  }
  return merged
}

/** Kept ranges of the recording: everything except pauses and cuts, split where the playback speed changes. */
export function keptRanges(ev: RecordingEvents, cuts: Cut[] = [], speeds: SpeedRange[] = []): Range[] {
  const dur = ev.videoDuration
  const kept: Range[] = []
  let cursor = 0
  for (const c of removedRanges(ev, cuts)) {
    if (c.start > cursor) kept.push({ start: cursor, end: c.start, rate: 1 })
    cursor = Math.max(cursor, c.end)
  }
  if (dur > cursor) kept.push({ start: cursor, end: dur, rate: 1 })
  // split at speed boundaries and assign the rate
  const bounds = [...new Set(speeds.flatMap((s) => [s.start, s.end]))].sort((a, b) => a - b)
  const out: Range[] = []
  for (const k of kept) {
    let cur = k.start
    for (const b of bounds) if (b > cur && b < k.end) { out.push({ start: cur, end: b, rate: 1 }); cur = b }
    out.push({ start: cur, end: k.end, rate: 1 })
  }
  for (const r of out) {
    const mid = (r.start + r.end) / 2
    const s = speeds.find((x) => mid >= x.start && mid < x.end)
    if (s) r.rate = Math.max(0.25, Math.min(4, s.rate))
  }
  return out.filter((r) => r.end - r.start >= 0.05)
}

/** Output seconds a range takes to play. */
export const playLen = (r: Range) => (r.end - r.start) / r.rate

export function keptDuration(ev: RecordingEvents, cuts: Cut[] = [], speeds: SpeedRange[] = []): number {
  return keptRanges(ev, cuts, speeds).reduce((s, r) => s + playLen(r), 0)
}

/** Output time → source time (what the viewer sees at tOut was recorded at the returned second). */
export function outToSrc(kept: Range[], tOut: number): number {
  let acc = 0
  for (const r of kept) {
    const len = playLen(r)
    if (tOut <= acc + len) return r.start + (tOut - acc) * r.rate
    acc += len
  }
  const last = kept[kept.length - 1]
  return last ? last.end : 0
}

/** Source time → output time. Inside a removed stretch, snaps to the next kept second (or the end). */
export function srcToOut(kept: Range[], tSrc: number): number {
  let acc = 0
  for (const r of kept) {
    if (tSrc < r.start) return acc
    if (tSrc <= r.end) return acc + (tSrc - r.start) / r.rate
    acc += playLen(r)
  }
  return acc
}
