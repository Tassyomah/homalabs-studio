import http from 'node:http'
import { createReadStream, statSync, existsSync } from 'node:fs'
import { resolve, extname } from 'node:path'
import type { AddressInfo } from 'node:net'

const TYPES: Record<string, string> = { '.mp4': 'video/mp4', '.wav': 'audio/wav', '.png': 'image/png', '.json': 'application/json' }

/** Serves the recordings folder over localhost with Range support, for <video> in the UI and Remotion's renderer. */
export class AssetServer {
  private constructor(private root: string, private port: number) {}

  static start(root: string): Promise<AssetServer> {
    return new Promise((res) => {
      const srv = http.createServer((req, rsp) => {
        const rel = decodeURIComponent((req.url ?? '/').split('?')[0])
        const file = resolve(root, '.' + rel)
        if (!file.startsWith(root) || !existsSync(file) || statSync(file).isDirectory()) { rsp.writeHead(404); return rsp.end() }
        const size = statSync(file).size
        const type = TYPES[extname(file)] ?? 'application/octet-stream'
        const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '')
        rsp.setHeader('Accept-Ranges', 'bytes'); rsp.setHeader('Content-Type', type); rsp.setHeader('Access-Control-Allow-Origin', '*')
        if (range) {
          const start = range[1] ? Number(range[1]) : 0
          const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1
          rsp.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 })
          createReadStream(file, { start, end }).pipe(rsp)
        } else {
          rsp.writeHead(200, { 'Content-Length': size }); createReadStream(file).pipe(rsp)
        }
      })
      srv.listen(0, '127.0.0.1', () => res(new AssetServer(root, (srv.address() as AddressInfo).port)))
    })
  }

  url(absPath: string): string {
    const rel = resolve(absPath).slice(this.root.length).split('/').map(encodeURIComponent).join('/')
    return `http://127.0.0.1:${this.port}${rel}`
  }
}
