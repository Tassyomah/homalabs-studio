import { useEffect, useState } from 'react'
import type { RecorderEvent } from '../../shared/types'

const STEP: Record<string, string> = { video: 'Saving video…', audio: 'Preparing audio…' }

/** Shown in the main window while recording (it is hidden) and during finalisation. */
export function Recording({ lastEvent }: { lastEvent: RecorderEvent | null }) {
  const [clock, setClock] = useState({ state: 'recording', since: Date.now(), pausedTotal: 0, startedAt: Date.now() })
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    window.narrate.getRecState().then((s) => setClock(s))
    const i = setInterval(() => setNow(Date.now()), 250); return () => clearInterval(i)
  }, [lastEvent])

  const finalizing = lastEvent?.event === 'stopped' || lastEvent?.event === 'finalizing'
  if (finalizing) return (
    <div className="recording">
      <div className="spinner" />
      <p className="note">{lastEvent?.event === 'finalizing' ? STEP[lastEvent.step] : 'Stopping…'} Your recording is safe.</p>
    </div>
  )
  const paused = clock.state === 'paused'
  const elapsed = Math.max(0, (paused ? clock.since : now) - clock.startedAt - clock.pausedTotal)
  return (
    <div className="recording">
      <div className="timer"><span className={paused ? 'dot paused' : 'dot'} />{fmt(elapsed)}</div>
      <p className="note">{paused ? 'Paused.' : 'Recording.'} Use the control bar at the bottom right, or ⌘⇧P / ⌘⇧S.</p>
      <div className="row">
        {paused ? <button onClick={() => window.narrate.resumeRecording()}>Resume</button>
                : <button onClick={() => window.narrate.pauseRecording()}>Pause</button>}
        <button className="primary" onClick={() => window.narrate.stopRecording()}>Stop</button>
      </div>
    </div>
  )
}
export const fmt = (ms: number) => { const s = Math.floor(ms / 1000); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` }
