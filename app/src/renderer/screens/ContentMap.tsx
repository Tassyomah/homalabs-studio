import type { Chapter, Transcript } from '../../shared/types'
import { fmt } from './Timeline'

/**
 * Content map (add-on §6): the recording as sections. Chapters come from the Smart Director (screen changes) or the
 * user; the description under each is the first sentence spoken after the boundary, so the map reads like an outline.
 */
export function ContentMap({ chapters, transcript, duration, onSeek, onRename, onRemove, onAddHere, playhead }: {
  chapters: Chapter[]; transcript: Transcript | null; duration: number; playhead: number
  onSeek: (t: number) => void; onRename: (i: number, title: string) => void; onRemove: (i: number) => void; onAddHere: () => void
}) {
  const rows = [{ t: 0, title: 'Start', fixed: true as const }, ...chapters.map((c) => ({ ...c, fixed: false as const }))].sort((a, b) => a.t - b.t)
  const firstLine = (t: number, next: number) => transcript?.segments.find((s) => s.start >= t - 0.3 && s.start < next)?.text ?? null
  return (
    <div className="director contentmap">
      <div className="head">
        <div><b>Content map</b> <span className="hint">· {rows.length} section{rows.length === 1 ? '' : 's'} · {fmt(duration)}</span></div>
        <div className="row"><button onClick={onAddHere} title="Start a new section at the playhead">Add section here</button></div>
      </div>
      <div className="sections">
        {rows.map((r, i) => {
          const next = rows[i + 1]?.t ?? duration
          const live = playhead >= r.t && playhead < next
          const idx = chapters.indexOf(r as Chapter)
          return (
            <div key={i} className={`section ${live ? 'live' : ''}`}>
              <button className="when" onClick={() => onSeek(r.t)}>{fmt(r.t)}</button>
              <div className="body">
                {r.fixed ? <b>{r.title}</b> : <input className="inline" value={r.title} onChange={(e) => onRename(idx, e.target.value)} />}
                <span className="desc">{firstLine(r.t, next) ?? `${fmt(next - r.t)} long`}</span>
              </div>
              {!r.fixed && <button onClick={() => onRemove(idx)}>Remove</button>}
            </div>
          )
        })}
      </div>
    </div>
  )
}
