import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import { Screencast, compositionSize } from '../../video/Screencast'
import { keptDuration, keptRanges, outToSrc, srcToOut } from '../../video/ranges'
import { ASPECTS, ASSET_LABEL, defaultConfig, type Analysis, type Background, type CameraCorner, type CameraShape, type CaptionStyle, type Chapter, type Cut, type DerivedAsset, type ExportProgress, type ManualZoom, type Project, type Proposal, type RenderConfig, type ScreencastProps, type SpeedRange, type Transcript, type TranscriptSegment } from '../../shared/types'
import { smoothCursor } from '../../video/motion'
import { revealLabel } from '../platform'
import { Timeline, fmt } from './Timeline'
import { Director, type DirectorState, type DirectorStatus } from './Director'
import { TranscriptPanel, fillerRanges, type TranscribeStatus } from './TranscriptPanel'
import { ContentMap } from './ContentMap'
import { generateAssets } from '../generate'

const FPS = 60
const fmtShort = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const SHAPE: Record<CameraShape, string> = { off: 'Hidden', circle: 'Circle', rounded: 'Rounded' }
const BGS: { id: Background; label: string; css: string }[] = [
  { id: 'indigo', label: 'Indigo', css: 'linear-gradient(135deg,#6E71E8,#8B78D6)' },
  { id: 'coral', label: 'Coral', css: 'linear-gradient(135deg,#FB8B73,#F5C36A)' },
  { id: 'ink', label: 'Ink', css: '#14140F' },
  { id: 'paper', label: 'Paper', css: '#EFEEE8' },
]

/** Everything the user can change; one snapshot per undo step. */
type Edits = { config: RenderConfig; cuts: Cut[]; assets: DerivedAsset[]; zooms: ManualZoom[]; speeds: SpeedRange[]; chapters: Chapter[]; highlights: [number, number][]; director: DirectorState }

export function Editor({ project }: { project: Project }) {
  // Saved edits win; defaults fill in settings that did not exist when the project was last saved.
  const [edits, setEdits] = useState<Edits>(() => ({
    config: { ...defaultConfig, ...(project.file?.config ?? {}) }, cuts: project.file?.cuts ?? [],
    assets: project.file?.assets ?? [], zooms: project.file?.zooms ?? [], speeds: project.file?.speeds ?? [],
    chapters: project.file?.chapters ?? [], highlights: project.file?.highlights ?? [],
    director: project.file?.director ?? { accepted: [], rejected: [] },
  }))
  const { assets, zooms, speeds, chapters, highlights, director } = edits
  // Which asset is being edited: the master, or one derivative (add-on §5: derivatives stay editable).
  const [selected, setSelected] = useState<string>('master')
  const asset = assets.find((a) => a.id === selected) ?? null
  const config: RenderConfig = asset ? { ...edits.config, ...asset.config } : edits.config
  const cuts: Cut[] = asset ? asset.cuts : edits.cuts
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [dstatus, setDstatus] = useState<DirectorStatus>({ kind: 'idle' })
  const [transcript, setTranscript] = useState<Transcript | null>(project.transcript)
  const [tstatus, setTstatus] = useState<TranscribeStatus>({ kind: 'idle' })
  const history = useRef<{ past: Edits[]; future: Edits[] }>({ past: [], future: [] })
  const dirty = useRef(false)
  const [, bump] = useState(0)
  const [prog, setProg] = useState<ExportProgress | null>(null)
  const [queue, setQueue] = useState<{ total: number; done: number; current: string } | null>(null)
  const [format, setFormat] = useState<'mp4' | 'gif'>('mp4')
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
  /** Edit the selected asset's config (override) or the master's. */
  const set = <K extends keyof RenderConfig>(k: K, v: RenderConfig[K]) => apply((e) => asset
    ? { ...e, assets: e.assets.map((a) => a.id === asset.id ? { ...a, config: { ...a.config, [k]: v } } : a) }
    : { ...e, config: { ...e.config, [k]: v } })
  /** Edit the selected asset's cut list or the master's. */
  const setCuts = (f: (c: Cut[]) => Cut[]) => apply((e) => asset
    ? { ...e, assets: e.assets.map((a) => a.id === asset.id ? { ...a, cuts: f(a.cuts) } : a) }
    : { ...e, cuts: f(e.cuts) })
  const undo = () => { const p = history.current.past.pop(); if (!p) return; history.current.future.push(edits); dirty.current = true; setEdits(p); bump((n) => n + 1) }
  const redo = () => { const f = history.current.future.pop(); if (!f) return; history.current.past.push(edits); dirty.current = true; setEdits(f); bump((n) => n + 1) }

  // Autosave (spec §61): every change is written to project.json shortly after it happens.
  useEffect(() => {
    if (!dirty.current) return
    const t = setTimeout(() => {
      window.narrate.saveProject(project.dir, { version: 1, config: edits.config, cuts: edits.cuts, assets, zooms, speeds, chapters, highlights, director, savedAt: new Date().toISOString() })
        .catch((e) => console.warn('autosave failed', e))
    }, 400)
    return () => clearTimeout(t)
  }, [edits, assets, zooms, speeds, chapters, highlights, director, project.dir])

  // Smart Director (add-on §7–9): analyse on first open (cached in analysis.json afterwards), show progress meanwhile.
  const runAnalysis = useCallback((force = false) => {
    setDstatus({ kind: 'running', step: 'audio' })
    window.narrate.analyzeProject(project.dir, force)
      .then((a) => { setAnalysis(a); setDstatus({ kind: 'idle' }) })
      .catch((e: Error) => setDstatus(/not available/i.test(e.message) ? { kind: 'unavailable', message: e.message } : { kind: 'error', message: e.message }))
  }, [project.dir])
  useEffect(() => { runAnalysis(false) }, [runAnalysis])
  useEffect(() => window.narrate.onRecorderEvent((e) => {
    if (e.event === 'analyzing' && e.step !== 'done') setDstatus({ kind: 'running', step: e.step })
    if (e.event === 'transcribing' && e.stage !== 'done') setTstatus({ kind: 'running', message: e.message ?? (e.stage === 'transcribing' && e.done != null && e.total ? `Transcribing… ${Math.round(e.done / e.total * 100)}%` : 'Transcribing…') })
  }), [])

  // Transcript (spec §43): on demand; cached in transcript.json. Filler words become extra Smart Director proposals (§42).
  const transcribe = () => {
    setTstatus({ kind: 'running', message: 'Starting the speech engine…' })
    window.narrate.transcribeProject(project.dir).then((t) => { setTranscript(t); setTstatus({ kind: 'idle' }) })
      .catch((e: Error) => setTstatus({ kind: 'error', message: e.message }))
  }
  const analysisWithFillers = useMemo<Analysis | null>(() => {
    if (!analysis) return null
    if (!transcript) return analysis
    const fill = fillerRanges(transcript).map((f, i): Proposal => ({ id: `filler-${i}`, type: 'REMOVE', start: Math.max(0, f.start - 0.05), end: f.end + 0.05, reason: `filler word “${f.word}”`, confidence: 'medium' }))
    if (!fill.length) return analysis
    const proposals = [...analysis.proposals.filter((p) => !p.id.startsWith('filler-')), ...fill]
    return { ...analysis, proposals, summary: { ...analysis.summary, REMOVE: proposals.filter((p) => p.type === 'REMOVE').length,
      removableSeconds: Math.round(proposals.filter((p) => p.type === 'REMOVE').reduce((s, p) => s + p.end - p.start, 0) * 100) / 100 } }
  }, [analysis, transcript])
  const removeSentence = (s: TranscriptSegment) => setCuts((c) => [...c, [s.start, s.end]])
  const restoreSentence = (s: TranscriptSegment) => setCuts((c) => c.filter(([a, b]) => !(a <= s.start + 0.05 && b >= s.end - 0.05)))

  const acceptProposal = (e: Edits, p: Proposal): Edits => {
    const d = { ...e.director, accepted: [...e.director.accepted.filter((id) => id !== p.id), p.id], rejected: e.director.rejected.filter((id) => id !== p.id) }
    if (p.type === 'REMOVE') return { ...e, director: d, cuts: [...e.cuts, [p.start, p.end]] }
    if (p.type === 'CHAPTER') return { ...e, director: d, chapters: [...e.chapters.filter((c) => Math.abs(c.t - p.start) > 0.5), { t: p.start, title: `Section ${e.chapters.length + 2}` }].sort((a, b) => a.t - b.t) }
    if (p.type === 'HIGHLIGHT') return { ...e, director: d, highlights: [...e.highlights, [p.start, p.end]] }
    if (p.type === 'SPEED') return { ...e, director: d, speeds: [...e.speeds.filter((s) => s.end <= p.start || s.start >= p.end), { start: p.start, end: p.end, rate: p.rate ?? 1.5 }] }
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

  const props: ScreencastProps = useMemo(() => ({ assets: project.assets, events: project.events, config, cuts, zooms, speeds, transcript }), [project, config, cuts, zooms, speeds, transcript])
  const size = compositionSize(props)
  const kept = useMemo(() => keptRanges(project.events, cuts, speeds), [project.events, cuts, speeds])
  const frames = Math.max(1, Math.ceil(keptDuration(project.events, cuts, speeds) * FPS))
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
  const addCut = (a: number, b: number) => { if (Math.abs(b - a) >= 0.1) setCuts((c) => [...c, [Math.min(a, b), Math.max(a, b)]]) }
  const trimStart = () => addCut(0, playheadSrc)
  const trimEnd = () => addCut(playheadSrc, dur)
  const cutHere = () => { if (pendingCut === null) setPendingCut(playheadSrc); else { addCut(pendingCut, playheadSrc); setPendingCut(null) } }
  const restore = (i: number) => setCuts((c) => c.filter((_, k) => k !== i))
  const sortedCuts = cuts.map((c, i) => ({ c, i })).sort((x, y) => x.c[0] - y.c[0])

  // Manual zoom (spec §26): zoom in at the playhead on wherever the cursor is, hold 2.5 s. Speed (spec §40): mark a range, pick a rate.
  const [pendingSpeed, setPendingSpeed] = useState<number | null>(null)
  const [speedRate, setSpeedRate] = useState(1.5)
  const zoomHere = () => {
    const pos = smoothCursor(project.events, playheadSrc) ?? [project.events.display.width / 2, project.events.display.height / 2]
    apply((e) => ({ ...e, zooms: [...e.zooms, { id: `z-${Math.random().toString(36).slice(2, 8)}`, t: playheadSrc, duration: 2.5, x: Math.round(pos[0]), y: Math.round(pos[1]), level: Math.max(1.5, e.config.zoom) }] }))
  }
  const editZoom = (id: string, patch: Partial<ManualZoom>) => apply((e) => ({ ...e, zooms: e.zooms.map((z) => z.id === id ? { ...z, ...patch } : z) }))
  const removeZoom = (id: string) => apply((e) => ({ ...e, zooms: e.zooms.filter((z) => z.id !== id) }))
  const speedHere = () => {
    if (pendingSpeed === null) { setPendingSpeed(playheadSrc); return }
    const a = Math.min(pendingSpeed, playheadSrc), b = Math.max(pendingSpeed, playheadSrc)
    if (b - a >= 0.5) apply((e) => ({ ...e, speeds: [...e.speeds.filter((s) => s.end <= a || s.start >= b), { start: a, end: b, rate: speedRate }] }))
    setPendingSpeed(null)
  }
  const removeSpeed = (i: number) => apply((e) => ({ ...e, speeds: e.speeds.filter((_, k) => k !== i) }))
  const setSpeedRateAt = (i: number, rate: number) => apply((e) => ({ ...e, speeds: e.speeds.map((s, k) => k === i ? { ...s, rate } : s) }))

  // Asset Studio (add-on §13): generate the standard set from the analysis; each is master + its own cuts + overrides.
  const generate = () => apply((e) => ({ ...e, assets: generateAssets({
    ev: project.events, analysis, masterCuts: e.cuts, chapters: e.chapters, highlights: e.highlights, masterSavedAt: project.file?.savedAt ?? null }) }))
  const removeAsset = (id: string) => { if (selected === id) setSelected('master'); apply((e) => ({ ...e, assets: e.assets.filter((a) => a.id !== id) })) }
  const assetDuration = (a: DerivedAsset | null) => keptDuration(project.events, a ? a.cuts : edits.cuts, speeds)
  const exportOne = (a: DerivedAsset | null) => window.narrate.exportProject(project.dir, a ? { ...edits.config, ...a.config } : edits.config, a ? a.cuts : edits.cuts, a ? a.name : 'master', format, { zooms, speeds })
  const exportAll = async () => {
    const list: (DerivedAsset | null)[] = [null, ...assets]
    setQueue({ total: list.length, done: 0, current: 'Master' })
    for (let i = 0; i < list.length; i++) {
      setQueue({ total: list.length, done: i, current: list[i]?.name ?? 'Master' })
      try { await exportOne(list[i]) } catch { /* progress shows the error for this asset; keep going */ }
    }
    setQueue(null)
  }

  return (
    <div className="editor">
      <div className="work">
        <div className="assets">
          <button className={`chip ${selected === 'master' ? 'on' : ''}`} onClick={() => setSelected('master')}><b>Master</b><span>{fmtShort(assetDuration(null))}</span></button>
          {assets.map((a) => (
            <button key={a.id} className={`chip ${selected === a.id ? 'on' : ''}`} onClick={() => setSelected(a.id)} title={a.note}>
              <b>{a.name}</b><span>{fmtShort(assetDuration(a))}{a.config.aspect ? ` · ${a.config.aspect}` : ''}</span>
            </button>
          ))}
          <span className="gen">
            <button onClick={generate} disabled={dstatus.kind === 'running'} title="Quick Demo, LinkedIn, Vertical Teaser, 15s Teaser and Clips, built from this recording">
              {assets.length ? 'Regenerate assets' : 'Generate assets'}
            </button>
            {asset && <button onClick={() => removeAsset(asset.id)}>Remove {asset.name}</button>}
          </span>
        </div>
        {asset && <p className="note">{ASSET_LABEL[asset.kind]} · {asset.note} Edits here change only this asset; the master is untouched.</p>}
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
          {!asset && <>
            <button onClick={zoomHere} title="Zoom in on the cursor at the playhead for 2.5 s">Zoom here</button>
            <button className={pendingSpeed !== null ? 'primary' : ''} onClick={speedHere}>{pendingSpeed === null ? 'Speed from here…' : `…to here at ${speedRate}×`}</button>
            {pendingSpeed !== null && <>
              <select value={speedRate} onChange={(e) => setSpeedRate(Number(e.target.value))} style={{ minWidth: 0, padding: '6px 8px' }}>
                {[0.5, 0.75, 1.25, 1.5, 2, 3].map((r) => <option key={r} value={r}>{r}×</option>)}
              </select>
              <button onClick={() => setPendingSpeed(null)}>Cancel</button></>}
          </>}
          <span className="spacer" />
          <span className="hint">{pendingCut !== null ? `Cutting from ${fmt(pendingCut)}. Move the playhead and click “…to here”.`
            : pendingSpeed !== null ? `Speed change from ${fmt(pendingSpeed)}. Move the playhead and click “…to here”.`
            : `Output ${fmt(keptDuration(project.events, cuts, speeds))} of ${fmt(dur)} recorded`}</span>
          <button onClick={undo} disabled={history.current.past.length === 0} title="Undo (Ctrl+Z)">Undo</button>
          <button onClick={redo} disabled={history.current.future.length === 0} title="Redo (Ctrl+Y)">Redo</button>
        </div>
        <Timeline ev={project.events} cuts={cuts} chapters={asset ? [] : chapters} highlights={asset ? [] : highlights} zooms={zooms} speeds={speeds}
          playhead={playheadSrc} pendingCut={pendingCut ?? pendingSpeed} onSeek={seekSrc} />
        {!asset && <Director analysis={analysisWithFillers} status={dstatus} state={director} onAccept={onAccept} onReject={onReject} onAcceptAll={onAcceptAll}
          onDismiss={onDismiss} onSeek={seekSrc} onRerun={() => runAnalysis(true)} />}
        {!asset && <TranscriptPanel transcript={transcript} status={tstatus} cuts={cuts} hasMic={!!project.assets.mic} playhead={playheadSrc}
          onCreate={transcribe} onSeek={seekSrc} onRemove={removeSentence} onRestore={restoreSentence} />}
        {(sortedCuts.length > 0 || (!asset && (zooms.length > 0 || speeds.length > 0))) && (
          <div className="cuts">
            {sortedCuts.map(({ c, i }) => (
              <div key={'c' + i}><span>Removed {fmt(c[0])} – {fmt(c[1])}</span><button onClick={() => restore(i)}>Restore</button></div>
            ))}
            {!asset && zooms.map((z) => (
              <div key={z.id}><span>Zoom <button className="when" onClick={() => seekSrc(z.t)}>{fmt(z.t)}</button>
                {' '}<label className="mini">level <input type="range" min={1.2} max={4} step={0.1} value={z.level} onChange={(e) => editZoom(z.id, { level: Number(e.target.value) })} /> {z.level.toFixed(1)}×</label>
                {' '}<label className="mini">hold <input type="range" min={0.5} max={10} step={0.5} value={z.duration} onChange={(e) => editZoom(z.id, { duration: Number(e.target.value) })} /> {z.duration.toFixed(1)}s</label></span>
                <button onClick={() => removeZoom(z.id)}>Remove</button></div>
            ))}
            {!asset && speeds.map((s, i) => (
              <div key={'s' + i}><span>Speed <button className="when" onClick={() => seekSrc(s.start)}>{fmt(s.start)}</button> – {fmt(s.end)}
                {' '}<select value={s.rate} onChange={(e) => setSpeedRateAt(i, Number(e.target.value))} style={{ minWidth: 0, padding: '4px 8px' }}>
                  {[0.5, 0.75, 1.25, 1.5, 2, 3].map((r) => <option key={r} value={r}>{r}×</option>)}</select></span>
                <button onClick={() => removeSpeed(i)}>Remove</button></div>
            ))}
          </div>
        )}
        {!asset && (chapters.length > 0 || transcript) && (
          <ContentMap chapters={chapters} transcript={transcript} duration={dur} playhead={playheadSrc} onSeek={seekSrc}
            onRename={(i, title) => apply((ed) => ({ ...ed, chapters: ed.chapters.map((x, k) => k === i ? { ...x, title } : x) }))}
            onRemove={(i) => apply((ed) => ({ ...ed, chapters: ed.chapters.filter((_, k) => k !== i) }))}
            onAddHere={() => apply((ed) => ({ ...ed, chapters: [...ed.chapters.filter((c) => Math.abs(c.t - playheadSrc) > 0.5), { t: playheadSrc, title: `Section ${ed.chapters.length + 2}` }].sort((a, b) => a.t - b.t) }))} />
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

        {transcript && (<>
          <h2>Captions</h2>
          <div className="control"><div className="lbl"><span>Style</span></div>
            <div className="seg">{(['off', 'minimal', 'bold'] as CaptionStyle[]).map((s) => (
              <button key={s} className={config.captions === s ? 'on' : ''} onClick={() => set('captions', s)}>{s === 'off' ? 'Off' : s === 'minimal' ? 'Minimal' : 'Bold'}</button>))}</div>
            <span className="note">From the transcript; the spoken word is highlighted.</span></div>
        </>)}

        {(project.assets.mic || project.assets.system) && (<>
          <h2>Sound</h2>
          {project.assets.mic && <div className="control"><div className="lbl"><span>Voice</span><span>{config.micVolume === 0 ? 'muted' : Math.round(config.micVolume * 100) + '%'}</span></div>
            <input type="range" min={0} max={1.5} step={0.05} value={config.micVolume} onChange={(e) => set('micVolume', Number(e.target.value))} /></div>}
          {project.assets.system && <div className="control"><div className="lbl"><span>Computer sound</span><span>{config.systemVolume === 0 ? 'muted' : Math.round(config.systemVolume * 100) + '%'}</span></div>
            <input type="range" min={0} max={1.5} step={0.05} value={config.systemVolume} onChange={(e) => set('systemVolume', Number(e.target.value))} /></div>}
        </>)}

        <h2>Export</h2>
        <div className="control"><div className="lbl"><span>Format</span></div>
          <div className="seg">
            <button className={format === 'mp4' ? 'on' : ''} onClick={() => setFormat('mp4')}>MP4</button>
            <button className={format === 'gif' ? 'on' : ''} onClick={() => setFormat('gif')}>GIF</button>
          </div>
          {format === 'gif' && <span className="note">Silent, 15 fps, up to 480 px on the short side. Best for clips under 15 seconds.</span>}</div>
        {format === 'mp4' && <div className="control"><div className="lbl"><span>Size</span></div>
          <div className="seg">{[1080, 1440, 0].map((h) => (
            <button key={h} className={config.outputHeight === h ? 'on' : ''} onClick={() => set('outputHeight', h)}>{h ? h + 'p' : 'Source'}</button>))}</div></div>}
        <button className="primary" disabled={!!busy || !!queue} onClick={() => { setProg({ stage: 'bundling', progress: 0 }); exportOne(asset).catch(() => {}) }}>
          {busy ? (prog!.stage === 'bundling' ? 'Preparing…' : `Rendering ${Math.round(prog!.progress * 100)}%`) : `Export ${asset ? asset.name : 'master'} ${format.toUpperCase()}`}
        </button>
        {assets.length > 0 && <button disabled={!!busy || !!queue} onClick={exportAll}>{queue ? `Exporting ${queue.done + 1}/${queue.total}: ${queue.current}` : `Export all (${assets.length + 1})`}</button>}
        {busy && <div className="progress"><i style={{ width: `${prog!.progress * 100}%` }} /></div>}
        {prog?.stage === 'done' && prog.output && !queue && <button onClick={() => window.narrate.reveal(prog.output!)}>{revealLabel}</button>}
        {prog?.stage === 'error' && <p className="err">{prog.message}</p>}
        {pauses > 0 && <p className="note">{pauses} pause{pauses > 1 ? "s" : ""} removed automatically.</p>}
        <p className="note">Not yet available: captions, narration takes, share links. They are on the roadmap, not hidden behind buttons.</p>
      </div>
    </div>
  )
}
