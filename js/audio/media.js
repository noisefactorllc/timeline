/**
 * Audio media: loading, decoding and waveform peaks.
 *
 * A media record in the project describes the source: imported files keep
 * their bytes in IndexedDB, audio that ships with the app (the demo's
 * stems) is fetched from its URL, and a project opened from a folder reads
 * its files by path from that folder. Decoded AudioBuffers are cached in
 * memory, resampled to 48 kHz, under a key that changes when the file does.
 */

import { loadMedia, saveMedia } from '../storage/db.js'
import { uid } from '../model/project.js'
import { fetchBytes } from '../fetchBytes.js'

export const SAMPLE_RATE = 48000

const buffers = new Map()
const pending = new Map()
const peaksCache = new WeakMap()

// The folder the open project reads its media from, if it has one.
let source = null

export function setMediaSource(next) {
    source = next
}

/** Cache key for a media record; a file changed on disk gets a new key. */
export function mediaKey(media) {
    if (!media) return null
    return media.path ? `${source?.token}:${media.path}@${source?.revOf(media.path) || ''}` : media.id
}

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
    const key = mediaKey(media)
    if (buffers.has(key)) return Promise.resolve(buffers.get(key))
    if (pending.has(key)) return pending.get(key)
    const job = (async () => {
        let buffer
        if (media.recipe) {
            throw new Error('This project uses the soundtrack of an earlier demo, which is no longer available')
        } else if (media.path) {
            if (!source) throw new Error(`Audio "${media.name}" is a file in a project folder, and no folder is open`)
            const bytes = await source.readBytes(media.path, (fraction, received, total) => {
                onProgress?.({ fraction: fraction * 0.9, received, total })
            })
            buffer = await decoder().decodeAudioData(bytes)
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
        buffers.set(mediaKey(media), buffer)
        onProgress?.({ fraction: 1 })
        return buffer
    })()
    pending.set(key, job)
    job.finally(() => pending.delete(key))
    return job
}

export function cachedAudioBuffer(media) {
    return buffers.get(mediaKey(media)) || null
}

/**
 * Import an audio file and return a media record. A project from a folder
 * gets a copy of the file in the folder; any other keeps the bytes in
 * IndexedDB.
 */
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
    if (source?.writable) media.path = await source.importFile(file)
    else await saveMedia({ id: media.id, name: media.name, type: media.type, bytes })
    buffers.set(mediaKey(media), buffer)
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
