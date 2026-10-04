// 交付用静态服务：只服务 dist，供本地预览与截图验收
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = 'C:/LFModels/workspaces/series-0x2b/dist'
const PORT = Number(process.env.PORT || 4319)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.glb': 'model/gltf-binary',
  '.svg': 'image/svg+xml',
}

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || '/').split('?')[0])
  let rel = url === '/' ? 'index.html' : url.slice(1)
  if (!path.extname(rel)) rel = 'index.html'
  const full = path.resolve(ROOT, rel)
  if (!full.startsWith(path.resolve(ROOT))) { res.writeHead(403).end('forbidden'); return }
  fs.readFile(full, (e, buf) => {
    if (e) { res.writeHead(404, { 'content-type': 'text/plain' }).end('not found: ' + rel); return }
    res.writeHead(200, { 'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(buf)
  })
}).listen(PORT, '127.0.0.1', () => console.log(`SERIES 0x2B preview → http://127.0.0.1:${PORT}/  (root: ${ROOT})`))
