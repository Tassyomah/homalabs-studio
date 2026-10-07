import { useMemo } from 'react'
import type { Cut, RecordingEvents } from '../../shared/types'
import { keptRanges, removedRanges, type Range } from '../../video/ranges'

/**
 * The recording's timeline in source time: kept stretches, recorder pauses and user cuts, with the playhead.
 * Click anywhere to seek. Editing happens through the buttons above it (trim / cut / restore), never by dragging
 * tiny handles — the spec wants a simple editor first (§2, §36).
 */
export function Timeline({ ev, cuts, playhead, pendingCut, onSeek }: {
  ev: RecordingEvents; cuts: Cut[]; playhead: number; pendingCut: number | null; onSeek: (tSrc: number) => void
}) {
  const dur = ev.videoDuration
  const kept = useMemo(() => keptRanges(ev, cuts), [ev, cuts])
  const pauses = useMemo(() => removedRanges(ev, []), [ev])
  const userCuts = useMemo(() => removedRanges({ ...ev, pauses: [] }, cuts), [ev, cuts])
  const pct = (t: number) => `${(Math.max(0, Math.min(dur, t)) / dur) * 100}%`
  const width = (r: Range) => `${((r.end - r.start) / dur) * 100}%`

  return (
    <div className="timeline">
      <div className="track" onClick={(e) => {
        const box = e.currentTarget.getBoundingClientRect()
        onSeek(((e.clientX - box.left) / box.width) * dur)
      }}>
        {kept.map((r, i) => <div key={'k' + i} className="kept" style={{ left: pct(r.start), width: width(r) }} />)}
        {pauses.map((r, i) => <div key={'p' + i} className="pause" style={{ left: pct(r.start), width: width(r) }} title="Pause (removed automatically)" />)}
        {userCuts.map((r, i) => <div key={'c' + i} className="cut" style={{ left: pct(r.start), width: width(r) }} title={`Removed ${fmt(r.start)}–${fmt(r.end)}`} />)}
        {pendingCut !== null && (
          <div className="pending" style={{ left: pct(Math.min(pendingCut, playhead)), width: pct(Math.abs(playhead - pendingCut)) }} />
        )}
        {ev.clicks.filter((c) => c.type === 'down').map((c, i) => (
          <i key={'d' + i} className="click" style={{ left: pct(c.t - ev.t0Video) }} />
        ))}
        <div className="playhead" style={{ left: pct(playhead) }} />
      </div>
      <div className="scale"><span>0:00</span><span>{fmt(playhead)}</span><span>{fmt(dur)}</span></div>
    </div>
  )
}

export const fmt = (s: number) => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60), tenths = Math.floor((s % 1) * 10)
  return `${m}:${String(sec).padStart(2, '0')}.${tenths}`
}
