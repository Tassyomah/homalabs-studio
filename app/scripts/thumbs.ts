/**
 * Render thumbnail candidates for a recording from the command line (same code as the editor's "Thumbnail candidates").
 *
 *   npx tsx scripts/thumbs.ts <recording dir>
 */
import { join, resolve, basename } from 'node:path'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { AssetServer } from '../src/main/assetServer'
import { renderThumbnails } from '../src/main/exporter'
import { thumbnailTimes } from '../src/renderer/content'
import { defaultConfig, type Analysis, type Project, type ProjectFile, type RecordingEvents } from '../src/shared/types'

const dir = resolve(process.argv[2] ?? '')
const read = <T,>(f: string): T | null => existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) as T : null
const events = read<RecordingEvents>('events.json'); if (!events) { console.error('usage: tsx scripts/thumbs.ts <recording dir>'); process.exit(2) }
const file = read<ProjectFile>('project.json'); const analysis = read<Analysis>('analysis.json')
const server = await AssetServer.start(resolve(dir, '..'))
const url = (f: string) => server.url(join(dir, f))
const cursors: Record<string, string> = {}; for (const [id, c] of Object.entries(events.cursors)) cursors[id] = url(c.file)
const project: Project = { dir, name: basename(dir), createdAt: statSync(join(dir, 'events.json')).mtime.toISOString(), events, file, transcript: read('transcript.json'),
  assets: { screen: url(events.files.screen), mic: events.files.mic ? url(events.files.mic) : null, camera: events.files.camera ? url(events.files.camera) : null, system: events.files.system ? url(events.files.system) : null, cursors } }
const config = { ...defaultConfig, ...(file?.config ?? {}) }
const times = thumbnailTimes(events, file?.cuts ?? [], file?.speeds ?? [], file?.chapters ?? [], file?.highlights ?? [], analysis)
console.log('times (output s):', times.map((t) => t.toFixed(1)).join(', '))
const out = await renderThumbnails(resolve(import.meta.dirname, '..'), project, config, file?.cuts ?? [], times)
for (const f of out) console.log(f)
process.exit(0)
