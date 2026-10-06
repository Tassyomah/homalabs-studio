import { contextBridge, ipcRenderer } from 'electron'
import type { NarrateApi, ExportProgress, RecorderEvent } from '../shared/types'

const listen = <T,>(channel: string) => (cb: (p: T) => void) => {
  const h = (_: unknown, p: T) => cb(p)
  ipcRenderer.on(channel, h)
  return () => { ipcRenderer.off(channel, h) }
}

const api: NarrateApi = {
  listDevices: () => ipcRenderer.invoke('devices:list'),
  checkPermissions: (request) => ipcRenderer.invoke('permissions:check', request),
  openSettings: (which) => ipcRenderer.invoke('settings:open', which),
  startRecording: (opts) => ipcRenderer.invoke('recording:start', opts),
  pauseRecording: () => ipcRenderer.invoke('recording:pause'),
  resumeRecording: () => ipcRenderer.invoke('recording:resume'),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  getRecState: () => ipcRenderer.invoke('recording:state'),
  onRecorderEvent: listen<RecorderEvent>('recorder:event'),
  listProjects: () => ipcRenderer.invoke('projects:list'),
  exportProject: (dir, config) => ipcRenderer.invoke('project:export', dir, config),
  onExportProgress: listen<ExportProgress>('export:progress'),
  reveal: (p) => ipcRenderer.invoke('shell:reveal', p),
  trashProject: (dir) => ipcRenderer.invoke('project:trash', dir),
}
contextBridge.exposeInMainWorld('narrate', api)
