import type { Cut, RecordingEvents } from '../shared/types'

export interface Range { start: number; end: number }   // seconds, relative to video start

/** Everything removed from the output: recorder pauses plus the user's cuts, merged and clipped to the video. */
export function removedRanges(ev: RecordingEvents, cuts: Cut[] = []): Range[] {
  const dur = ev.videoDuration
  const all: Range[] = [
    ...(ev.pauses ?? []).map(([a, b]) => ({ start: a - ev.t0Video, end: b - ev.t0Video })),
    ...cuts.map(([a, b]) => ({ start: a, end: b })),
  ].map((r) => ({ start: Math.max(0, Math.min(r.start, r.end)), end: Math.min(dur, Math.max(r.start, r.end)) }))
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

/** Kept ranges of the recording: everything except pauses and cuts. */
export function keptRanges(ev: RecordingEvents, cuts: Cut[] = []): Range[] {
  const dur = ev.videoDuration
  const kept: Range[] = []
  let cursor = 0
  for (const c of removedRanges(ev, cuts)) {
    if (c.start > cursor) kept.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (dur > cursor) kept.push({ start: cursor, end: dur })
  return kept.filter((r) => r.end - r.start >= 0.05)
}

export function keptDuration(ev: RecordingEvents, cuts: Cut[] = []): number {
  return keptRanges(ev, cuts).reduce((s, r) => s + (r.end - r.start), 0)
}

/** Output time → source time (what the viewer sees at tOut was recorded at the returned second). */
export function outToSrc(kept: Range[], tOut: number): number {
  let acc = 0
  for (const r of kept) {
    const len = r.end - r.start
    if (tOut <= acc + len) return r.start + (tOut - acc)
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
    if (tSrc <= r.end) return acc + (tSrc - r.start)
    acc += r.end - r.start
  }
  return acc
}
