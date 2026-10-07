import { app, BrowserWindow, ipcMain, shell, screen, globalShortcut } from 'electron'
import { join, resolve, basename } from 'node:path'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { Devices, ExportProgress, Project, RecorderEvent, RenderConfig, StartOptions, UnfinishedRecording } from '../shared/types'
import { Recorder } from './recorder'
import { AssetServer } from './assetServer'
import { exportProject } from './exporter'

const IS_WIN = process.platform === 'win32'
const APP_ROOT = resolve(app.getAppPath())
/** One recorder per platform, same stdin/stdout protocol (docs/ARCHITECTURE.md). */
const RECORDER = process.env.NARRATE_RECORDER ?? resolve(APP_ROOT, '..', 'recorder', IS_WIN ? 'narrate_win.py' : 'narrate.py')
const RECORDINGS = join(homedir(), IS_WIN ? 'Videos' : 'Movies', 'Narrate')
const SETTINGS_URL = IS_WIN
  ? { screen: 'ms-settings:privacy', mic: 'ms-settings:privacy-microphone' }
  : { screen: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
      mic: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone' }

let win: BrowserWindow | null = null
let bar: BrowserWindow | null = null
let server: AssetServer
const recorder = new Recorder(RECORDER)

function load(w: BrowserWindow, hash = '') {
  if (process.env.ELECTRON_RENDERER_URL) w.loadURL(process.env.ELECTRON_RENDERER_URL + hash)
  else w.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.replace('#', '') })
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640,
    title: 'Narrate', backgroundColor: '#EFEEE8',
    ...(IS_WIN
      ? { titleBarStyle: 'hidden' as const, titleBarOverlay: { color: '#EFEEE8', symbolColor: '#14140F', height: 52 } }
      : { titleBarStyle: 'hiddenInset' as const, trafficLightPosition: { x: 16, y: 18 } }),
    webPreferences: { preload: join(__dirname, '../preload/index.mjs'), sandbox: false },
  })
  win.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 'warning') console.log('[renderer]', e.message) })
  load(win)
  win.on('closed', () => (win = null))
}

/** Small always-on-top control bar shown while recording (timer, pause, stop). */
function showBar() {
  const area = screen.getPrimaryDisplay().workArea
  bar = new BrowserWindow({
    width: 280, height: 52, x: area.x + area.width - 300, y: area.y + area.height - 72,
    frame: false, transparent: true, alwaysOnTop: true, resizable: false, movable: true, hasShadow: true,
    skipTaskbar: true, focusable: true, fullscreenable: false,
    webPreferences: { preload: join(__dirname, '../preload/index.mjs'), sandbox: false },
  })
  bar.setAlwaysOnTop(true, 'screen-saver'); bar.setVisibleOnAllWorkspaces(true)
  load(bar, '#bar')
}
function hideBar() { bar?.close(); bar = null }

function broadcast(ev: RecorderEvent) { for (const w of BrowserWindow.getAllWindows()) w.webContents.send('recorder:event', ev) }

function loadProject(dir: string): Project | null {
  const ev = join(dir, 'events.json')
  if (!existsSync(ev)) return null
  const events = JSON.parse(readFileSync(ev, 'utf8'))
  const url = (f: string) => server.url(join(dir, f))
  const cursors: Record<string, string> = {}
  for (const [id, c] of Object.entries(events.cursors ?? {})) cursors[id] = url((c as { file: string }).file)
  return {
    dir, name: basename(dir), createdAt: statSync(ev).mtime.toISOString(), events,
    assets: { screen: url(events.files.screen), mic: events.files.mic ? url(events.files.mic) : null, cursors },
  }
}

/** Folders the recorder started but never finished (crash, force quit, power loss). */
function listUnfinished(): UnfinishedRecording[] {
  const out: UnfinishedRecording[] = []
  for (const d of readdirSync(RECORDINGS)) {
    const dir = join(RECORDINGS, d)
    const setup = join(dir, 'recording.json')
    if (!existsSync(setup) || existsSync(join(dir, 'events.json'))) continue
    if (recorder.state !== 'idle' && recorder.currentOut === dir) continue   // the one being recorded right now
    try {
      const s = JSON.parse(readFileSync(setup, 'utf8'))
      out.push({ dir, name: d, startedAt: s.startedAt ?? statSync(setup).mtime.toISOString(), display: s.display, mic: s.mic ?? null })
    } catch { /* torn file: ignore */ }
  }
  return out.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

// Recovery progress is shown inline on the home screen, never as a new recording.
recorder.on('recover', (ev: RecorderEvent) => {
  if (ev.event === 'finalizing') broadcast({ event: 'recovering', step: ev.step })
  else if (ev.event === 'ready') broadcast({ event: 'recovering', step: 'done' })
})
recorder.on('level', (level: number) => win?.webContents.send('mic:level', level))

recorder.on('event', (raw: RecorderEvent) => {
  let ev = raw
  if (raw.event === 'ready') {
    const project = loadProject(raw.out)
    ev = project ? { ...raw, project } : { event: 'error', code: 'no_project', message: 'Recording finished but no project was written.' }
  }
  if (ev.event === 'ready' || ev.event === 'error') {
    hideBar(); globalShortcut.unregisterAll()
    if (win) { win.show(); win.focus() } else createWindow()
  }
  broadcast(ev)
})

app.whenReady().then(async () => {
  await mkdir(RECORDINGS, { recursive: true })
  server = await AssetServer.start(RECORDINGS)

  ipcMain.handle('devices:list', (): Promise<Devices> => recorder.listDevices())
  ipcMain.handle('permissions:check', (_e, request: boolean) => recorder.checkPermissions(request))
  ipcMain.handle('settings:open', (_e, which: 'screen' | 'mic') => shell.openExternal(SETTINGS_URL[which]))
  ipcMain.handle('recording:start', async (_e, opts: StartOptions) => {
    recorder.stopMeter()
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)
    await recorder.start({ ...opts, out: join(RECORDINGS, stamp) })
    win?.hide(); showBar()
    globalShortcut.register('CommandOrControl+Shift+S', () => recorder.stop())
    globalShortcut.register('CommandOrControl+Shift+P', () => (recorder.state === 'paused' ? recorder.resume() : recorder.pause()))
  })
  ipcMain.handle('recording:pause', () => recorder.pause())
  ipcMain.handle('recording:resume', () => recorder.resume())
  ipcMain.handle('recording:stop', () => recorder.stop())
  ipcMain.handle('recording:state', () => ({ state: recorder.state, since: recorder.since, pausedTotal: recorder.pausedTotal, startedAt: recorder.startedAt }))
  ipcMain.handle('projects:list', (): Project[] =>
    readdirSync(RECORDINGS).map((d) => loadProject(join(RECORDINGS, d))).filter((p): p is Project => !!p)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
  ipcMain.handle('projects:unfinished', (): UnfinishedRecording[] => listUnfinished())
  ipcMain.handle('projects:recover', async (_e, dir: string): Promise<Project> => {
    if (!dir.startsWith(RECORDINGS)) throw new Error('not a recording folder')
    await recorder.recover(dir)
    const p = loadProject(dir); if (!p) throw new Error('The recording was finalised but could not be opened.')
    return p
  })
  ipcMain.handle('mic:meter:start', (_e, mic: number) => { if (recorder.state === 'idle') recorder.startMeter(mic) })
  ipcMain.handle('mic:meter:stop', () => recorder.stopMeter())
  ipcMain.handle('project:export', async (_e, dir: string, config: RenderConfig) => {
    const p = loadProject(dir); if (!p) throw new Error('project not found')
    const send = (prog: ExportProgress) => win?.webContents.send('export:progress', prog)
    return exportProject(APP_ROOT, p, config, send)
  })
  ipcMain.handle('shell:reveal', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('project:trash', (_e, dir: string) => shell.trashItem(dir))

  createWindow()
  app.on('activate', () => { if (!win) createWindow(); else win.show() })
})
app.on('window-all-closed', () => { /* keep running while the control bar is up */ if (recorder.state === 'idle') app.quit() })
app.on('before-quit', () => recorder.kill())
