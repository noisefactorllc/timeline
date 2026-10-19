/**
 * Audio media: loading, decoding and waveform peaks.
 *
 * A media record in the project describes the source: imported files keep
 * their bytes in IndexedDB, and audio that ships with the app (the demo's
 * stems) is fetched from its URL. Decoded AudioBuffers are cached in
 * memory, resampled to 48 kHz.
 */

import { loadMedia, saveMedia } from '../storage/db.js'
import { uid } from '../model/project.js'
import { fetchBytes } from '../fetchBytes.js'

export const SAMPLE_RATE = 48000

const buffers = new Map()
const pending = new Map()
const peaksCache = new WeakMap()

let decodeCtx = null
function decoder() {
    if (!decodeCtx) decodeCtx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: SAMPLE_RATE })
    return decodeCtx
}

/**
 * True for a project made from an earlier demo. Those generated their
 * soundtrack in the browser from a recipe, and the generator is gone.
 */
export function usesEarlierDemo(project) {
    return Object.values(project?.media || {}).some(m => m.recipe)
}

/**
 * Decoded AudioBuffer for a project media record (cached). `onProgress`
 * receives { fraction, received, total } while a bundled file downloads
 * (bytes) and decodes.
 */
export function getAudioBuffer(media, { onProgress } = {}) {
    if (!media) return Promise.resolve(null)
    if (buffers.has(media.id)) return Promise.resolve(buffers.get(media.id))
    if (pending.has(media.id)) return pending.get(media.id)
    const job = (async () => {
        let buffer
        if (media.recipe) {
            throw new Error('This project uses the soundtrack of an earlier demo, which is no longer available')
        } else if (media.url) {
            const bytes = await fetchBytes(new URL(media.url, document.baseURI), (fraction, received, total) => {
                onProgress?.({ fraction: fraction * 0.9, received, total })
            })
            buffer = await decoder().decodeAudioData(bytes)
        } else {
            const record = await loadMedia(media.id)
            if (!record) throw new Error(`Audio "${media.name}" is missing from this browser's storage`)
            buffer = await decoder().decodeAudioData(record.bytes.slice(0))
        }
        buffers.set(media.id, buffer)
        onProgress?.({ fraction: 1 })
        return buffer
    })()
    pending.set(media.id, job)
    job.finally(() => pending.delete(media.id))
    return job
}

export function cachedAudioBuffer(mediaId) {
    return buffers.get(mediaId) || null
}

/** Import an audio file: store its bytes, decode it, return a media record. */
export async function importAudioFile(file) {
    const bytes = await file.arrayBuffer()
    const buffer = await decoder().decodeAudioData(bytes.slice(0))
    const media = {
        id: uid('med'),
        kind: 'audio',
        name: file.name.replace(/\.[^.]+$/, '') || 'Audio',
        type: file.type || 'audio/*',
        duration: buffer.duration,
        size: bytes.byteLength,
    }
    await saveMedia({ id: media.id, name: media.name, type: media.type, bytes })
    buffers.set(media.id, buffer)
    return media
}

/**
 * Min/max peaks per bucket for drawing a waveform, `buckets` wide.
 * Cached per buffer and size.
 */
export function waveformPeaks(buffer, buckets) {
    const key = `${buckets}`
    let perBuffer = peaksCache.get(buffer)
    if (!perBuffer) {
        perBuffer = new Map()
        peaksCache.set(buffer, perBuffer)
    }
    if (perBuffer.has(key)) return perBuffer.get(key)
    const ch0 = buffer.getChannelData(0)
    const ch1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : ch0
    const peaks = new Float32Array(buckets * 2)
    const per = ch0.length / buckets
    for (let b = 0; b < buckets; b++) {
        const from = Math.floor(b * per)
        const to = Math.min(ch0.length, Math.floor((b + 1) * per))
        let lo = 0
        let hi = 0
        const stride = Math.max(1, Math.floor((to - from) / 256))
        for (let i = from; i < to; i += stride) {
            const v = (ch0[i] + ch1[i]) * 0.5
            if (v < lo) lo = v
            if (v > hi) hi = v
        }
        peaks[b * 2] = lo
        peaks[b * 2 + 1] = hi
    }
    perBuffer.set(key, peaks)
    return peaks
}
