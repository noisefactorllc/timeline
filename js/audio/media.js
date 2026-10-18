/**
 * Audio media: decoding, the generated demo stems, and waveform peaks.
 *
 * A media record in the project describes the source: imported files keep
 * their bytes in IndexedDB; generated media carry a recipe and are rebuilt
 * on load. Decoded AudioBuffers are cached in memory, resampled to 48 kHz.
 */

import { loadMedia, saveMedia } from '../storage/db.js'
import { uid } from '../model/project.js'
import { renderDemoStems, DEMO_DURATION } from './demoTrack.js'

export const SAMPLE_RATE = 48000

const buffers = new Map()
const pending = new Map()
const peaksCache = new WeakMap()
let demoStems = null

let decodeCtx = null
function decoder() {
    if (!decodeCtx) decodeCtx = new OfflineAudioContext({ numberOfChannels: 2, length: 1, sampleRate: SAMPLE_RATE })
    return decodeCtx
}

async function generate(recipe) {
    if (recipe.generator === 'demo-track') {
        if (!demoStems) demoStems = renderDemoStems()
        const stems = await demoStems
        return stems[recipe.stem] || stems.music
    }
    throw new Error(`Unknown audio generator: ${recipe.generator}`)
}

/** Decoded AudioBuffer for a project media record (cached). */
export function getAudioBuffer(media) {
    if (!media) return Promise.resolve(null)
    if (buffers.has(media.id)) return Promise.resolve(buffers.get(media.id))
    if (pending.has(media.id)) return pending.get(media.id)
    const job = (async () => {
        let buffer
        if (media.recipe) {
            buffer = await generate(media.recipe)
        } else {
            const record = await loadMedia(media.id)
            if (!record) throw new Error(`Audio "${media.name}" is missing from this browser's storage`)
            buffer = await decoder().decodeAudioData(record.bytes.slice(0))
        }
        buffers.set(media.id, buffer)
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

/** Media records for the generated demo stems. */
export function demoMedia() {
    return {
        'med_demo_drums': {
            id: 'med_demo_drums', kind: 'audio', name: 'Demo drums', duration: DEMO_DURATION,
            recipe: { generator: 'demo-track', stem: 'drums' },
        },
        'med_demo_music': {
            id: 'med_demo_music', kind: 'audio', name: 'Demo music', duration: DEMO_DURATION,
            recipe: { generator: 'demo-track', stem: 'music' },
        },
    }
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
