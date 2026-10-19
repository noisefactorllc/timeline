/**
 * Values that change over time: keyframes on clip properties, the volume
 * of an audio clip, and ducking, where one audio track dips while another
 * plays (music under a voice).
 *
 * Keys live on a clip as `keys: { property: [{ t, v, ease }] }`, with `t`
 * in seconds from the clip's start. A key's `ease` shapes the change into
 * it from the key before. Before the first key a property holds that key's
 * value, and after the last it holds the last value.
 *
 * Ducking is a setting on the track that dips:
 *   duck: { under: 'Voice', depth: -12, attack: 0.3, release: 0.75, hold: 0.5 }
 * `under` names the track (by name or id) that triggers it. While that
 * track is sounding (louder than `threshold` dB), this track sits `depth`
 * dB lower; it ramps down over `attack` seconds before the sound and back
 * up over `release` after it. Gaps shorter than `hold` stay ducked, so
 * pauses between lines do not pump. With `detect: 'clips'` it dips for
 * the whole of every clip instead. The dip is an explicit curve, so its
 * depth and timing are exactly the numbers set, in preview and export.
 */

import { ease } from './ease.js'
import { clipEnd } from './project.js'

/** Properties that can take keys: every visual clip, and gain on audio clips. */
export const KEYABLE = {
    visual: ['opacity', 'x', 'y', 'scale', 'rotation'],
    audio: ['gain'],
}

export const DEFAULT_KEY_EASE = 'power2.inOut'

export const DUCK_DEFAULTS = { depth: -12, attack: 0.3, release: 0.75, hold: 0.5, threshold: -45 }

export const DUCK_DETECT = ['signal', 'clips']

/** Loudness is measured over windows this long when finding where a track sounds. */
const SIGNAL_WINDOW = 0.05

const signalCache = new WeakMap()

/**
 * Where an audio clip sounds louder than `threshold` dB, in sequence time:
 * windows of the decoded file whose RMS level passes it.
 */
export function signalSpans(clip, buffer, threshold, end) {
    const key = `${clip.start}|${clip.duration}|${clip.offset}|${threshold}|${end}`
    let perBuffer = signalCache.get(buffer)
    if (!perBuffer) signalCache.set(buffer, perBuffer = new Map())
    if (perBuffer.has(key)) return perBuffer.get(key)
    const rate = buffer.sampleRate
    const channels = Array.from({ length: Math.min(2, buffer.numberOfChannels) }, (_, c) => buffer.getChannelData(c))
    const limit = dbToGain(threshold)
    const stop = Math.min(clip.start + clip.duration, end)
    const spans = []
    for (let t = clip.start; t < stop; t += SIGNAL_WINDOW) {
        const from = Math.floor((clip.offset + t - clip.start) * rate)
        const to = Math.min(buffer.length, Math.floor((clip.offset + Math.min(t + SIGNAL_WINDOW, stop) - clip.start) * rate))
        if (from >= to) break
        let sum = 0
        for (const data of channels) for (let i = from; i < to; i++) sum += data[i] * data[i]
        const loud = Math.sqrt(sum / ((to - from) * channels.length)) * (clip.gain ?? 1) >= limit
        if (!loud) continue
        const last = spans[spans.length - 1]
        const b = Math.min(t + SIGNAL_WINDOW, stop)
        if (last && Math.abs(last[1] - t) < 1e-9) last[1] = b
        else spans.push([t, b])
    }
    perBuffer.set(key, spans)
    return spans
}

/** Value of keyed property `keys` at `t` seconds into the clip, or `fallback` without keys. */
export function keyValue(keys, t, fallback) {
    if (!Array.isArray(keys) || !keys.length) return fallback
    if (t <= keys[0].t) return keys[0].v
    for (let i = 1; i < keys.length; i++) {
        const b = keys[i]
        if (t < b.t) {
            const a = keys[i - 1]
            const span = b.t - a.t
            const p = span > 0 ? ease(b.ease || DEFAULT_KEY_EASE)((t - a.t) / span) : 1
            return a.v + (b.v - a.v) * p
        }
    }
    return keys[keys.length - 1].v
}

/** A property's value on a clip at sequence time `time`: its keys if it has any, else its own value. */
export function clipValue(clip, property, time, fallback) {
    const own = clip[property] ?? fallback
    return keyValue(clip.keys?.[property], time - clip.start, own)
}

/** Add or replace the key at `t` (within half a frame), keeping keys in time order. */
export function setKey(clip, property, t, v, { ease: easeName, tolerance = 1e-3 } = {}) {
    if (!clip.keys) clip.keys = {}
    const keys = (clip.keys[property] || []).filter(k => Math.abs(k.t - t) > tolerance)
    const previous = (clip.keys[property] || []).find(k => Math.abs(k.t - t) <= tolerance)
    keys.push({ t, v, ease: easeName || previous?.ease || DEFAULT_KEY_EASE })
    keys.sort((a, b) => a.t - b.t)
    clip.keys[property] = keys
}

/** Remove the key at `t`; a property left with no keys goes back to its own value. */
export function removeKey(clip, property, t, tolerance = 1e-3) {
    const keys = (clip.keys?.[property] || []).filter(k => Math.abs(k.t - t) > tolerance)
    if (keys.length) clip.keys[property] = keys
    else if (clip.keys) {
        delete clip.keys[property]
        if (!Object.keys(clip.keys).length) delete clip.keys
    }
}

export function keyAt(clip, property, t, tolerance = 1e-3) {
    return (clip.keys?.[property] || []).find(k => Math.abs(k.t - t) <= tolerance) || null
}

/** Times of every key on a clip, from its start, without repeats. */
export function keyTimes(clip) {
    const times = new Set()
    for (const keys of Object.values(clip.keys || {})) for (const k of keys) times.add(Math.round(k.t * 1000) / 1000)
    return [...times].sort((a, b) => a - b)
}

/** Linear gain of an audio clip `t` seconds into it: its level, its keys and its fades. */
export function clipGainAt(clip, t) {
    let g = keyValue(clip.keys?.gain, t, clip.gain ?? 1)
    const d = clip.duration
    const fadeIn = Math.min(clip.fadeIn || 0, d)
    const fadeOut = Math.min(clip.fadeOut || 0, d - fadeIn)
    if (fadeIn > 0 && t < fadeIn) g *= Math.max(0, t / fadeIn)
    if (fadeOut > 0 && t > d - fadeOut) g *= Math.max(0, (d - t) / fadeOut)
    return g
}

export function dbToGain(db) {
    return Math.pow(10, db / 20)
}

export function gainToDb(gain) {
    return 20 * Math.log10(Math.max(1e-5, gain))
}

/** The track that triggers a ducking setting, matched by id, then by name. */
export function duckTrigger(seq, track) {
    const under = track.duck?.under
    if (!under) return null
    return seq.audioTracks.find(t => t !== track && t.id === under) || seq.audioTracks.find(t => t !== track && t.name === under) || null
}

/**
 * The spans a ducked track dips for, with short gaps closed: where the
 * trigger track sounds, or, with `detect: 'clips'` or before its audio
 * has decoded, its clips. `getBuffer(media)` returns decoded audio or null.
 */
export function duckRegions(seq, track, getBuffer = null, media = {}) {
    const trigger = duckTrigger(seq, track)
    if (!trigger || trigger.muted) return []
    const hold = track.duck.hold ?? DUCK_DEFAULTS.hold
    const threshold = track.duck.threshold ?? DUCK_DEFAULTS.threshold
    const bySignal = track.duck.detect !== 'clips' && getBuffer
    const spans = trigger.clips.flatMap(c => {
        const buffer = bySignal ? getBuffer(media[c.mediaId]) : null
        if (buffer) return signalSpans(c, buffer, threshold, seq.duration)
        return [[c.start, Math.min(clipEnd(c), seq.duration)]]
    }).filter(([a, b]) => b > a).sort((a, b) => a[0] - b[0])
    const regions = []
    for (const span of spans) {
        const last = regions[regions.length - 1]
        if (last && span[0] - last[1] < hold) last[1] = Math.max(last[1], span[1])
        else regions.push([...span])
    }
    return regions
}

/** Linear gain of a ducked track at time `t`, from its regions. */
export function duckGainAt(duck, regions, t) {
    const low = dbToGain(duck.depth ?? DUCK_DEFAULTS.depth)
    const attack = Math.max(0, duck.attack ?? DUCK_DEFAULTS.attack)
    const release = Math.max(0, duck.release ?? DUCK_DEFAULTS.release)
    let g = 1
    for (const [a, b] of regions) {
        if (t < a - attack || t > b + release) continue
        let v
        if (t < a) v = attack > 0 ? 1 + (low - 1) * ((t - (a - attack)) / attack) : low
        else if (t <= b) v = low
        else v = release > 0 ? low + (1 - low) * ((t - b) / release) : 1
        g = Math.min(g, v)
    }
    return g
}

/**
 * A track's gain over the sequence sampled `rate` times a second: its own
 * gain times its ducking. Returns null when the track neither ducks nor
 * changes level.
 */
export function trackGainCurve(seq, track, rate = 1000, getBuffer = null, media = {}) {
    const gain = track.gain ?? 1
    const regions = track.duck ? duckRegions(seq, track, getBuffer, media) : []
    if (!regions.length && gain === 1) return null
    const n = Math.max(2, Math.ceil(seq.duration * rate) + 1)
    const curve = new Float32Array(n)
    for (let i = 0; i < n; i++) curve[i] = gain * (regions.length ? duckGainAt(track.duck, regions, i / rate) : 1)
    return curve
}
