// Render the demo soundtrack (synth.js) into the two lossless stems the
// app ships in media/. The synth runs in Chrome's OfflineAudioContext
// through Playwright; ffmpeg encodes 16-bit FLAC. Run after changing the
// synth: npm run demo-audio (needs Chrome and ffmpeg on the PATH).
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from '@playwright/test'
import { DEMO_BPM, DEMO_DURATION, DEMO_STEMS } from '../../js/data/demoProject.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const port = 3091
const server = spawn(process.execPath, [join(root, 'scripts/dev-server.mjs'), String(port), root], { stdio: ['ignore', 'pipe', 'inherit'] })

try {
    await new Promise((resolve, reject) => {
        server.stdout.on('data', chunk => { if (String(chunk).includes('dev server on')) resolve() })
        server.on('exit', code => reject(new Error(`The dev server exited (${code})`)))
    })
    const browser = await chromium.launch({ channel: 'chrome' })
    const page = await browser.newPage()
    await page.goto(`http://localhost:${port}/img/favicon.svg`)
    const stems = await page.evaluate(async () => {
        const synth = await import('/scripts/demo-track/synth.js')
        const rendered = await synth.renderDemoStems()
        const wav = buffer => {
            const n = buffer.length
            const bytes = new ArrayBuffer(44 + n * 4)
            const v = new DataView(bytes)
            const tag = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)) }
            tag(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); tag(8, 'WAVEfmt ')
            v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true)
            v.setUint32(24, buffer.sampleRate, true); v.setUint32(28, buffer.sampleRate * 4, true)
            v.setUint16(32, 4, true); v.setUint16(34, 16, true); tag(36, 'data'); v.setUint32(40, n * 4, true)
            const [l, r] = [buffer.getChannelData(0), buffer.getChannelData(1)]
            for (let i = 0; i < n; i++) {
                v.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, l[i])) * 32767), true)
                v.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, r[i])) * 32767), true)
            }
            let s = ''
            const u8 = new Uint8Array(bytes)
            for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000))
            return btoa(s)
        }
        return {
            bpm: synth.DEMO_BPM,
            duration: synth.DEMO_DURATION,
            stems: Object.fromEntries(Object.entries(rendered).map(([name, buffer]) => [name, wav(buffer)])),
        }
    })
    await browser.close()
    if (stems.bpm !== DEMO_BPM || stems.duration !== DEMO_DURATION) {
        throw new Error(`The synth renders ${stems.duration} s at ${stems.bpm} BPM; the demo project expects ${DEMO_DURATION} s at ${DEMO_BPM} BPM`)
    }
    for (const { stem, url } of DEMO_STEMS) {
        const out = join(root, url)
        mkdirSync(dirname(out), { recursive: true })
        const ff = spawnSync('ffmpeg', [
            '-v', 'error', '-y', '-f', 'wav', '-i', 'pipe:0',
            '-c:a', 'flac', '-compression_level', '12', '-map_metadata', '-1',
            '-fflags', '+bitexact', '-flags:a', '+bitexact', out,
        ], { input: Buffer.from(stems.stems[stem], 'base64') })
        if (ff.status !== 0) throw new Error(`ffmpeg failed for ${stem}: ${ff.stderr}`)
        console.log(`wrote ${url}`)
    }
} finally {
    server.kill()
}
