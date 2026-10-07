import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from 'remotion'
import { useMemo } from 'react'
import { ASPECTS, type RecordingEvents, type RenderConfig, type ScreencastProps, type ProjectAssets, type Transcript } from '../shared/types'
import { buildCamera, cameraAt, cursorIdAt, smoothCursor, type CamKey, type Viewport } from './motion'
import { keptRanges } from './ranges'
import { Captions } from './Captions'

const BACKGROUNDS: Record<string, string> = {
  indigo: 'linear-gradient(135deg, #6E71E8 0%, #8B78D6 100%)',
  coral: 'linear-gradient(135deg, #FB8B73 0%, #F5C36A 100%)',
  ink: '#14140F',
  paper: '#EFEEE8',
}

/** Design-space layout: canvas size, where the screen frame sits, and the viewport the camera works in. */
export interface Layout { width: number; height: number; frame: { x: number; y: number; w: number; h: number }; vp: Viewport }

/**
 * - 'source': canvas = screen + padding; the frame is the screen at 1:1.
 * - landscape presets (16:9): the screen is fitted inside the canvas (never cropped).
 * - portrait / square presets (9:16, 4:5, 1:1): the frame fills the canvas and crops the screen; the viewport
 *   follows the cursor and zooms (content-aware reframing, add-on spec §17).
 */
export function layout(ev: RecordingEvents, cfg: RenderConfig): Layout {
  const W = ev.display.width, H = ev.display.height, pad = Math.round(W * cfg.padding)
  const even = (n: number) => { const r = Math.round(n); return r % 2 ? r + 1 : r }
  const ratio = ASPECTS.find((a) => a.id === cfg.aspect)?.ratio ?? null
  if (ratio === null) return { width: even(W + 2 * pad), height: even(H + 2 * pad), frame: { x: pad, y: pad, w: W, h: H }, vp: { FW: W, FH: H, base: 1, crop: false } }
  if (ratio >= 1) {
    const width = even(W + 2 * pad), height = even(width / ratio)
    const fit = Math.min((width - 2 * pad) / W, (height - 2 * pad) / H)
    const fw = Math.round(W * fit), fh = Math.round(H * fit)
    return { width, height, frame: { x: Math.round((width - fw) / 2), y: Math.round((height - fh) / 2), w: fw, h: fh }, vp: { FW: fw, FH: fh, base: fit, crop: false } }
  }
  const height = even(H + 2 * pad), width = even(height * ratio)
  const fw = width - 2 * pad, fh = height - 2 * pad
  return { width, height, frame: { x: pad, y: pad, w: fw, h: fh }, vp: { FW: fw, FH: fh, base: Math.max(fw / W, fh / H), crop: true } }
}

/** One kept range of the recording, rendered at source time = srcStart + local frame. */
const Segment: React.FC<{ ev: RecordingEvents; cfg: RenderConfig; assets: ProjectAssets; keys: CamKey[]; srcStart: number; L: Layout; transcript: Transcript | null }> =
  ({ ev, cfg, assets, keys, srcStart, L, transcript }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = srcStart + frame / fps
  const W = ev.display.width, H = ev.display.height
  const { frame: F, vp } = L
  const cam = cameraAt(ev, keys, t, W, H, vp)
  const tx = F.w / 2 - cam.cx * cam.scale, ty = F.h / 2 - cam.cy * cam.scale
  const pos = smoothCursor(ev, t)
  const cid = cursorIdAt(ev, t)
  const shape = cid ? ev.cursors[cid] : null
  const cs = ev.display.scale * cfg.cursorScale
  const ripple = ev.clicks.find((c) => c.type === 'down' && t - (c.t - ev.t0Video) >= 0 && t - (c.t - ev.t0Video) < 0.45)
  const rp = ripple ? (t - (ripple.t - ev.t0Video)) / 0.45 : 0
  const micStart = srcStart - (ev.micOffset ?? 0)   // seconds into mic.wav where this segment begins
  const camStart = srcStart - (ev.cameraOffset ?? 0)
  const sysStart = srcStart - (ev.systemOffset ?? 0)
  // The camera starts a moment after the screen; show the overlay only once it has frames (no black box at the start).
  const cameraHasFrames = t - (ev.cameraOffset ?? 0) >= 0 && (!ev.camera?.duration || t - (ev.cameraOffset ?? 0) <= ev.camera.duration)
  const webcam = assets.camera && ev.camera && cfg.cameraShape !== 'off' && cameraHasFrames ? cameraRect(cfg, ev.camera, F.w, F.h) : null

  return (
    <>
      <div style={{ position: 'absolute', left: F.x, top: F.y, width: F.w, height: F.h, borderRadius: cfg.radius,
                    overflow: 'hidden', boxShadow: '0 40px 120px rgba(20,20,15,0.35)', background: '#14140F' }}>
        <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, transformOrigin: '0 0', transform: `translate(${tx}px, ${ty}px) scale(${cam.scale})` }}>
          <OffthreadVideo src={assets.screen} muted startFrom={Math.round(srcStart * fps)} style={{ width: W, height: H, display: 'block' }} />
          {ripple && (
            <div style={{ position: 'absolute', left: ripple.x - 60 * rp, top: ripple.y - 60 * rp, width: 120 * rp, height: 120 * rp,
                          borderRadius: '50%', background: 'rgba(251,139,115,0.45)', opacity: 1 - rp }} />
          )}
          {pos && shape && cid && assets.cursors[cid] && (
            <Img src={assets.cursors[cid]} style={{ position: 'absolute',
              left: pos[0] - shape.hotspot[0] * cs, top: pos[1] - shape.hotspot[1] * cs,
              width: shape.size[0] * cs, height: shape.size[1] * cs, filter: 'drop-shadow(0 2px 6px rgba(0,0,0,0.35))' }} />
          )}
        </div>
      </div>
      {webcam && assets.camera && (
        // Camera overlay sits over the screen frame and stays put while the screen zooms (spec §10, §11).
        <div style={{ position: 'absolute', left: F.x + webcam.x, top: F.y + webcam.y, width: webcam.w, height: webcam.h,
                      borderRadius: webcam.radius, overflow: 'hidden', boxShadow: '0 24px 70px rgba(20,20,15,0.4)', background: '#14140F' }}>
          <TimedVideo src={assets.camera} start={camStart} fps={fps}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: cfg.cameraMirror ? 'scaleX(-1)' : undefined }} />
        </div>
      )}
      {transcript && cfg.captions !== 'off' && (
        <div style={{ position: 'absolute', left: F.x, top: F.y, width: F.w, height: F.h, pointerEvents: 'none' }}>
          <Captions transcript={transcript} t={t} style={cfg.captions} FW={F.w} FH={F.h} portrait={L.vp.crop} />
        </div>
      )}
      {assets.mic && cfg.micVolume > 0 && <TimedAudio src={assets.mic} start={micStart} fps={fps} volume={cfg.micVolume} />}
      {assets.system && cfg.systemVolume > 0 && <TimedAudio src={assets.system} start={sysStart} fps={fps} volume={cfg.systemVolume} />}
    </>
  )
}

/** A video whose own time axis starts `start` seconds into this segment (negative = it begins later than the segment). */
const TimedVideo: React.FC<{ src: string; start: number; fps: number; style: React.CSSProperties }> = ({ src, start, fps, style }) =>
  start >= 0
    ? <OffthreadVideo src={src} muted startFrom={Math.round(start * fps)} style={style} />
    : <Sequence from={Math.round(-start * fps)} layout="none"><OffthreadVideo src={src} muted style={style} /></Sequence>

/** An audio track whose own time axis starts `start` seconds into this segment (negative = it begins later). */
const TimedAudio: React.FC<{ src: string; start: number; fps: number; volume: number }> = ({ src, start, fps, volume }) =>
  start >= 0
    ? <Audio src={src} startFrom={Math.round(start * fps)} volume={volume} />
    : <Sequence from={Math.round(-start * fps)} layout="none"><Audio src={src} volume={volume} /></Sequence>

/** Camera box in frame pixels, relative to the frame's top-left. Size is a fraction of the frame width. */
export function cameraRect(cfg: RenderConfig, camera: { width: number; height: number }, FW: number, FH: number) {
  const w = Math.round(FW * cfg.cameraSize)
  const aspect = camera.width && camera.height ? camera.width / camera.height : 4 / 3
  const h = cfg.cameraShape === 'circle' ? w : Math.round(w / aspect)
  const margin = Math.round(FW * 0.025)
  const x = cfg.cameraCorner.endsWith('l') ? margin : FW - w - margin
  const y = cfg.cameraCorner.startsWith('t') ? margin : FH - h - margin
  const radius = cfg.cameraShape === 'circle' ? w / 2 : Math.round(w * 0.12)
  return { x, y, w, h, radius }
}

/**
 * Lays the screencast out in its design size and scales that to whatever the composition is rendered at,
 * so the exporter can pick any integer output size without the layout maths changing.
 */
export const Screencast: React.FC<ScreencastProps> = (props) => {
  const { assets, events: ev, config: cfg, cuts = [], transcript = null } = props
  const { fps, width: VW } = useVideoConfig()
  const L = useMemo(() => layout(ev, cfg), [ev, cfg])
  const keys = useMemo(() => buildCamera(ev, cfg, L.vp), [ev, cfg, L])
  const ranges = useMemo(() => keptRanges(ev, cuts), [ev, cuts])
  let from = 0
  return (
    <AbsoluteFill style={{ background: BACKGROUNDS[cfg.background] ?? BACKGROUNDS.indigo }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: L.width, height: L.height, transformOrigin: '0 0', transform: `scale(${VW / L.width})` }}>
        {ranges.map((r, i) => {
          const len = Math.max(1, Math.round((r.end - r.start) * fps))
          const seq = (
            <Sequence key={i} from={from} durationInFrames={len}>
              <Segment ev={ev} cfg={cfg} assets={assets} keys={keys} srcStart={r.start} L={L} transcript={transcript} />
            </Sequence>
          )
          from += len
          return seq
        })}
      </div>
    </AbsoluteFill>
  )
}

/** Design size of the composition (even numbers for 4:2:0 encoders). */
export function compositionSize(p: ScreencastProps) {
  const L = layout(p.events, p.config)
  return { width: L.width, height: L.height }
}

/**
 * Output size for a quality setting (0 = design size): same aspect as the design, both dimensions even integers.
 * The setting names the shorter side, so "1080p" is 1920×1080 for landscape and 1080×1920 for 9:16.
 */
export function outputSize(design: { width: number; height: number }, outputHeight: number, aspect: RenderConfig['aspect'] = 'source') {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  const ratio = ASPECTS.find((a) => a.id === aspect)?.ratio ?? null
  const short = Math.min(design.width, design.height)
  const target = !outputHeight || outputHeight >= short ? short : outputHeight
  // Presets get exact platform sizes (1080×1920, 1080×1080, 1080×1350…) rather than the design's rounded ratio.
  if (ratio !== null) return ratio >= 1 ? { width: even(target * ratio), height: even(target) } : { width: even(target), height: even(target / ratio) }
  const s = target / short
  return { width: even(design.width * s), height: even(design.height * s) }
}
