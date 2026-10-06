import type { RecordingEvents } from '../shared/types'

export interface Range { start: number; end: number }   // seconds, relative to video start

/** Kept ranges of the recording: everything except pauses (and, later, user cuts). */
export function keptRanges(ev: RecordingEvents): Range[] {
  const dur = ev.videoDuration
  const cuts: Range[] = (ev.pauses ?? [])
    .map(([a, b]) => ({ start: Math.max(0, a - ev.t0Video), end: Math.min(dur, b - ev.t0Video) }))
    .filter((r) => r.end > r.start)
    .sort((a, b) => a.start - b.start)
  const kept: Range[] = []
  let cursor = 0
  for (const c of cuts) {
    if (c.start > cursor) kept.push({ start: cursor, end: c.start })
    cursor = Math.max(cursor, c.end)
  }
  if (dur > cursor) kept.push({ start: cursor, end: dur })
  return kept.filter((r) => r.end - r.start >= 0.05)
}

export function keptDuration(ev: RecordingEvents): number {
  return keptRanges(ev).reduce((s, r) => s + (r.end - r.start), 0)
}
