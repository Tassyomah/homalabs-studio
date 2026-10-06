import { useEffect, useMemo, useState } from 'react'
import { Player } from '@remotion/player'
import { Screencast, compositionSize } from '../../video/Screencast'
import { keptDuration } from '../../video/ranges'
import { defaultConfig, type Background, type ExportProgress, type Project, type RenderConfig, type ScreencastProps } from '../../shared/types'

const FPS = 60
const BGS: { id: Background; label: string; css: string }[] = [
  { id: 'indigo', label: 'Indigo', css: 'linear-gradient(135deg,#6E71E8,#8B78D6)' },
  { id: 'coral', label: 'Coral', css: 'linear-gradient(135deg,#FB8B73,#F5C36A)' },
  { id: 'ink', label: 'Ink', css: '#14140F' },
  { id: 'paper', label: 'Paper', css: '#EFEEE8' },
]

export function Editor({ project }: { project: Project }) {
  const [config, setConfig] = useState<RenderConfig>(defaultConfig)
  const [prog, setProg] = useState<ExportProgress | null>(null)
  useEffect(() => window.narrate.onExportProgress(setProg), [])

  const props: ScreencastProps = useMemo(() => ({ assets: project.assets, events: project.events, config }), [project, config])
  const size = compositionSize(props)
  const frames = Math.max(1, Math.ceil(keptDuration(project.events) * FPS))
  const pauses = project.events.pauses?.length ?? 0
  const set = <K extends keyof RenderConfig>(k: K, v: RenderConfig[K]) => setConfig((c) => ({ ...c, [k]: v }))
  const busy = prog && (prog.stage === 'bundling' || prog.stage === 'rendering')

  return (
    <div className="editor">
      <div className="stage">
        <Player component={Screencast} inputProps={props} durationInFrames={frames} fps={FPS}
          compositionWidth={size.width} compositionHeight={size.height} controls
          style={{ width: '100%', height: '100%' }} />
      </div>
      <div className="panel">
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

        <h2>Export</h2>
        <div className="control"><div className="lbl"><span>Size</span></div>
          <div className="seg">{[1080, 1440, 0].map((h) => (
            <button key={h} className={config.outputHeight === h ? 'on' : ''} onClick={() => set('outputHeight', h)}>{h ? h + 'p' : 'Source'}</button>))}</div></div>
        <button className="primary" disabled={!!busy} onClick={() => { setProg({ stage: 'bundling', progress: 0 }); window.narrate.exportProject(project.dir, config).catch(() => {}) }}>
          {busy ? (prog!.stage === 'bundling' ? 'Preparing…' : `Rendering ${Math.round(prog!.progress * 100)}%`) : 'Export MP4'}
        </button>
        {busy && <div className="progress"><i style={{ width: `${prog!.progress * 100}%` }} /></div>}
        {prog?.stage === 'done' && prog.output && <button onClick={() => window.narrate.reveal(prog.output!)}>Show in Finder</button>}
        {prog?.stage === 'error' && <p className="err">{prog.message}</p>}
        {pauses > 0 && <p className="note">{pauses} pause{pauses > 1 ? "s" : ""} removed automatically.</p>}
        <p className="note">Not yet available: trimming, camera, captions, narration takes, share links. They are on the roadmap, not hidden behind buttons.</p>
      </div>
    </div>
  )
}
