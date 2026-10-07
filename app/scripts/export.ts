/**
 * Export a recording from the command line, through the same pipeline the app uses
 * (AssetServer → Remotion bundle → renderMedia). For testing and CI; the app never calls this.
 *
 *   npx tsx scripts/export.ts <recording dir> [outputHeight=1080] [zoom=2]
 */
import { join, resolve, basename } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { AssetServer } from '../src/main/assetServer'
import { exportProject } from '../src/main/exporter'
import { defaultConfig, type Project, type RecordingEvents } from '../src/shared/types'

const [, , dirArg, heightArg, zoomArg] = process.argv
if (!dirArg) { console.error('usage: tsx scripts/export.ts <recording dir> [outputHeight] [zoom]'); process.exit(2) }
const dir = resolve(dirArg)
const eventsPath = join(dir, 'events.json')
if (!existsSync(eventsPath)) { console.error(`no events.json in ${dir}`); process.exit(2) }

const server = await AssetServer.start(resolve(dir, '..'))
const events = JSON.parse(readFileSync(eventsPath, 'utf8')) as RecordingEvents
const url = (f: string) => server.url(join(dir, f))
const cursors: Record<string, string> = {}
for (const [id, c] of Object.entries(events.cursors)) cursors[id] = url(c.file)
const project: Project = {
  dir, name: basename(dir), createdAt: statSync(eventsPath).mtime.toISOString(), events,
  assets: { screen: url(events.files.screen), mic: events.files.mic ? url(events.files.mic) : null, cursors },
}
const config = { ...defaultConfig, outputHeight: Number(heightArg ?? 1080), zoom: Number(zoomArg ?? defaultConfig.zoom) }
let last = -1
const started = Date.now()
const out = await exportProject(resolve(import.meta.dirname, '..'), project, config, (p) => {
  const pct = Math.round(p.progress * 100)
  if (p.stage !== 'rendering' || pct !== last) { last = pct; console.log(`${p.stage} ${pct}% ${p.message ?? ''}`.trim()) }
})
console.log(`done in ${((Date.now() - started) / 1000).toFixed(1)}s → ${out}`)
process.exit(0)
