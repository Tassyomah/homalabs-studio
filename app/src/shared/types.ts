/** Shared between main, preload, renderer and the Remotion composition. */

export interface DisplayInfo {
  id: number; scale: number
  pointWidth: number; pointHeight: number
  width: number; height: number
}
export interface CursorShape { file: string; hotspot: [number, number]; size: [number, number] }
export interface ClickEvent { t: number; type: 'down' | 'up'; button: string; x: number; y: number }

/** events.json written by recorder/narrate.py. All `t` are host-clock seconds. */
export interface RecordingEvents {
  version: number
  display: DisplayInfo
  fps: number
  tLaunch: number; tEnd: number
  t0Video: number; t0Mic: number | null
  videoDuration: number; videoFrames: number
  cursors: Record<string, CursorShape>
  cursorChanges: [number, string][]
  moves: [number, number, number][]
  clicks: ClickEvent[]
  scrolls: unknown[]
  micOffset: number | null
  pauses?: [number, number][]
  files: { screen: string; mic: string | null }
}

export interface Project {
  dir: string
  name: string
  createdAt: string
  events: RecordingEvents
  /** http URLs served by the app for the renderer + Remotion. */
  assets: ProjectAssets
}
export interface ProjectAssets { screen: string; mic: string | null; cursors: Record<string, string> }

export type Background = 'indigo' | 'coral' | 'ink' | 'paper'
export interface RenderConfig {
  zoom: number          // 1 = off, 2 = Screen-Studio-like
  padding: number       // fraction of screen width on each side
  radius: number        // px at source scale
  background: Background
  cursorScale: number
  outputHeight: number  // 0 = source size
}
export const defaultConfig: RenderConfig = { zoom: 2, padding: 0.06, radius: 24, background: 'indigo', cursorScale: 1.6, outputHeight: 1080 }

export type ScreencastProps = { assets: ProjectAssets; events: RecordingEvents; config: RenderConfig; [k: string]: unknown }

export type MicPermission = 'authorized' | 'denied' | 'restricted' | 'notDetermined' | 'unknown'
export interface Permissions { screen: boolean; mic: MicPermission }
export type RecorderEvent =
  | { event: 'started'; out: string }
  | { event: 'paused'; t: number } | { event: 'resumed'; t: number }
  | { event: 'stopped'; out: string; duration: number }
  | { event: 'finalizing'; step: 'video' | 'audio' }
  | { event: 'ready'; out: string; project: Project }
  | { event: 'error'; code: string; message: string }
export type RecState = 'idle' | 'countdown' | 'recording' | 'paused' | 'finalizing'

export interface Devices {
  screens: { index: number; name: string }[]
  mics: { index: number; name: string }[]
  displays: { ordinal: number; id: number; width: number; height: number; name: string }[]
}
export interface StartOptions { screen: number; mic: number | null; fps: number }
export interface ExportProgress { progress: number; stage: 'bundling' | 'rendering' | 'done' | 'error'; message?: string; output?: string }

/** The API exposed to the renderer by preload. */
export interface NarrateApi {
  listDevices(): Promise<Devices>
  checkPermissions(request: boolean): Promise<Permissions>
  openSettings(which: 'screen' | 'mic'): Promise<void>
  startRecording(opts: StartOptions): Promise<void>
  pauseRecording(): Promise<void>
  resumeRecording(): Promise<void>
  stopRecording(): Promise<void>
  onRecorderEvent(cb: (e: RecorderEvent) => void): () => void
  getRecState(): Promise<{ state: RecState; since: number; pausedTotal: number; startedAt: number }>
  listProjects(): Promise<Project[]>
  exportProject(dir: string, config: RenderConfig): Promise<string>
  onExportProgress(cb: (p: ExportProgress) => void): () => void
  reveal(path: string): Promise<void>
  trashProject(dir: string): Promise<void>
}
