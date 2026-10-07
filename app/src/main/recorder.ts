import { spawn, ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import type { Devices, Permissions, RecState, StartOptions } from '../shared/types'

type RawEvent = { event: string; [k: string]: unknown }

/** Interpreter for the Python recorders. Windows installs expose `python`; macOS ships `python3`. */
const PYTHON = process.env.NARRATE_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
const SPAWN = { windowsHide: true } as const

/**
 * Drives the recorder sidecar (recorder/narrate.py on macOS, recorder/narrate_win.py on Windows; the
 * Swift/ScreenCaptureKit recorder later — same line protocol). Emits 'event' with each JSON line the recorder prints.
 */
export class Recorder extends EventEmitter {
  private proc: ChildProcess | null = null
  state: RecState = 'idle'
  since = 0            // ms timestamp of the current state
  pausedTotal = 0      // ms spent paused in this recording
  startedAt = 0        // ms timestamp when recording began
  constructor(private script: string) { super() }

  private run(args: string[]): Promise<string> {
    return new Promise((res, rej) => {
      const p = spawn(PYTHON, [this.script, ...args], SPAWN)
      let out = '', err = ''
      p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d))
      p.on('error', (e) => rej(new Error(friendlySpawnError(e))))
      p.on('close', (code) => (code === 0 ? res(out) : rej(new Error(friendlyExit(err, code)))))
    })
  }
  listDevices(): Promise<Devices> { return this.run(['--list']).then(JSON.parse) }
  checkPermissions(request: boolean): Promise<Permissions> { return this.run(['--check', ...(request ? ['--request'] : [])]).then(JSON.parse) }

  start(opts: StartOptions & { out: string }): Promise<void> {
    if (this.proc) return Promise.reject(new Error('already recording'))
    const args = [this.script, 'record', '--out', opts.out, '--fps', String(opts.fps), '--screen', String(opts.screen)]
    if (opts.mic === null) args.push('--no-mic'); else args.push('--mic', String(opts.mic))
    return new Promise((res, rej) => {
      const p = spawn(PYTHON, args, { stdio: ['pipe', 'pipe', 'pipe'], ...SPAWN })
      this.proc = p
      let settled = false, buf = ''
      p.on('error', (e) => { this.proc = null; if (!settled) { settled = true; rej(new Error(friendlySpawnError(e))) } })
      p.stderr.on('data', (d) => console.log('[recorder]', String(d).trim()))
      p.stdout.on('data', (d) => {
        buf += d
        const lines = buf.split('\n'); buf = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.startsWith('{')) continue
          const ev = JSON.parse(line) as RawEvent
          this.track(ev)
          if (ev.event === 'started' && !settled) { settled = true; res() }
          if (ev.event === 'error' && !settled) { settled = true; rej(new Error(String(ev.message))) }
          this.emit('event', ev)
        }
      })
      p.on('close', (code) => {
        this.proc = null
        if (this.state !== 'idle') { this.setState('idle'); this.emit('event', { event: 'error', code: 'exit', message: `recorder exited (${code})` }) }
        if (!settled) { settled = true; rej(new Error(`recorder exited early (${code})`)) }
      })
    })
  }

  private setState(s: RecState) { this.state = s; this.since = Date.now() }
  private track(ev: RawEvent) {
    switch (ev.event) {
      case 'started': this.pausedTotal = 0; this.startedAt = Date.now(); this.setState('recording'); break
      case 'paused': this.setState('paused'); break
      case 'resumed': this.pausedTotal += Date.now() - this.since; this.setState('recording'); break
      case 'stopped': this.setState('finalizing'); break
      case 'ready': case 'error': this.setState('idle'); break
    }
  }
  private send(cmd: string) { this.proc?.stdin?.write(JSON.stringify({ cmd }) + '\n') }
  pause() { if (this.state === 'recording') this.send('pause') }
  resume() { if (this.state === 'paused') this.send('resume') }
  stop() { if (this.state === 'recording' || this.state === 'paused') this.send('stop') }
  kill() { this.proc?.kill('SIGTERM') }
}

const PYTHON_HELP = process.platform === 'win32'
  ? 'Narrate needs Python 3 to drive the recorder. Install it with `winget install Python.Python.3.12`, then reopen Narrate.'
  : 'Narrate needs python3 to drive the recorder. Install the Xcode command line tools, then reopen Narrate.'
function friendlySpawnError(e: NodeJS.ErrnoException) {
  return e.code === 'ENOENT' ? PYTHON_HELP : e.message
}
function friendlyExit(stderr: string, code: number | null) {
  if (/Python was not found/i.test(stderr) || code === 9009) return PYTHON_HELP
  return stderr.trim() || `recorder exited ${code}`
}
