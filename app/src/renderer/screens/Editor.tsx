import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import { Screencast, compositionSize } from '../../video/Screencast'
import { keptDuration, keptRanges, outToSrc, srcToOut } from '../../video/ranges'
import { ASPECTS, defaultConfig, type Analysis, type Background, type CameraCorner, type CameraShape, type Chapter, type Cut, type ExportProgress, type Project, type Proposal, type RenderConfig, type ScreencastProps } from '../../shared/types'
import { revealLabel } from '../platform'
import { Timeline, fmt } from './Timeline'
import { Director, type DirectorState, type DirectorStatus } from './Director'

const FPS = 60
const SHAPE: Record<CameraShape, string> = { off: 'Hidden', circle: 'Circle', rounded: 'Rounded' }
const BGS: { id: Background; label: string; css: string }[] = [
  { id: 'indigo', label: 'Indigo', css: 'linear-gradient(135deg,#6E71E8,#8B78D6)' },
  { id: 'coral', label: 'Coral', css: 'linear-gradient(135deg,#FB8B73,#F5C36A)' },
  { id: 'ink', label: 'Ink', css: '#14140F' },
  { id: 'paper', label: 'Paper', css: '#EFEEE8' },
]

/** Everything the user can change; one snapshot per undo step. */
type Edits = { config: RenderConfig; cuts: Cut[]; chapters: Chapter[]; highlights: [number, number][]; director: DirectorState }

export function Editor({ project }: { project: Project }) {
  // Saved edits win; defaults fill in settings that did not exist when the project was last saved.
  const [edits, setEdits] = useState<Edits>(() => ({
    config: { ...defaultConfig, ...(project.file?.config ?? {}) }, cuts: project.file?.cuts ?? [],
    chapters: project.file?.chapters ?? [], highlights: project.file?.highlights ?? [],
    director: project.file?.director ?? { accepted: [], rejected: [] },
  }))
  const { config, cuts, chapters, highlights, director } = edits
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [dstatus, setDstatus] = useState<DirectorStatus>({ kind: 'idle' })
  const history = useRef<{ past: Edits[]; future: Edits[] }>({ past: [], future: [] })
  const dirty = useRef(false)
  const [, bump] = useState(0)
  const [prog, setProg] = useState<ExportProgress | null>(null)
  const [playheadSrc, setPlayheadSrc] = useState(0)
  const [pendingCut, setPendingCut] = useState<number | null>(null)
  const playerRef = useRef<PlayerRef>(null)
  useEffect(() => window.narrate.onExportProgress(setProg), [])

  /** Apply a change as a new undo step. */
  const apply = useCallback((next: (e: Edits) => Edits) => {
    setEdits((e) => {
      const n = next(e)
      history.current.past.push(e); history.current.future = []
      if (history.current.past.length > 100) history.current.past.shift()
      dirty.current = true
      return n
    })
  }, [])
  const set = <K extends keyof RenderConfig>(k: K, v: RenderConfig[K]) => apply((e) => ({ ...e, config: { ...e.config, [k]: v } }))
  const undo = () => { const p = history.current.past.pop(); if (!p) return; history.current.future.push(edits); dirty.current = true; setEdits(p); bump((n) => n + 1) }
  const redo = () => { const f = history.current.future.pop(); if (!f) return; history.current.past.push(edits); dirty.current = true; setEdits(f); bump((n) => n + 1) }

  // Autosave (spec §61): every change is written to project.json shortly after it happens.
  useEffect(() => {
    if (!dirty.current) return
    const t = setTimeout(() => {
      window.narrate.saveProject(project.dir, { version: 1, config, cuts, chapters, highlights, director, savedAt: new Date().toISOString() })
        .catch((e) => console.warn('autosave failed', e))
    }, 400)
    return () => clearTimeout(t)
  }, [config, cuts, chapters, highlights, director, project.dir])

  // Smart Director (add-on §7–9): analyse on first open (cached in analysis.json afterwards), show progress meanwhile.
  const runAnalysis = useCallback((force = false) => {
    setDstatus({ kind: 'running', step: 'audio' })
    window.narrate.analyzeProject(project.dir, force)
      .then((a) => { setAnalysis(a); setDstatus({ kind: 'idle' }) })
      .catch((e: Error) => setDstatus(/not available/i.test(e.message) ? { kind: 'unavailable', message: e.message } : { kind: 'error', message: e.message }))
  }, [project.dir])
  useEffect(() => { runAnalysis(false) }, [runAnalysis])
  useEffect(() => window.narrate.onRecorderEvent((e) => { if (e.event === 'analyzing' && e.step !== 'done') setDstatus({ kind: 'running', step: e.step }) }), [])

  const acceptProposal = (e: Edits, p: Proposal): Edits => {
    const d = { ...e.director, accepted: [...e.director.accepted.filter((id) => id !== p.id), p.id], rejected: e.director.rejected.filter((id) => id !== p.id) }
    if (p.type === 'REMOVE') return { ...e, director: d, cuts: [...e.cuts, [p.start, p.end]] }
    if (p.type === 'CHAPTER') return { ...e, director: d, chapters: [...e.chapters.filter((c) => Math.abs(c.t - p.start) > 0.5), { t: p.start, title: `Section ${e.chapters.length + 2}` }].sort((a, b) => a.t - b.t) }
    if (p.type === 'HIGHLIGHT') return { ...e, director: d, highlights: [...e.highlights, [p.start, p.end]] }
    return { ...e, director: d }
  }
  const onAccept = (p: Proposal) => apply((e) => acceptProposal(e, p))
  const onAcceptAll = (ps: Proposal[]) => apply((e) => ps.reduce(acceptProposal, e))
  const onReject = (p: Proposal) => apply((e) => ({ ...e, director: { ...e.director, rejected: [...e.director.rejected, p.id], accepted: e.director.accepted.filter((id) => id !== p.id) } }))
  const onDismiss = () => apply((e) => ({ ...e, director: { ...e.director, dismissedAt: new Date().toISOString() } }))

  // Keyboard: Z / Y with Ctrl or ⌘ for undo / redo; space is the player's own.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo() }
      if (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey)) { e.preventDefault(); redo() }
    }
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h)
  })

  const props: ScreencastProps = useMemo(() => ({ assets: project.assets, events: project.events, config, cuts }), [project, config, cuts])
  const size = compositionSize(props)
  const kept = useMemo(() => keptRanges(project.events, cuts), [project.events, cuts])
  const frames = Math.max(1, Math.ceil(keptDuration(project.events, cuts) * FPS))
  const pauses = project.events.pauses?.length ?? 0
  const busy = prog && (prog.stage === 'bundling' || prog.stage === 'rendering')

  // Player ↔ timeline: the player runs in output time, the timeline shows source time.
  useEffect(() => {
    const p = playerRef.current; if (!p) return
    const h = (e: { detail: { frame: number } }) => setPlayheadSrc(outToSrc(kept, e.detail.frame / FPS))
    p.addEventListener('frameupdate', h); return () => p.removeEventListener('frameupdate', h)
  }, [kept])
  const seekSrc = (tSrc: number) => {
    const t = Math.max(0, Math.min(project.events.videoDuration, tSrc))
    setPlayheadSrc(t); playerRef.current?.seekTo(Math.round(srcToOut(kept, t) * FPS))
  }

  // Cutting (spec §39): trim to the playhead, or mark a start then an end. All reversible.
  const dur = project.events.videoDuration
  const addCut = (a: number, b: number) => { if (Math.abs(b - a) >= 0.1) apply((e) => ({ ...e, cuts: [...e.cuts, [Math.min(a, b), Math.max(a, b)]] })) }
  const trimStart = () => addCut(0, playheadSrc)
  const trimEnd = () => addCut(playheadSrc, dur)
  const cutHere = () => { if (pendingCut === null) setPendingCut(playheadSrc); else { addCut(pendingCut, playheadSrc); setPendingCut(null) } }
  const restore = (i: number) => apply((e) => ({ ...e, cuts: e.cuts.filter((_, k) => k !== i) }))
  const sortedCuts = cuts.map((c, i) => ({ c, i })).sort((x, y) => x.c[0] - y.c[0])

  return (
    <div className="editor">
      <div className="work">
        <div className="stage">
          <Player ref={playerRef} component={Screencast} inputProps={props} durationInFrames={frames} fps={FPS}
            compositionWidth={size.width} compositionHeight={size.height} controls
            style={{ width: '100%', height: '100%' }} />
        </div>
        <div className="tools">
          <button onClick={trimStart} disabled={playheadSrc < 0.1} title="Remove everything before the playhead">Trim start here</button>
          <button onClick={trimEnd} disabled={playheadSrc > dur - 0.1} title="Remove everything after the playhead">Trim end here</button>
          <button className={pendingCut !== null ? 'primary' : ''} onClick={cutHere}>{pendingCut === null ? 'Cut from here…' : '…to here'}</button>
          {pendingCut !== null && <button onClick={() => setPendingCut(null)}>Cancel</button>}
          <span className="spacer" />
          <span className="hint">{pendingCut !== null ? `Cutting from ${fmt(pendingCut)}. Move the playhead and click “…to here”.` : `Output ${fmt(keptDuration(project.events, cuts))} of ${fmt(dur)} recorded`}</span>
          <button onClick={undo} disabled={history.current.past.length === 0} title="Undo (Ctrl+Z)">Undo</button>
          <button onClick={redo} disabled={history.current.future.length === 0} title="Redo (Ctrl+Y)">Redo</button>
        </div>
        <Timeline ev={project.events} cuts={cuts} chapters={chapters} highlights={highlights} playhead={playheadSrc} pendingCut={pendingCut} onSeek={seekSrc} />
        <Director analysis={analysis} status={dstatus} state={director} onAccept={onAccept} onReject={onReject} onAcceptAll={onAcceptAll}
          onDismiss={onDismiss} onSeek={seekSrc} onRerun={() => runAnalysis(true)} />
        {sortedCuts.length > 0 && (
          <div className="cuts">
            {sortedCuts.map(({ c, i }) => (
              <div key={i}><span>Removed {fmt(c[0])} – {fmt(c[1])}</span><button onClick={() => restore(i)}>Restore</button></div>
            ))}
          </div>
        )}
        {chapters.length > 0 && (
          <div className="cuts">
            {chapters.map((c, i) => (
              <div key={i}><span>Chapter · <button className="when" onClick={() => seekSrc(c.t)}>{fmt(c.t)}</button> <input className="inline" value={c.title}
                onChange={(e) => apply((ed) => ({ ...ed, chapters: ed.chapters.map((x, k) => k === i ? { ...x, title: e.target.value } : x) }))} /></span>
                <button onClick={() => apply((ed) => ({ ...ed, chapters: ed.chapters.filter((_, k) => k !== i) }))}>Remove</button></div>
            ))}
          </div>
        )}
      </div>
      <div className="panel">
        <h2>Format</h2>
        <div className="control"><div className="lbl"><span>Aspect</span><span>{config.aspect === 'source' ? `${project.events.display.width}×${project.events.display.height}` : config.aspect}</span></div>
          <div className="seg">{ASPECTS.map((a) => (
            <button key={a.id} className={config.aspect === a.id ? 'on' : ''} onClick={() => set('aspect', a.id)}>{a.label}</button>))}</div>
          {config.aspect !== 'source' && ASPECTS.find((a) => a.id === config.aspect)!.ratio! < 1 &&
            <span className="note">Vertical and square formats crop the screen and follow the cursor and clicks.</span>}</div>

        <h2>Look</h2>
        <div className="control"><div className="lbl"><span>Auto-zoom</span><span>{config.zoom === 1 ? 'off' : config.zoom.toFixed(1) + '×'}</span></div>
          <input type="range" min={1} max={3} step={0.1} value={config.zoom} onChange={(e) => set('zoom', Number(e.target.value))} /></div>
        <div className="control"><div className="lbl"><span>Padding</span><span>{Math.round(config.padding * 100)}%</span></div>
          <input type="range" min={0} max={0.2} step={0.01} value={config.padding} onChange={(e) => set('padding', Number(e.target.value))} /></div>
        <div className="control"><div className="lbl"><span>Corner radius</span><span>{config.radius}px</span></div>
          <input type="range" min={0} max={64} step={2} value={config.radius} onChange={(e) => set('radius', Number(e.target.value))} /></div>
        <div className="control"><div className="lbl"><span>Cursor size</span><span>{config.cursorScale.toFixed(1)}×</span></div>
          <input type="range" min={1} max={3} step={0.1} value={config.cursorScale} onChange={(e) => set('cursorScale', Number(e.target.value))} /></div>
        <div className="control"><div className="lbl"><span>Background</span></div>
          <div className="seg">{BGS.map((b) => (
            <button key={b.id} className={config.background === b.id ? 'on' : ''} onClick={() => set('background', b.id)}>
              <span className="swatch" style={{ background: b.css }} /></button>))}</div></div>

        {project.assets.camera && (<>
          <h2>Camera</h2>
          <div className="control"><div className="lbl"><span>Shape</span></div>
            <div className="seg">{(['off', 'circle', 'rounded'] as CameraShape[]).map((s) => (
              <button key={s} className={config.cameraShape === s ? 'on' : ''} onClick={() => set('cameraShape', s)}>{SHAPE[s]}</button>))}</div></div>
          {config.cameraShape !== 'off' && (<>
            <div className="control"><div className="lbl"><span>Size</span><span>{Math.round(config.cameraSize * 100)}%</span></div>
              <input type="range" min={0.1} max={0.4} step={0.01} value={config.cameraSize} onChange={(e) => set('cameraSize', Number(e.target.value))} /></div>
            <div className="control"><div className="lbl"><span>Corner</span></div>
              <select value={config.cameraCorner} onChange={(e) => set('cameraCorner', e.target.value as CameraCorner)}>
                <option value="br">Bottom right</option><option value="bl">Bottom left</option>
                <option value="tr">Top right</option><option value="tl">Top left</option>
              </select></div>
            <div className="control"><div className="lbl"><span>Mirror</span></div>
              <div className="seg">
                <button className={config.cameraMirror ? 'on' : ''} onClick={() => set('cameraMirror', true)}>Mirrored</button>
                <button className={!config.cameraMirror ? 'on' : ''} onClick={() => set('cameraMirror', false)}>As seen by others</button>
              </div></div>
          </>)}
        </>)}

        {(project.assets.mic || project.assets.system) && (<>
          <h2>Sound</h2>
          {project.assets.mic && <div className="control"><div className="lbl"><span>Voice</span><span>{config.micVolume === 0 ? 'muted' : Math.round(config.micVolume * 100) + '%'}</span></div>
            <input type="range" min={0} max={1.5} step={0.05} value={config.micVolume} onChange={(e) => set('micVolume', Number(e.target.value))} /></div>}
          {project.assets.system && <div className="control"><div className="lbl"><span>Computer sound</span><span>{config.systemVolume === 0 ? 'muted' : Math.round(config.systemVolume * 100) + '%'}</span></div>
            <input type="range" min={0} max={1.5} step={0.05} value={config.systemVolume} onChange={(e) => set('systemVolume', Number(e.target.value))} /></div>}
        </>)}

        <h2>Export</h2>
        <div className="control"><div className="lbl"><span>Size</span></div>
          <div className="seg">{[1080, 1440, 0].map((h) => (
            <button key={h} className={config.outputHeight === h ? 'on' : ''} onClick={() => set('outputHeight', h)}>{h ? h + 'p' : 'Source'}</button>))}</div></div>
        <button className="primary" disabled={!!busy} onClick={() => { setProg({ stage: 'bundling', progress: 0 }); window.narrate.exportProject(project.dir, config, cuts).catch(() => {}) }}>
          {busy ? (prog!.stage === 'bundling' ? 'Preparing…' : `Rendering ${Math.round(prog!.progress * 100)}%`) : 'Export MP4'}
        </button>
        {busy && <div className="progress"><i style={{ width: `${prog!.progress * 100}%` }} /></div>}
        {prog?.stage === 'done' && prog.output && <button onClick={() => window.narrate.reveal(prog.output!)}>{revealLabel}</button>}
        {prog?.stage === 'error' && <p className="err">{prog.message}</p>}
        {pauses > 0 && <p className="note">{pauses} pause{pauses > 1 ? "s" : ""} removed automatically.</p>}
        <p className="note">Not yet available: captions, narration takes, share links. They are on the roadmap, not hidden behind buttons.</p>
      </div>
    </div>
  )
}
