import { bundle } from '@remotion/bundler'
import { renderMedia, selectComposition } from '@remotion/renderer'
import { join } from 'node:path'
import { existsSync, readdirSync, unlinkSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { Cut, ExportFormat, ExportProgress, Project, RenderConfig, ScreencastProps } from '../shared/types'
import { outputSize } from '../video/Screencast'

/** ffmpeg for the GIF pass: env override, then PATH, then the per-user WinGet install the recorder also uses. */
export function findFfmpeg(): string | null {
  if (process.env.NARRATE_FFMPEG && existsSync(process.env.NARRATE_FFMPEG)) return process.env.NARRATE_FFMPEG
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  for (const dir of (process.env.PATH ?? '').split(process.platform === 'win32' ? ';' : ':')) { const p = join(dir, exe); if (dir && existsSync(p)) return p }
  const local = process.env.LOCALAPPDATA
  if (local) {
    const pk = join(local, 'Microsoft', 'WinGet', 'Packages')
    if (existsSync(pk)) for (const d of readdirSync(pk)) if (d.startsWith('Gyan.FFmpeg')) {
      const inner = join(pk, d); for (const sub of readdirSync(inner)) { const p = join(inner, sub, 'bin', exe); if (existsSync(p)) return p }
    }
  }
  for (const p of [join(homedir(), 'bin', exe), '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) if (existsSync(p)) return p
  return null
}

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('error', rej)
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(err.trim().split('\n').slice(-3).join('\n') || `ffmpeg exited ${code}`))))
  })
}

let bundlePromise: Promise<string> | null = null
function getBundle(appRoot: string) {
  bundlePromise ??= bundle({ entryPoint: join(appRoot, 'src/video/index.ts'), webpackOverride: (c) => c })
  return bundlePromise
}

export async function exportProject(appRoot: string, project: Project, config: RenderConfig, cuts: Cut[], send: (p: ExportProgress) => void, suffix = 'narrate', format: ExportFormat = 'mp4'): Promise<string> {
  const safe = suffix.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'narrate'
  try {
    send({ stage: 'bundling', progress: 0, suffix: safe })
    const serveUrl = await getBundle(appRoot)
    const inputProps: ScreencastProps = { assets: project.assets, events: project.events, config, cuts, transcript: project.transcript }
    const design = await selectComposition({ serveUrl, id: 'Screencast', inputProps })
    // Render at an even integer size; the composition scales its design layout to whatever size it is given.
    // GIFs are capped at 480 on the short side (file size), MP4 follows the quality setting.
    const composition = { ...design, ...outputSize(design, format === 'gif' ? Math.min(480, config.outputHeight || 480) : config.outputHeight, config.aspect) }
    const mp4 = join(project.dir, format === 'gif' ? `${project.name}-${safe}.gif.tmp.mp4` : `${project.name}-${safe}.mp4`)
    send({ stage: 'rendering', progress: 0, suffix: safe })
    await renderMedia({
      composition, serveUrl, codec: 'h264', outputLocation: mp4, inputProps,
      crf: 16, pixelFormat: 'yuv420p', audioBitrate: '320k', muted: format === 'gif',
      onProgress: ({ progress }) => send({ stage: 'rendering', progress: format === 'gif' ? progress * 0.85 : progress, suffix: safe }),
    })
    let output = mp4
    if (format === 'gif') {
      const ffmpeg = findFfmpeg()
      if (!ffmpeg) throw new Error('ffmpeg is needed to make a GIF. Install it with `winget install Gyan.FFmpeg`.')
      output = join(project.dir, `${project.name}-${safe}.gif`)
      send({ stage: 'rendering', progress: 0.9, suffix: safe })
      // two-pass palette: 15 fps, dithered, loops forever (spec §54)
      await run(ffmpeg, ['-v', 'error', '-y', '-i', mp4, '-vf', 'fps=15,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle', '-loop', '0', output])
      try { unlinkSync(mp4) } catch { /* keep going */ }
    }
    send({ stage: 'done', progress: 1, output, suffix: safe })
    return output
  } catch (e) {
    send({ stage: 'error', progress: 0, message: (e as Error).message, suffix: safe }); throw e
  }
}
