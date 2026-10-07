import { AbsoluteFill, Audio, Img, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from 'remotion'
import { useMemo } from 'react'
import type { RecordingEvents, RenderConfig, ScreencastProps, ProjectAssets } from '../shared/types'
import { buildCamera, cameraAt, cursorIdAt, smoothCursor, type CamKey } from './motion'
import { keptRanges } from './ranges'

const BACKGROUNDS: Record<string, string> = {
  indigo: 'linear-gradient(135deg, #6E71E8 0%, #8B78D6 100%)',
  coral: 'linear-gradient(135deg, #FB8B73 0%, #F5C36A 100%)',
  ink: '#14140F',
  paper: '#EFEEE8',
}

/** One kept range of the recording, rendered at source time = srcStart + local frame. `CH` is the design height. */
const Segment: React.FC<{ ev: RecordingEvents; cfg: RenderConfig; assets: ProjectAssets; keys: CamKey[]; srcStart: number; CH: number }> =
  ({ ev, cfg, assets, keys, srcStart, CH }) => {
  const frame = useCurrentFrame()
  const { fps } = useVideoConfig()
  const t = srcStart + frame / fps
  const W = ev.display.width, H = ev.display.height
  const pad = Math.round(W * cfg.padding)
  const cam = cameraAt(keys, t, W, H)
  const tx = W / 2 - cam.cx * cam.scale, ty = H / 2 - cam.cy * cam.scale
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
  const webcam = assets.camera && ev.camera && cfg.cameraShape !== 'off' && cameraHasFrames ? cameraRect(cfg, ev.camera, W, H) : null

  return (
    <>
      <div style={{ position: 'absolute', left: pad, top: (CH - H) / 2, width: W, height: H, borderRadius: cfg.radius,
                    overflow: 'hidden', boxShadow: '0 40px 120px rgba(20,20,15,0.35)' }}>
        <div style={{ position: 'absolute', inset: 0, transformOrigin: '0 0', transform: `translate(${tx}px, ${ty}px) scale(${cam.scale})` }}>
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
        <div style={{ position: 'absolute', left: pad + webcam.x, top: (CH - H) / 2 + webcam.y, width: webcam.w, height: webcam.h,
                      borderRadius: webcam.radius, overflow: 'hidden', boxShadow: '0 24px 70px rgba(20,20,15,0.4)', background: '#14140F' }}>
          <TimedVideo src={assets.camera} start={camStart} fps={fps}
            style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block', transform: cfg.cameraMirror ? 'scaleX(-1)' : undefined }} />
        </div>
      )}
      {assets.mic && cfg.micVolume > 0 && <TimedAudio src={assets.mic} start={micStart} fps={fps} volume={cfg.micVolume} />}
      {assets.system && cfg.systemVolume > 0 && <TimedAudio src={assets.system} start={sysStart} fps={fps} volume={cfg.systemVolume} />}
    </>
  )
}

/** An audio track whose own time axis starts `start` seconds into this segment (negative = it begins later). */
const TimedAudio: React.FC<{ src: string; start: number; fps: number; volume: number }> = ({ src, start, fps, volume }) =>
  start >= 0
    ? <Audio src={src} startFrom={Math.round(start * fps)} volume={volume} />
    : <Sequence from={Math.round(-start * fps)} layout="none"><Audio src={src} volume={volume} /></Sequence>

/** A video whose own time axis starts `start` seconds into this segment (negative = it begins later than the segment). */
const TimedVideo: React.FC<{ src: string; start: number; fps: number; style: React.CSSProperties }> = ({ src, start, fps, style }) =>
  start >= 0
    ? <OffthreadVideo src={src} muted startFrom={Math.round(start * fps)} style={style} />
    : <Sequence from={Math.round(-start * fps)} layout="none"><OffthreadVideo src={src} muted style={style} /></Sequence>

/** Camera box in screen-pixel space, relative to the screen frame's top-left. */
export function cameraRect(cfg: RenderConfig, camera: { width: number; height: number }, W: number, H: number) {
  const w = Math.round(W * cfg.cameraSize)
  const aspect = camera.width && camera.height ? camera.width / camera.height : 4 / 3
  const h = cfg.cameraShape === 'circle' ? w : Math.round(w / aspect)
  const margin = Math.round(W * 0.025)
  const x = cfg.cameraCorner.endsWith('l') ? margin : W - w - margin
  const y = cfg.cameraCorner.startsWith('t') ? margin : H - h - margin
  const radius = cfg.cameraShape === 'circle' ? w / 2 : Math.round(w * 0.12)
  return { x, y, w, h, radius }
}

/**
 * Lays the screencast out in its design size (source pixels + padding, see compositionSize) and scales that to
 * whatever the composition is rendered at, so the exporter can pick any integer output size (720p, 1080p, 4K)
 * without the layout maths changing.
 */
export const Screencast: React.FC<ScreencastProps> = (props) => {
  const { assets, events: ev, config: cfg, cuts = [] } = props
  const { fps, width: VW } = useVideoConfig()
  const design = compositionSize(props)
  const keys = useMemo(() => buildCamera(ev, cfg), [ev, cfg])
  const ranges = useMemo(() => keptRanges(ev, cuts), [ev, cuts])
  let from = 0
  return (
    <AbsoluteFill style={{ background: BACKGROUNDS[cfg.background] ?? BACKGROUNDS.indigo }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: design.width, height: design.height,
                    transformOrigin: '0 0', transform: `scale(${VW / design.width})` }}>
        {ranges.map((r, i) => {
          const len = Math.max(1, Math.round((r.end - r.start) * fps))
          const seq = (
            <Sequence key={i} from={from} durationInFrames={len}>
              <Segment ev={ev} cfg={cfg} assets={assets} keys={keys} srcStart={r.start} CH={design.height} />
            </Sequence>
          )
          from += len
          return seq
        })}
      </div>
    </AbsoluteFill>
  )
}

/** Design size: the screen plus padding on every side; aspect follows the screen. Even numbers for 4:2:0 encoders. */
export function compositionSize(p: ScreencastProps) {
  const W = p.events.display.width, H = p.events.display.height, pad = Math.round(W * p.config.padding)
  const width = W + 2 * pad, height = H + 2 * pad
  return { width: width % 2 ? width + 1 : width, height: height % 2 ? height + 1 : height }
}

/** Output size for a target height (0 = design size): same aspect as the design, both dimensions even integers. */
export function outputSize(design: { width: number; height: number }, outputHeight: number) {
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2)
  if (!outputHeight || outputHeight >= design.height) return { width: even(design.width), height: even(design.height) }
  return { width: even(design.width * outputHeight / design.height), height: even(outputHeight) }
}
