/**
 * Show (or write) the derivative assets the Asset Studio would generate for a recording — the same code the editor
 * runs behind "Generate assets", so the heuristics can be inspected from the command line.
 *
 *   npx tsx scripts/assets.ts <recording dir> [--write]
 *
 * Reads events.json, analysis.json (if present) and project.json; --write stores the assets in project.json.
 */
import { join, resolve } from 'node:path'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { generateAssets } from '../src/renderer/generate'
import { keptRanges } from '../src/video/ranges'
import { defaultConfig, type Analysis, type ProjectFile, type RecordingEvents } from '../src/shared/types'

const [, , dirArg, flag] = process.argv
if (!dirArg) { console.error('usage: tsx scripts/assets.ts <recording dir> [--write]'); process.exit(2) }
const dir = resolve(dirArg)
const read = <T,>(f: string): T | null => existsSync(join(dir, f)) ? JSON.parse(readFileSync(join(dir, f), 'utf8')) as T : null
const ev = read<RecordingEvents>('events.json'); if (!ev) { console.error('no events.json'); process.exit(2) }
const analysis = read<Analysis>('analysis.json')
const file = read<ProjectFile>('project.json') ?? { version: 1 as const, config: defaultConfig, cuts: [], savedAt: new Date().toISOString() }

const assets = generateAssets({ ev, analysis, masterCuts: file.cuts, chapters: file.chapters ?? [], highlights: file.highlights ?? [], masterSavedAt: file.savedAt })
const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}.${Math.floor((s % 1) * 10)}`
console.log(`recording ${fmt(ev.videoDuration)}, master keeps ${fmt(keptRanges(ev, file.cuts).reduce((a, r) => a + r.end - r.start, 0))}, analysis: ${analysis ? 'yes' : 'no'}`)
for (const a of assets) {
  const kept = keptRanges(ev, a.cuts)
  console.log(`\n${a.name} (${a.kind}) ${fmt(kept.reduce((s, r) => s + r.end - r.start, 0))} ${a.config.aspect ?? 'screen aspect'}`)
  console.log(`  ${a.note}`)
  console.log('  segments: ' + kept.map((r) => `${fmt(r.start)}–${fmt(r.end)}`).join(', '))
}
if (flag === '--write') {
  const tmp = join(dir, 'project.json.tmp')
  writeFileSync(tmp, JSON.stringify({ ...file, assets, savedAt: new Date().toISOString() }, null, 1))
  renameSync(tmp, join(dir, 'project.json'))
  console.log(`\nwrote ${assets.length} assets to project.json`)
}
