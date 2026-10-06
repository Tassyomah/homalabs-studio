import { bundle } from '@remotion/bundler'
import { renderMedia, selectComposition } from '@remotion/renderer'
import { join } from 'node:path'
import type { ExportProgress, Project, RenderConfig, ScreencastProps } from '../shared/types'

let bundlePromise: Promise<string> | null = null
function getBundle(appRoot: string) {
  bundlePromise ??= bundle({ entryPoint: join(appRoot, 'src/video/index.ts'), webpackOverride: (c) => c })
  return bundlePromise
}

export async function exportProject(appRoot: string, project: Project, config: RenderConfig, send: (p: ExportProgress) => void): Promise<string> {
  try {
    send({ stage: 'bundling', progress: 0 })
    const serveUrl = await getBundle(appRoot)
    const inputProps: ScreencastProps = { assets: project.assets, events: project.events, config }
    const composition = await selectComposition({ serveUrl, id: 'Screencast', inputProps })
    const scale = config.outputHeight ? config.outputHeight / composition.height : 1
    const output = join(project.dir, `${project.name}-narrate.mp4`)
    send({ stage: 'rendering', progress: 0 })
    await renderMedia({
      composition, serveUrl, codec: 'h264', outputLocation: output, inputProps, scale,
      crf: 16, pixelFormat: 'yuv420p', audioBitrate: '320k',
      onProgress: ({ progress }) => send({ stage: 'rendering', progress }),
    })
    send({ stage: 'done', progress: 1, output })
    return output
  } catch (e) {
    send({ stage: 'error', progress: 0, message: (e as Error).message }); throw e
  }
}
