import { useEffect, useState } from 'react'
import { keys } from '../platform'

/** The floating always-on-top bar shown while recording: timer, pause/resume, stop. */
export function ControlBar() {
  const [state, setState] = useState<'recording' | 'paused' | 'finalizing' | 'idle'>('recording')
  const [clock, setClock] = useState({ since: Date.now(), pausedTotal: 0, startedAt: Date.now() })
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const sync = () => window.narrate.getRecState().then((s) => { setState(s.state as typeof state); setClock(s) })
    sync()
    const i = setInterval(() => setNow(Date.now()), 200)
    const off = window.narrate.onRecorderEvent(() => sync())
    return () => { clearInterval(i); off() }
  }, [])

  const elapsed = Math.max(0, (state === 'paused' ? clock.since : now) - clock.startedAt - clock.pausedTotal)
  const s = Math.floor(elapsed / 1000)
  const time = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`

  return (
    <div className="bar drag">
      <span className={state === 'paused' ? 'dot paused' : state === 'finalizing' ? 'dot off' : 'dot'} />
      <span className="time">{state === 'finalizing' ? 'Saving…' : time}</span>
      <span className="spacer" />
      {state === 'recording' && <button className="no-drag" title={`Pause (${keys.pause})`} onClick={() => window.narrate.pauseRecording()}>Pause</button>}
      {state === 'paused' && <button className="no-drag" title={`Resume (${keys.pause})`} onClick={() => window.narrate.resumeRecording()}>Resume</button>}
      {state !== 'finalizing' && <button className="no-drag stop" title={`Stop (${keys.stop})`} onClick={() => window.narrate.stopRecording()}>Stop</button>}
    </div>
  )
}
