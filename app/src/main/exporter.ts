import { bundle } from '@remotion/bundler'
import { renderMedia, selectComposition } from '@remotion/renderer'
import { join } from 'node:path'
import type { Cut, ExportProgress, Project, RenderConfig, ScreencastProps } from '../shared/types'
import { outputSize } from '../video/Screencast'

let bundlePromise: Promise<string> | null = null
function getBundle(appRoot: string) {
  bundlePromise ??= bundle({ entryPoint: join(appRoot, 'src/video/index.ts'), webpackOverride: (c) => c })
  return bundlePromise
}

export async function exportProject(appRoot: string, project: Project, config: RenderConfig, cuts: Cut[], send: (p: ExportProgress) => void, suffix = 'narrate'): Promise<string> {
  const safe = suffix.replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'narrate'
  try {
    send({ stage: 'bundling', progress: 0, suffix: safe })
    const serveUrl = await getBundle(appRoot)
    const inputProps: ScreencastProps = { assets: project.assets, events: project.events, config, cuts }
    const design = await selectComposition({ serveUrl, id: 'Screencast', inputProps })
    // Render at an even integer size; the composition scales its design layout to whatever size it is given.
    const composition = { ...design, ...outputSize(design, config.outputHeight, config.aspect) }
    const output = join(project.dir, `${project.name}-${safe}.mp4`)
    send({ stage: 'rendering', progress: 0, suffix: safe })
    await renderMedia({
      composition, serveUrl, codec: 'h264', outputLocation: output, inputProps,
      crf: 16, pixelFormat: 'yuv420p', audioBitrate: '320k',
      onProgress: ({ progress }) => send({ stage: 'rendering', progress, suffix: safe }),
    })
    send({ stage: 'done', progress: 1, output, suffix: safe })
    return output
  } catch (e) {
    send({ stage: 'error', progress: 0, message: (e as Error).message, suffix: safe }); throw e
  }
}
