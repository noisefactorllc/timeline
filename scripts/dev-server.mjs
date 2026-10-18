// Zero-dependency static server for local development and the e2e suite.
// Serves the repository root with no caching so edits show on reload.
import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

const port = Number(process.argv[2] || 3027)
const root = resolve(process.argv[3] || '.')

const TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.woff2': 'font/woff2',
}

const server = createServer(async (req, res) => {
    try {
        const url = new URL(req.url, 'http://localhost')
        let path = normalize(decodeURIComponent(url.pathname))
        if (path.endsWith('/')) path += 'index.html'
        const file = join(root, path)
        if (!file.startsWith(root)) {
            res.writeHead(403).end()
            return
        }
        const info = await stat(file).catch(() => null)
        if (!info || !info.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found')
            return
        }
        const body = await readFile(file)
        res.writeHead(200, {
            'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
            'Cache-Control': 'no-cache',
        })
        res.end(body)
    } catch (err) {
        res.writeHead(500, { 'Content-Type': 'text/plain' }).end(String(err?.message || err))
    }
})

server.on('clientError', (_err, socket) => socket.destroy())
server.listen(port, () => console.log(`timeline dev server on http://localhost:${port}`))
