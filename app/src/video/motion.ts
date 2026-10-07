import type { RecordingEvents, RenderConfig } from '../shared/types'

/**
 * The "camera" here is the virtual viewport over the screen recording (not the webcam).
 * Scale is absolute: screen pixels × scale = frame pixels. At rest the scale is `base` (the whole screen fits the
 * frame, or — for cropping aspects like 9:16 — the frame is filled and the viewport follows the cursor).
 */
export interface CamKey { t: number; scale: number; cx: number; cy: number }
export interface Camera { scale: number; cx: number; cy: number }
/** Where the screen is shown: frame size in design pixels plus the rest scale. */
export interface Viewport { FW: number; FH: number; base: number; crop: boolean }

const easeInOut = (p: number) => (p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2)
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v))

/** Keep the viewport (FW/scale × FH/scale screen pixels around cx,cy) inside the screen. */
export function clampCenter(cx: number, cy: number, scale: number, W: number, H: number, vp: Viewport): [number, number] {
  const hw = vp.FW / (2 * scale), hh = vp.FH / (2 * scale)
  return [hw >= W / 2 ? W / 2 : clamp(cx, hw, W - hw), hh >= H / 2 ? H / 2 : clamp(cy, hh, H - hh)]
}

/** Where the viewport rests when nothing is zoomed: the screen centre, or the (slowly) followed cursor when cropping. */
export function restCenter(ev: RecordingEvents, t: number, W: number, H: number, vp: Viewport): [number, number] {
  if (!vp.crop) return [W / 2, H / 2]
  const p = smoothCursor(ev, t, 0.6) ?? [W / 2, H / 2]
  return clampCenter(p[0], p[1], vp.base, W, H, vp)
}

/**
 * Auto-zoom: group clicks close in time and space, zoom in before the first click,
 * pan between clicks of the group, zoom out after the last. Returns keyframes.
 */
export function buildCamera(ev: RecordingEvents, cfg: RenderConfig, vp: Viewport): CamKey[] {
  const W = ev.display.width, H = ev.display.height, z = cfg.zoom
  if (z <= 1.001) return []
  const zoomed = vp.base * z
  const downs = ev.clicks.filter((c) => c.type === 'down').map((c) => ({ t: c.t - ev.t0Video, x: c.x, y: c.y }))
    .filter((c) => c.t >= 0 && c.t <= ev.videoDuration)
  const LEAD = 0.55, TAIL = 1.6, EASE = 0.65, GAP = 2.6, DIST = 0.33 * W
  type Group = { clicks: typeof downs }
  const groups: Group[] = []
  for (const c of downs) {
    const g = groups[groups.length - 1]
    const last = g?.clicks[g.clicks.length - 1]
    if (g && last && c.t - last.t < GAP && Math.hypot(c.x - last.x, c.y - last.y) < DIST) g.clicks.push(c)
    else groups.push({ clicks: [c] })
  }
  const rest = (t: number) => restCenter(ev, t, W, H, vp)
  const keys: CamKey[] = []
  let prevEnd = -Infinity
  for (const g of groups) {
    const first = g.clicks[0], last = g.clicks[g.clicks.length - 1]
    const start = Math.max(0, first.t - LEAD), end = Math.min(ev.videoDuration, last.t + TAIL)
    const [cx0, cy0] = clampCenter(first.x, first.y, zoomed, W, H, vp)
    if (start - prevEnd < 0.8 && keys.length) {
      // adjacent group: stay zoomed and pan instead of zooming out and back in
      keys.splice(-1, 1)   // drop previous zoom-out
      keys.push({ t: Math.min(start + EASE, first.t), scale: zoomed, cx: cx0, cy: cy0 })
    } else {
      const [rx, ry] = rest(start)
      keys.push({ t: start, scale: vp.base, cx: rx, cy: ry }, { t: Math.min(start + EASE, first.t), scale: zoomed, cx: cx0, cy: cy0 })
    }
    for (const c of g.clicks.slice(1)) {
      const [cx, cy] = clampCenter(c.x, c.y, zoomed, W, H, vp)
      keys.push({ t: c.t, scale: zoomed, cx, cy })
    }
    const [cxl, cyl] = clampCenter(last.x, last.y, zoomed, W, H, vp)
    const [rx, ry] = rest(end)
    keys.push({ t: Math.max(end - EASE, last.t + 0.1), scale: zoomed, cx: cxl, cy: cyl }, { t: end, scale: vp.base, cx: rx, cy: ry })
    prevEnd = end
  }
  return keys
}

export function cameraAt(ev: RecordingEvents, keys: CamKey[], t: number, W: number, H: number, vp: Viewport): Camera {
  const restCam = (): Camera => { const [cx, cy] = restCenter(ev, t, W, H, vp); return { scale: vp.base, cx, cy } }
  if (!keys.length || t <= keys[0].t || t >= keys[keys.length - 1].t) return restCam()
  for (let i = 0; i < keys.length - 1; i++) {
    const a = keys[i], b = keys[i + 1]
    if (t >= a.t && t <= b.t) {
      const p = b.t === a.t ? 1 : easeInOut((t - a.t) / (b.t - a.t))
      return { scale: a.scale + (b.scale - a.scale) * p, cx: a.cx + (b.cx - a.cx) * p, cy: a.cy + (b.cy - a.cy) * p }
    }
  }
  return restCam()
}

/** Raw cursor position at time t (relative to video start), linear between samples. */
export function rawCursor(ev: RecordingEvents, t: number): [number, number] | null {
  const m = ev.moves; if (!m.length) return null
  const T = t + ev.t0Video
  let lo = 0, hi = m.length - 1
  if (T <= m[0][0]) return [m[0][1], m[0][2]]
  if (T >= m[hi][0]) return [m[hi][1], m[hi][2]]
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (m[mid][0] <= T) lo = mid; else hi = mid }
  const a = m[lo], b = m[hi], p = (T - a[0]) / (b[0] - a[0] || 1)
  return [a[1] + (b[1] - a[1]) * p, a[2] + (b[2] - a[2]) * p]
}

/** Gaussian-smoothed cursor: removes hand jitter, keeps the path. Larger sigma = lazier follow. */
export function smoothCursor(ev: RecordingEvents, t: number, sigma = 0.045): [number, number] | null {
  let sx = 0, sy = 0, sw = 0
  for (let k = -3; k <= 3; k++) {
    const p = rawCursor(ev, t + k * sigma * 0.7); if (!p) continue
    const w = Math.exp(-0.5 * (k * 0.7) ** 2); sx += p[0] * w; sy += p[1] * w; sw += w
  }
  return sw ? [sx / sw, sy / sw] : null
}

export function cursorIdAt(ev: RecordingEvents, t: number): string | null {
  const T = t + ev.t0Video; let id: string | null = null
  for (const [ct, cid] of ev.cursorChanges) { if (ct <= T) id = cid; else break }
  return id ?? ev.cursorChanges[0]?.[1] ?? null
}
