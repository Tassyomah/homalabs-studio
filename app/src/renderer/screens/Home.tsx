import { useEffect, useState } from 'react'
import type { Devices, Permissions, Project, UnfinishedRecording } from '../../shared/types'
import { isWin, keys, machine } from '../platform'

type Phase = { kind: 'idle' } | { kind: 'countdown'; n: number } | { kind: 'starting' }

export function Home({ projects, onOpen, onChanged, lastError }: {
  projects: Project[]; onOpen: (p: Project) => void; onChanged: () => void; lastError: string | null
}) {
  const [devices, setDevices] = useState<Devices | null>(null)
  const [perms, setPerms] = useState<Permissions | null>(null)
  const [screen, setScreen] = useState(0)
  const [mic, setMic] = useState<number | null>(null)
  const [countdown, setCountdown] = useState(3)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [error, setError] = useState<string | null>(null)
  const [unfinished, setUnfinished] = useState<UnfinishedRecording[]>([])
  const [recovering, setRecovering] = useState<string | null>(null)   // dir being recovered
  const [level, setLevel] = useState(0)

  const loadPerms = (request = false) => window.narrate.checkPermissions(request).then(setPerms)
  useEffect(() => {
    loadPerms()
    window.narrate.listUnfinished().then(setUnfinished).catch(() => {})
    window.narrate.listDevices().then((d) => {
      setDevices(d)
      const builtIn = d.mics.find((m) => /Microphone/.test(m.name) && !/iPhone/.test(m.name)) ?? d.mics[0]
      setMic(builtIn ? builtIn.index : null)
    }).catch((e) => setError(String(e)))
  }, [])
  useEffect(() => { if (lastError) setError(lastError) }, [lastError])

  // Live input level for the selected microphone while idle on this screen (spec §14).
  useEffect(() => {
    if (mic === null || phase.kind !== 'idle' || !isWin) { setLevel(0); return }
    window.narrate.startMicMeter(mic)
    const off = window.narrate.onMicLevel(setLevel)
    return () => { off(); window.narrate.stopMicMeter(); setLevel(0) }
  }, [mic, phase.kind])

  const recover = async (u: UnfinishedRecording) => {
    setRecovering(u.dir); setError(null)
    try {
      const p = await window.narrate.recoverRecording(u.dir)
      setUnfinished((l) => l.filter((x) => x.dir !== u.dir)); onChanged(); onOpen(p)
    } catch (e) { setError(`This recording could not be recovered. ${(e as Error).message}`) }
    finally { setRecovering(null) }
  }
  const discard = async (u: UnfinishedRecording) => {
    if (!confirm(`Move the unfinished recording from ${fmtDate(u.startedAt)} to the Bin?`)) return
    await window.narrate.trashProject(u.dir)
    setUnfinished((l) => l.filter((x) => x.dir !== u.dir))
  }

  const begin = async () => {
    setError(null)
    for (let n = countdown; n > 0; n--) { setPhase({ kind: 'countdown', n }); await new Promise((r) => setTimeout(r, 1000)) }
    setPhase({ kind: 'starting' })
    try { await window.narrate.startRecording({ screen, mic, fps: 60 }) }
    catch (e) { setError(friendly((e as Error).message)); setPhase({ kind: 'idle' }) }
  }

  if (phase.kind === 'countdown') return (
    <div className="recording"><div className="timer">{phase.n}</div><p className="note">Recording starts in a moment. Switch to what you want to show.</p>
      <button onClick={() => setPhase({ kind: 'idle' })}>Cancel</button></div>
  )
  if (phase.kind === 'starting') return <div className="recording"><p className="note">Preparing recording…</p></div>

  const needsScreen = perms && !perms.screen
  const micBlocked = perms?.mic === 'denied'
  return (
    <>
      <h1>Record now, talk later.</h1>
      <p className="lede">Capture the screen on its own. The cursor, zooms and framing are added for you afterwards.</p>

      {needsScreen && (
        <div className="permission">
          <b>Narrate needs permission to record the screen.</b>
          <p>macOS asks once. Nothing is captured until you press Record, and recordings stay on {machine}.
             After allowing it, quit and reopen the app.</p>
          <div className="row">
            <button className="primary" onClick={() => loadPerms(true)}>Allow screen recording</button>
            <button onClick={() => window.narrate.openSettings('screen')}>Open System Settings</button>
          </div>
        </div>
      )}
      {unfinished.map((u) => (
        <div className="permission" key={u.dir}>
          <b>We recovered an unsaved recording.</b>
          <p>Started {fmtDate(u.startedAt)} · {u.display.width}×{u.display.height}{u.mic ? ` · ${u.mic}` : ''}.
             Narrate closed before it was saved. Restore it to finish saving and open it in the editor.</p>
          <div className="row">
            <button className="primary" disabled={!!recovering} onClick={() => recover(u)}>{recovering === u.dir ? 'Restoring…' : 'Restore'}</button>
            <button disabled={!!recovering} onClick={() => discard(u)}>Discard</button>
          </div>
        </div>
      ))}
      {micBlocked && (
        <div className="permission">
          <b>Microphone access is turned off for desktop apps.</b>
          <p>{isWin ? 'Turn on "Let desktop apps access your microphone" in Windows Settings, then come back. You can still record without a microphone.'
                    : 'Allow Narrate under Privacy & Security → Microphone, then reopen the app. You can still record without a microphone.'}</p>
          <div className="row">
            <button onClick={() => window.narrate.openSettings('mic')}>{isWin ? 'Open Windows Settings' : 'Open System Settings'}</button>
            <button onClick={() => loadPerms()}>Check again</button>
          </div>
        </div>
      )}

      <div className="row">
        <div className="field"><label>Display</label>
          <select value={screen} onChange={(e) => setScreen(Number(e.target.value))}>
            {devices?.displays.map((d) => <option key={d.ordinal} value={d.ordinal}>{d.name} · {d.width}×{d.height}</option>)}
          </select></div>
        <div className="field"><label>Microphone</label>
          <select value={mic ?? ''} onChange={(e) => setMic(e.target.value === '' ? null : Number(e.target.value))}>
            <option value="">No microphone</option>
            {devices?.mics.map((m) => <option key={m.index} value={m.index}>{m.name}</option>)}
          </select>
          {devices && devices.mics.length === 0 && <span className="note">No microphone detected.</span>}
          {mic !== null && isWin && <div className="meter" title="Microphone level"><i style={{ width: `${Math.round(level * 100)}%` }} /></div>}</div>
        <div className="field"><label>Countdown</label>
          <select value={countdown} onChange={(e) => setCountdown(Number(e.target.value))}>
            <option value={0}>Immediate</option><option value={3}>3 seconds</option><option value={5}>5 seconds</option>
          </select></div>
        <div className="field"><label>&nbsp;</label>
          <button className="record" disabled={!devices || !!needsScreen} onClick={begin}>Record</button></div>
      </div>
      <p className="note">While recording: {keys.pause} pause / resume · {keys.stop} stop. A small control bar stays on screen.</p>
      {error && <p className="err">{error}</p>}

      <h2>Recordings</h2>
      {projects.length === 0 ? <div className="empty">Your recordings will appear here.</div> : (
        <div className="cards">
          {projects.map((p) => (
            <div className="card" key={p.dir} onClick={() => onOpen(p)}>
              <video className="thumb" src={p.assets.screen + '#t=0.5'} muted preload="metadata" />
              <div className="meta"><b>{p.name}</b><span>{fmt(p.events.videoDuration)} · {p.events.display.width}×{p.events.display.height}</span>
                <button onClick={(e) => { e.stopPropagation(); window.narrate.trashProject(p.dir).then(onChanged) }}>Bin</button></div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const fmtDate = (iso: string) => { const d = new Date(iso); return isNaN(d.getTime()) ? iso : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) }
function friendly(msg: string) {
  if (/ffmpeg is not installed|Python 3/i.test(msg)) return msg
  if (/microphone/i.test(msg)) return msg
  if (isWin) {
    if (/no frames/i.test(msg)) return 'The screen capture produced no frames. Make sure ffmpeg is installed (winget install Gyan.FFmpeg) and try again.\n' + msg
    return msg
  }
  if (/permission/i.test(msg)) return 'macOS is blocking screen recording for this app. Allow it in System Settings → Privacy & Security → Screen Recording, then reopen Narrate.'
  if (/no frames/i.test(msg)) return 'The screen capture produced no frames. This is almost always the Screen Recording permission. Allow it and reopen Narrate.'
  return msg
}
