#!/usr/bin/env node
// Timeline from the command line: check a project folder, or render still
// frames of it, in the real app running in Chrome on this computer.
//
//   timeline check <folder>                     compile every program, load every file
//   timeline snapshot <folder> --at 4,1:12.5    PNG frames into <folder>/snapshots
//   timeline render <folder>                    the video into <folder>/renders
//
// The app loads from timeline.noisedeck.app (or --url). Its requests for the
// project's files are answered here from disk, inside Chrome, so the files
// never leave this computer. Needs Node 22 or later and Google Chrome or
// Chromium (set CHROME_PATH to use another build). No other dependencies.

import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, openSync, writeSync, closeSync } from 'node:fs'
import { readFile, realpath, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep, extname, basename } from 'node:path'

const DEFAULT_URL = 'https://timeline.noisedeck.app/'
const PROJECT_PREFIX = '__project__/'
const BOOT_TIMEOUT_MS = 180_000
const TYPES = {
    '.json': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac',
    '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg', '.flac': 'audio/flac', '.webm': 'audio/webm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4',
}

const USAGE = `Usage:
  timeline check <folder> [--url URL] [--json]
  timeline snapshot <folder> --at TIMES [--out DIR] [--sequence NAME] [--scale 0.5] [--url URL] [--json]
  timeline render <folder> [--out FILE] [--from TIME] [--to TIME] [--sequence NAME] [--scale 0.5]
                  [--format mp4|webm] [--quality medium|high|best] [--no-audio] [--url URL] [--json]

TIMES is a comma-separated list of seconds or minutes:seconds, such as 4,12.5,1:04.
Frames are written as PNG files to <folder>/snapshots unless --out names another folder.
A render covers the sequence's in to out points (or all of it) unless --from and --to say otherwise,
and is written to <folder>/renders/<sequence>.<format> unless --out names a file.`

function parseArgs(argv) {
    const [command, folder, ...rest] = argv
    const opts = { command, folder, url: DEFAULT_URL, json: false, scale: 1, format: 'mp4', quality: 'high', audio: true }
    const allowed = {
        check: new Set(['--url', '--json']),
        snapshot: new Set(['--url', '--json', '--at', '--out', '--sequence', '--scale']),
        render: new Set(['--url', '--json', '--out', '--from', '--to', '--sequence', '--scale', '--format', '--quality', '--no-audio']),
    }
    for (let i = 0; i < rest.length; i++) {
        const arg = rest[i]
        if (allowed[command] && !allowed[command].has(arg) &&
            Object.values(allowed).some(options => options.has(arg))) {
            throw new Error(`${arg} is not supported by ${command}`)
        }
        const value = () => {
            if (i + 1 >= rest.length) throw new Error(`${arg} needs a value`)
            return rest[++i]
        }
        if (arg === '--url') opts.url = value()
        else if (arg === '--json') opts.json = true
        else if (arg === '--at') opts.at = value()
        else if (arg === '--out') opts.out = value()
        else if (arg === '--sequence') opts.sequence = value()
        else if (arg === '--scale') opts.scale = Number(value())
        else if (arg === '--from') opts.from = parseTime(value())
        else if (arg === '--to') opts.to = parseTime(value())
        else if (arg === '--format') opts.format = value()
        else if (arg === '--quality') opts.quality = value()
        else if (arg === '--no-audio') opts.audio = false
        else throw new Error(`Unknown option ${arg}`)
    }
    return opts
}

function parseTime(text) {
    const parts = text.trim().split(':').map(Number)
    if (!parts.length || parts.some(n => !Number.isFinite(n) || n < 0)) throw new Error(`"${text}" is not a time; use seconds or minutes:seconds`)
    return parts.reduce((total, n) => total * 60 + n, 0)
}

function findChrome() {
    if (process.env.CHROME_PATH) return process.env.CHROME_PATH
    const candidates = {
        darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
        win32: [
            join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
            join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
            join(process.env.LOCALAPPDATA || '', 'Google\\Chrome\\Application\\chrome.exe'),
        ],
        linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser'],
    }[process.platform] || []
    const found = candidates.find(path => existsSync(path))
    if (!found) throw new Error('Google Chrome was not found; install it or set CHROME_PATH')
    return found
}

/** A minimal Chrome DevTools Protocol client over Node's built-in WebSocket. */
class Cdp {
    static async launch() {
        const profile = mkdtempSync(join(tmpdir(), 'timeline-cli-'))
        const chrome = spawn(findChrome(), [
            '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`,
            '--no-first-run', '--no-default-browser-check', '--mute-audio', '--hide-scrollbars',
            '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--window-size=1600,1000',
            'about:blank',
        ], { stdio: ['ignore', 'ignore', 'pipe'] })
        const endpoint = await new Promise((resolveEndpoint, reject) => {
            let log = ''
            const timer = setTimeout(() => reject(new Error(`Chrome did not start:\n${log}`)), 30_000)
            chrome.stderr.on('data', chunk => {
                log += chunk
                const match = log.match(/DevTools listening on (ws:\/\/\S+)/)
                if (match) {
                    clearTimeout(timer)
                    resolveEndpoint(match[1])
                }
            })
            chrome.on('exit', code => reject(new Error(`Chrome exited (${code}):\n${log}`)))
        })
        const cdp = new Cdp(new WebSocket(endpoint), chrome, profile)
        await new Promise((ok, fail) => {
            cdp.ws.addEventListener('open', ok, { once: true })
            cdp.ws.addEventListener('error', () => fail(new Error('Could not connect to Chrome')), { once: true })
        })
        return cdp
    }

    constructor(ws, chrome, profile) {
        this.ws = ws
        this.chrome = chrome
        this.profile = profile
        this.nextId = 1
        this.calls = new Map()
        this.handlers = new Map()
        ws.addEventListener('message', event => {
            const msg = JSON.parse(event.data)
            if (msg.id && this.calls.has(msg.id)) {
                const { ok, fail } = this.calls.get(msg.id)
                this.calls.delete(msg.id)
                if (msg.error) fail(new Error(`${msg.error.message}${msg.error.data ? `: ${msg.error.data}` : ''}`))
                else ok(msg.result)
            } else if (msg.method) {
                for (const fn of this.handlers.get(msg.method) || []) fn(msg.params, msg.sessionId)
            }
        })
    }

    send(method, params = {}, sessionId) {
        const id = this.nextId++
        this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }))
        return new Promise((ok, fail) => this.calls.set(id, { ok, fail }))
    }

    on(method, fn) {
        if (!this.handlers.has(method)) this.handlers.set(method, [])
        this.handlers.get(method).push(fn)
    }

    async close() {
        try { await this.send('Browser.close') } catch { /* already gone */ }
        try { this.ws.close() } catch { /* already closed */ }
        if (this.chrome.exitCode === null) {
            await new Promise(done => {
                const timer = setTimeout(() => { this.chrome.kill(); done() }, 5000)
                this.chrome.once('exit', () => { clearTimeout(timer); done() })
            })
        }
        rmSync(this.profile, { recursive: true, force: true })
    }
}

/** Answer the app's requests under the project prefix from the folder on disk. */
async function serveFolder(cdp, session, folder, base) {
    const root = resolve(folder)
    const realRoot = await realpath(root)
    const prefix = new URL(PROJECT_PREFIX, base).href
    cdp.on('Fetch.requestPaused', async (params, sessionId) => {
        if (sessionId !== session) return
        const { requestId, request } = params
        const reply = (code, body = Buffer.alloc(0), type = 'text/plain') => cdp.send('Fetch.fulfillRequest', {
            requestId,
            responseCode: code,
            responseHeaders: [
                { name: 'Content-Type', value: type },
                { name: 'Content-Length', value: String(body.length) },
                { name: 'Cache-Control', value: 'no-store' },
            ],
            body: body.toString('base64'),
        }, session).catch(() => {})
        try {
            const relative = decodeURIComponent(new URL(request.url).pathname.slice(new URL(prefix).pathname.length))
            const path = resolve(root, relative)
            if (path !== root && !path.startsWith(root + sep)) return reply(403, Buffer.from('outside the project folder'))
            const real = await realpath(path).catch(() => null)
            if (!real) return reply(404, Buffer.from(`${relative} is not in the project folder`))
            if (real !== realRoot && !real.startsWith(realRoot + sep)) return reply(403, Buffer.from('outside the project folder'))
            const info = await stat(real).catch(() => null)
            if (!info?.isFile()) return reply(404, Buffer.from(`${relative} is not in the project folder`))
            return reply(200, await readFile(real), TYPES[extname(path).toLowerCase()] || 'application/octet-stream')
        } catch (err) {
            return reply(500, Buffer.from(String(err?.message || err)))
        }
    })
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: `${prefix}*`, requestStage: 'Request' }] }, session)
}

async function openApp(opts) {
    const projectFile = join(opts.folder, 'project.json')
    if (!existsSync(projectFile)) throw new Error(`${projectFile} does not exist`)
    const base = new URL(opts.url.endsWith('/') ? opts.url : `${opts.url}/`)
    const cdp = await Cdp.launch()
    try {
        const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
        const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
        const pageErrors = []
        cdp.on('Runtime.exceptionThrown', (params, s) => {
            if (s === sessionId) pageErrors.push(params.exceptionDetails?.exception?.description || params.exceptionDetails?.text)
        })
        await cdp.send('Runtime.enable', {}, sessionId)
        await serveFolder(cdp, sessionId, opts.folder, base)
        await cdp.send('Page.enable', {}, sessionId)
        // The folder's name names a project that has none of its own.
        const name = encodeURIComponent(basename(resolve(opts.folder)))
        await cdp.send('Page.navigate', { url: new URL(`?project=${PROJECT_PREFIX}&name=${name}`, base).href }, sessionId)
        const evaluate = async expression => {
            const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
            if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text)
            return result.value
        }
        // Wait for the editor, or for the boot screen to report why it stopped.
        const booted = await evaluate(`new Promise(done => {
            const deadline = Date.now() + ${BOOT_TIMEOUT_MS}
            const look = () => {
                if (window.__timeline?.ready) return done({ ok: true })
                const status = document.querySelector('.tl-boot-status.is-error')
                if (status) return done({ ok: false, message: status.textContent })
                if (Date.now() > deadline) return done({ ok: false, message: 'Timeline did not finish loading in ${BOOT_TIMEOUT_MS / 1000} s' })
                setTimeout(look, 100)
            }
            look()
        })`)
        if (!booted.ok) throw new Error(booted.message)
        return { cdp, evaluate, pageErrors }
    } catch (err) {
        await cdp.close()
        throw err
    }
}

function printProblems(report) {
    for (const p of report.errors) console.log(`error    ${p.where}: ${p.message}`)
    for (const p of report.warnings) console.log(`warning  ${p.where}: ${p.message}`)
}

async function check(opts) {
    const { cdp, evaluate, pageErrors } = await openApp(opts)
    try {
        const report = await evaluate('window.__timeline.check()')
        if (pageErrors.length) {
            report.pageErrors = pageErrors
            report.errors.push(...pageErrors.map(message => ({ where: 'page', message })))
            report.ok = false
        }
        if (opts.json) console.log(JSON.stringify(report, null, 2))
        else {
            console.log(`${report.project}: ${report.sequences.length} ${report.sequences.length === 1 ? 'sequence' : 'sequences'}, ${report.programs} programs`)
            for (const s of report.sequences) console.log(`  ${s.name} (${s.id}): ${s.size}, ${s.fps} fps, ${s.duration} s, ${s.bpm} bpm, ${s.clips} clips, ${s.audioClips} audio clips`)
            printProblems(report)
            const errors = report.errors.length
            console.log(report.ok ? 'ok' : `${errors} ${errors === 1 ? 'error' : 'errors'}`)
        }
        return report.ok ? 0 : 1
    } finally {
        await cdp.close()
    }
}

async function snapshot(opts) {
    if (!opts.at) throw new Error('snapshot needs --at, such as --at 4,12.5,1:04')
    if (!(opts.scale > 0 && opts.scale <= 1)) throw new Error('--scale must be more than 0 and at most 1')
    const times = opts.at.split(',').map(parseTime)
    const out = resolve(opts.out || join(opts.folder, 'snapshots'))
    const { cdp, evaluate } = await openApp(opts)
    try {
        const options = JSON.stringify({ times, sequence: opts.sequence, scale: opts.scale })
        const result = await evaluate(`(async () => {
            const r = await window.__timeline.snapshot(${options})
            const base64 = bytes => {
                let s = ''
                for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
                return btoa(s)
            }
            return { ...r, frames: r.frames.map(f => ({ time: f.time, timecode: f.timecode, png: base64(f.bytes) })) }
        })()`)
        mkdirSync(out, { recursive: true })
        const slug = result.sequence.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '') || 'sequence'
        const written = result.frames.map(f => {
            const path = join(out, `${slug}-${f.timecode.replace(/:/g, '-')}.png`)
            writeFileSync(path, Buffer.from(f.png, 'base64'))
            return { time: f.time, timecode: f.timecode, path }
        })
        if (opts.json) console.log(JSON.stringify({ sequence: result.sequence, width: result.width, height: result.height, frames: written }, null, 2))
        else for (const f of written) console.log(`${f.timecode}  ${f.path}`)
        return 0
    } finally {
        await cdp.close()
    }
}

async function render(opts) {
    if (!['mp4', 'webm'].includes(opts.format)) throw new Error('--format must be mp4 or webm')
    if (!['medium', 'high', 'best'].includes(opts.quality)) throw new Error('--quality must be medium, high or best')
    if (!(opts.scale > 0 && opts.scale <= 1)) throw new Error('--scale must be more than 0 and at most 1')
    const { cdp, evaluate } = await openApp(opts)
    try {
        const options = JSON.stringify({
            sequence: opts.sequence, start: opts.from, end: opts.to, scale: opts.scale,
            format: opts.format, quality: opts.quality, includeAudio: opts.audio,
        })
        const started = Date.now()
        let last = ''
        const ticker = setInterval(async () => {
            try {
                const s = await evaluate('({ ...window.__timeline.renderState })')
                const line = s.phase === 'render' || s.phase === 'preroll'
                    ? `${s.phase === 'preroll' ? 'warming up' : 'rendering'} ${s.done} of ${s.total} frames`
                    : s.phase === 'finalize' ? 'finishing the file' : s.message || s.phase || ''
                if (line && line !== last && !opts.json) process.stderr.write(`${line}  (${Math.round((Date.now() - started) / 1000)} s)\n`)
                last = line
            } catch { /* the page is busy; ask again next tick */ }
        }, 2000)
        let info
        try {
            info = await evaluate(`window.__timeline.render(${options})`)
        } finally {
            clearInterval(ticker)
        }
        const slug = info.sequence.replace(/[^\p{L}\p{N}-]+/gu, '-').replace(/^-|-$/g, '') || 'sequence'
        const out = resolve(opts.out || join(opts.folder, 'renders', `${slug}.${opts.format}`))
        mkdirSync(join(out, '..'), { recursive: true })
        const fd = openSync(out, 'w')
        try {
            const CHUNK = 4 * 1024 * 1024
            for (let offset = 0; offset < info.size; offset += CHUNK) {
                writeSync(fd, Buffer.from(await evaluate(`window.__timeline.readRender(${offset}, ${CHUNK})`), 'base64'))
            }
        } finally {
            closeSync(fd)
        }
        const seconds = Math.round((Date.now() - started) / 100) / 10
        const result = { path: out, size: info.size, frames: info.frames, width: info.width, height: info.height, start: info.start, end: info.end, videoCodec: info.videoCodec, audioCodec: info.audioCodec, seconds }
        if (opts.json) console.log(JSON.stringify(result, null, 2))
        else console.log(`${out}  ${info.frames} frames, ${info.width}x${info.height}, ${info.videoCodec}${info.audioCodec ? ` + ${info.audioCodec}` : ', no audio'}, ${(info.size / 1048576).toFixed(1)} MB in ${seconds} s`)
        return 0
    } finally {
        await cdp.close()
    }
}

async function main() {
    let opts
    try {
        opts = parseArgs(process.argv.slice(2))
    } catch (err) {
        console.error(`${err.message}\n\n${USAGE}`)
        return 2
    }
    if (!['check', 'snapshot', 'render'].includes(opts.command) || !opts.folder) {
        console.error(USAGE)
        return 2
    }
    try {
        return opts.command === 'check' ? await check(opts) : opts.command === 'snapshot' ? await snapshot(opts) : await render(opts)
    } catch (err) {
        console.error(err?.message || err)
        return 1
    }
}

process.exitCode = await main()
