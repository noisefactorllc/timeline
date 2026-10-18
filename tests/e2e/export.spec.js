import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

test('export renders every frame and muxes the timeline audio', async ({ page }) => {
    await boot(page)
    const info = await page.evaluate(async () => {
        const tl = window.__timeline
        const { probeCodecs } = await import('/js/export/exporter.js')
        const mp4 = await probeCodecs('mp4', 320, 180, 30)
        const format = mp4.video && mp4.audio ? 'mp4' : 'webm'
        const start = 60 / 128 * 4 * 8 - 0.5
        const result = await tl.exportSequence({ format, width: 320, height: 180, start, end: start + 1.5, quality: 'medium', includeAudio: true })
        const mb = await import('mediabunny')
        const input = new mb.Input({ source: new mb.BlobSource(result.blob), formats: mb.ALL_FORMATS })
        const video = await input.getPrimaryVideoTrack()
        const audio = await input.getPrimaryAudioTrack()
        const stats = await video.computePacketStats()
        let sum = 0
        let n = 0
        let firstLoud = null
        let t = 0
        for await (const { buffer, timestamp } of new mb.AudioBufferSink(audio).buffers()) {
            const d = buffer.getChannelData(0)
            for (let i = 0; i < d.length; i++) {
                sum += d[i] * d[i]
                n++
                if (firstLoud === null && Math.abs(d[i]) > 0.3) firstLoud = timestamp + i / buffer.sampleRate
            }
            t = timestamp
        }
        // Decode a frame from each side of the build's first kick to prove frames differ.
        const sink = new mb.CanvasSink(video, { width: 64, height: 36, fit: 'fill' })
        const sig = async ts => {
            const wrapped = await sink.getCanvas(ts)
            const d = wrapped.canvas.getContext('2d').getImageData(0, 0, 64, 36).data
            let s = 0
            for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]
            return s
        }
        return {
            format,
            frames: result.frames,
            packets: stats.packetCount,
            videoCodec: video.codec,
            audioCodec: audio?.codec,
            channels: audio?.numberOfChannels,
            rate: audio?.sampleRate,
            rms: Math.sqrt(sum / Math.max(1, n)),
            firstLoud,
            a: await sig(0.1),
            b: await sig(1.2),
        }
    })
    expect(info.frames).toBe(45)
    expect(info.packets).toBe(45)
    expect(info.audioCodec).toBeTruthy()
    expect(info.channels).toBe(2)
    expect(info.rate).toBe(48000)
    expect(info.rms).toBeGreaterThan(0.01)
    // The first kick of the build lands 0.5 s into this range.
    expect(info.firstLoud).toBeGreaterThan(0.45)
    expect(info.firstLoud).toBeLessThan(0.6)
    expect(info.a).not.toBe(info.b)
})
