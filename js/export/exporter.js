/**
 * Frame-exact video export with the sequence's audio.
 *
 * Every frame is rendered at `n / fps` with all of its programs compiled
 * first, so nothing is ever skipped or late. The mix of the sequence's
 * audio tracks over the same range is encoded alongside, sample exact to
 * the frame grid, and the programs read the same deterministic analysis
 * of that audio that they read in the preview. Mediabunny muxes MP4
 * (H.264 + AAC, falling back to Opus) or WebM (VP9 + Opus).
 */

import {
    Output, Mp4OutputFormat, WebMOutputFormat, BufferTarget, StreamTarget, CanvasSource, AudioBufferSource,
    canEncodeVideo, canEncodeAudio, Quality, QUALITY_HIGH,
} from 'mediabunny'
import { frameCount } from '../model/time.js'
import { SAMPLE_RATE } from '../audio/media.js'

// Bits per pixel per frame. Left to choose its own quantizer, a hardware
// encoder spent 82 Mbps on grainy 720p shader output; explicit rates keep a
// music video a sensible size (1080p30: about 6, 12 and 22 Mbps).
const BITS_PER_PIXEL = { medium: 0.1, high: 0.2, best: 0.35 }

export function videoBitrate(quality, width, height, fps) {
    return Math.round((BITS_PER_PIXEL[quality] || BITS_PER_PIXEL.high) * width * height * fps)
}
const VIDEO_CODECS = { mp4: ['avc', 'hevc', 'vp9', 'av1'], webm: ['vp9', 'vp8', 'av1'] }
const AUDIO_CODECS = { mp4: ['aac', 'opus'], webm: ['opus'] }
export const PREROLL_SECONDS = 2

const even = n => Math.max(2, Math.round(n / 2) * 2)

async function pick(list, test) {
    for (const codec of list) {
        try {
            if (await test(codec)) return codec
        } catch { /* try the next */ }
    }
    return null
}

/** What this browser can encode for a format and size. */
export async function probeCodecs(format, width, height, fps) {
    const video = await pick(VIDEO_CODECS[format], c => canEncodeVideo(c, { width: even(width), height: even(height), frameRate: fps, quality: QUALITY_HIGH }))
    const audio = await pick(AUDIO_CODECS[format], c => canEncodeAudio(c, { numberOfChannels: 2, sampleRate: SAMPLE_RATE, quality: QUALITY_HIGH }))
    return { video, audio }
}

/**
 * Export a range of a sequence.
 * @param {object} o
 * @param {object} o.seq - the sequence
 * @param {object} o.project
 * @param {import('../render/sequenceRenderer.js').SequenceRenderer} o.renderer
 * @param {import('../render/pool.js').RendererPool} o.pool
 * @param {import('../audio/engine.js').AudioEngine} o.audio
 * @param {object} o.settings - {format, width, height, start, end, quality, includeAudio}
 * @param {FileSystemFileHandle} [o.fileHandle] - stream straight to this file when given
 * @param {(p: object) => void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{blob: Blob|null, frames: number, videoCodec: string, audioCodec: string|null, mimeType: string}>}
 */
/**
 * Wrap a file's writable stream to report how many bytes have reached it.
 * The muxer writes { type: 'write', data, position } chunks.
 */
function countingStream(writable, onBytes) {
    const writer = writable.getWriter()
    let size = 0
    const stream = new WritableStream({
        async write(chunk) {
            await writer.write(chunk)
            const length = chunk?.data?.byteLength ?? chunk?.byteLength ?? 0
            const end = (chunk?.position ?? size) + length
            if (end > size) {
                size = end
                onBytes(size)
            }
        },
        close: () => writer.close(),
        abort: reason => writer.abort(reason),
    })
    // Discards the partly written file when an export fails or is cancelled.
    stream.discardFile = reason => writer.abort(reason)
    return stream
}

export async function exportSequence({ seq, project, renderer, pool, audio, settings, fileHandle = null, onProgress = () => {}, signal }) {
    const fps = seq.fps
    const width = even(settings.width)
    const height = even(settings.height)
    const start = settings.start
    const end = settings.end
    const frames = frameCount(end - start, fps)
    if (frames < 1) throw new Error('The export range is empty')

    onProgress({ phase: 'prepare', message: 'Checking the encoders' })
    const codecs = await probeCodecs(settings.format, width, height, fps)
    if (!codecs.video) throw new Error(`This browser cannot encode ${settings.format.toUpperCase()} video at ${width}×${height}`)
    const withAudio = settings.includeAudio && !!codecs.audio
    if (settings.includeAudio && !codecs.audio) onProgress({ phase: 'warning', message: 'This browser cannot encode audio for this format; the video will be silent.' })

    onProgress({ phase: 'prepare', message: 'Mixing the audio' })
    await audio.mix(project, seq)

    const previous = { width: pool.width, height: pool.height }
    const aborted = () => signal?.aborted
    const startedAt = performance.now()
    let fileStream = null
    let output = null
    renderer.exporting = true
    try {
        pool.resizeAll(width, height)
        pool.resetAll()

        const canvas = document.createElement('canvas')
        canvas.width = width
        canvas.height = height
        const ctx = canvas.getContext('2d', { alpha: false })

        let target
        let written = 0
        if (fileHandle) {
            onProgress({ phase: 'prepare', message: `Opening ${fileHandle.name}` })
            fileStream = countingStream(await fileHandle.createWritable(), bytes => { written = bytes })
            target = new StreamTarget(fileStream, { chunked: true, chunkSize: 2 ** 21 })
        } else {
            target = new BufferTarget()
        }
        const format = settings.format === 'webm'
            ? new WebMOutputFormat()
            : new Mp4OutputFormat({ fastStart: fileHandle ? false : 'in-memory' })
        output = new Output({ format, target })
        const quality = new Quality({ bitrate: videoBitrate(settings.quality, width, height, fps) })
        const videoSource = new CanvasSource(canvas, { codec: codecs.video, quality, keyFrameInterval: 2, sizeChangeBehavior: 'contain' })
        output.addVideoTrack(videoSource, { frameRate: fps })
        let audioSource = null
        if (withAudio) {
            audioSource = new AudioBufferSource({ codec: codecs.audio, quality: QUALITY_HIGH })
            output.addAudioTrack(audioSource)
        }

        onProgress({ phase: 'prepare', message: 'Preparing the renderers' })
        await output.start()

        // Pre-roll stateful programs into the range, as continuous playback would have.
        if (start > 0) {
            const pre = Math.min(start, PREROLL_SECONDS)
            const preFrames = Math.round(pre * fps)
            for (let i = preFrames; i > 0; i--) {
                if (aborted()) throw new DOMException('Export cancelled', 'AbortError')
                await renderer.renderFrameExact(seq, start - i / fps, { seek: i === preFrames })
                onProgress({ phase: 'preroll', done: preFrames - i + 1, total: preFrames })
            }
        }

        const mix = withAudio ? audio.exportBuffer(seq, start, start + frames / fps) : null
        let audioSent = 0
        const sendAudioUntil = async seconds => {
            if (!mix) return
            const until = Math.min(mix.length, Math.round(seconds * SAMPLE_RATE))
            if (until <= audioSent) return
            const slice = new AudioBuffer({ numberOfChannels: 2, length: until - audioSent, sampleRate: SAMPLE_RATE })
            for (let c = 0; c < 2; c++) slice.copyToChannel(mix.getChannelData(c).subarray(audioSent, until), c)
            audioSent = until
            await audioSource.add(slice)
        }

        const renderStart = performance.now()
        for (let i = 0; i < frames; i++) {
            if (aborted()) throw new DOMException('Export cancelled', 'AbortError')
            const t = start + i / fps
            const { canvas: frame } = await renderer.renderFrameExact(seq, t, { seek: i === 0 && start === 0 })
            ctx.drawImage(frame, 0, 0, width, height)
            await videoSource.add(i / fps, 1 / fps)
            if (i % fps === fps - 1 || i === frames - 1) await sendAudioUntil((i + 1) / fps + 0.5)
            const elapsed = (performance.now() - startedAt) / 1000
            onProgress({
                phase: 'render',
                done: i + 1,
                total: frames,
                elapsed,
                eta: (performance.now() - renderStart) / 1000 / (i + 1) * (frames - i - 1),
                written,
                canvas,
            })
        }
        await sendAudioUntil(frames / fps)
        videoSource.close()
        audioSource?.close()
        onProgress({ phase: 'finalize', written })
        await output.finalize()
        const mimeType = settings.format === 'webm' ? 'video/webm' : 'video/mp4'
        const blob = fileHandle ? null : new Blob([target.buffer], { type: mimeType })
        const size = blob ? blob.size : written
        return { blob, size, frames, videoCodec: codecs.video, audioCodec: withAudio ? codecs.audio : null, mimeType }
    } catch (err) {
        try { await output?.cancel() } catch { /* already closed */ }
        try { await fileStream?.discardFile(err) } catch { /* already closed or aborted */ }
        throw err
    } finally {
        pool.resizeAll(previous.width, previous.height)
        pool.resetAll()
        renderer.exporting = false
    }
}
