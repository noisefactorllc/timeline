import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    keyValue, setKey, removeKey, keyAt, keyTimes, clipGainAt, duckRegions, duckGainAt, trackGainCurve, dbToGain, gainToDb,
} from '../../js/model/automation.js'
import { createSequence, createProgramClip, createAudioClip, createTextClip } from '../../js/model/project.js'
import { insertClip, splitClip, trimClip } from '../../js/model/edit.js'
import { normalizeProject } from '../../js/model/normalize.js'

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`)

test('keys hold before the first and after the last, and ease between', () => {
    const keys = [{ t: 1, v: 0 }, { t: 3, v: 10, ease: 'none' }, { t: 5, v: 0, ease: 'power2.inOut' }]
    assert.equal(keyValue(keys, 0, 99), 0)
    assert.equal(keyValue(keys, 2, 99), 5)
    assert.equal(keyValue(keys, 4, 99), 5)
    assert.equal(keyValue(keys, 9, 99), 0)
    assert.equal(keyValue(undefined, 2, 99), 99)
    assert.equal(keyValue([], 2, 99), 99)
})

test('setting a key at a time replaces it there, and removing the last key returns the own value', () => {
    const clip = createTextClip({ duration: 4 })
    setKey(clip, 'x', 2, 0.2)
    setKey(clip, 'x', 0, 0.8)
    setKey(clip, 'x', 2.0004, 0.3)
    assert.deepEqual(clip.keys.x.map(k => [k.t, k.v]), [[0, 0.8], [2.0004, 0.3]])
    assert.ok(keyAt(clip, 'x', 2))
    setKey(clip, 'opacity', 1, 0.5)
    assert.deepEqual(keyTimes(clip), [0, 1, 2])
    removeKey(clip, 'x', 0)
    removeKey(clip, 'x', 2)
    removeKey(clip, 'opacity', 1)
    assert.equal(clip.keys, undefined)
})

test('an audio clip gain multiplies its level, its keys and its fades', () => {
    const clip = createAudioClip({ mediaId: 'm', start: 10, duration: 4 })
    Object.assign(clip, { gain: 0.5, fadeIn: 1, fadeOut: 1 })
    near(clipGainAt(clip, 0), 0)
    near(clipGainAt(clip, 0.5), 0.25)
    near(clipGainAt(clip, 2), 0.5)
    near(clipGainAt(clip, 3.5), 0.25)
    clip.keys = { gain: [{ t: 1, v: 1 }, { t: 3, v: 0, ease: 'none' }] }
    near(clipGainAt(clip, 2), 0.5, 1e-9)
    near(dbToGain(-6.0206), 0.5, 1e-4)
    near(gainToDb(0.5), -6.0206, 1e-3)
})

function voiceAndMusic(duck) {
    const seq = createSequence({ duration: 20, tracks: 1, audioTracks: 0 })
    seq.audioTracks.push({ id: 'music', name: 'Music', muted: false, solo: false, gain: 1, clips: [createAudioClip({ mediaId: 'm', start: 0, duration: 20 })], duck })
    seq.audioTracks.push({ id: 'voice', name: 'Voice', muted: false, solo: false, gain: 1, clips: [
        createAudioClip({ mediaId: 'v', start: 4, duration: 2 }),
        createAudioClip({ mediaId: 'v', start: 6.3, duration: 1.7 }),
        createAudioClip({ mediaId: 'v', start: 12, duration: 2 }),
    ] })
    return seq
}

test('a ducked track dips while the other plays, holding through short pauses', () => {
    const seq = voiceAndMusic({ under: 'Voice', depth: -12, attack: 0.5, release: 1, hold: 0.5 })
    const music = seq.audioTracks[0]
    assert.deepEqual(duckRegions(seq, music), [[4, 8], [12, 14]], 'the 0.3 s pause is held, the 4 s gap is not')
    const low = dbToGain(-12)
    near(duckGainAt(music.duck, duckRegions(seq, music), 2), 1)
    near(duckGainAt(music.duck, duckRegions(seq, music), 3.75), 1 + (low - 1) * 0.5)
    near(duckGainAt(music.duck, duckRegions(seq, music), 6.15), low)
    near(duckGainAt(music.duck, duckRegions(seq, music), 8.5), low + (1 - low) * 0.5)
    near(duckGainAt(music.duck, duckRegions(seq, music), 10), 1)
    const curve = trackGainCurve(seq, music, 100)
    near(curve[600], low)
    near(curve[1000], 1)
    // The voice track names no duck, so it keeps its level.
    assert.equal(trackGainCurve(seq, seq.audioTracks[1], 100), null)
    // A muted voice does not duck the music.
    seq.audioTracks[1].muted = true
    assert.deepEqual(duckRegions(seq, music), [])
})

/** A decoded-audio stand-in: loud where `loud(t)` says so, silent elsewhere. */
function fakeBuffer(seconds, loud, rate = 1000) {
    const data = new Float32Array(seconds * rate)
    for (let i = 0; i < data.length; i++) data[i] = loud(i / rate) ? 0.5 * Math.sin(i) : 0
    return { sampleRate: rate, length: data.length, numberOfChannels: 1, getChannelData: () => data }
}

test('a duck follows where one long voice clip actually sounds, not the whole clip', () => {
    const seq = createSequence({ duration: 20, tracks: 1, audioTracks: 0 })
    const voiceClip = createAudioClip({ mediaId: 'v', start: 2, duration: 12, offset: 1 })
    seq.audioTracks.push({ id: 'music', name: 'Music', muted: false, solo: false, gain: 1, clips: [], duck: { under: 'Voice', depth: -12, attack: 0.3, release: 0.75, hold: 0.5 } })
    seq.audioTracks.push({ id: 'voice', name: 'Voice', muted: false, solo: false, gain: 1, clips: [voiceClip] })
    // Speech from 2 to 4 s and 4.3 to 5 s into the file, then 9 to 10 s; silence otherwise.
    const buffer = fakeBuffer(14, t => (t >= 2 && t < 4) || (t >= 4.3 && t < 5) || (t >= 9 && t < 10))
    const media = { v: { id: 'v' } }
    const regions = duckRegions(seq, seq.audioTracks[0], () => buffer, media)
    // File time t plays at sequence time t + 1 (clip at 2 s, 1 s into the file).
    assert.equal(regions.length, 2)
    near(regions[0][0], 3, 0.06)
    near(regions[0][1], 6, 0.06)
    near(regions[1][0], 10, 0.06)
    near(regions[1][1], 11, 0.06)
    // Clips mode, or audio not decoded yet, dips for the whole clip.
    seq.audioTracks[0].duck.detect = 'clips'
    assert.deepEqual(duckRegions(seq, seq.audioTracks[0], () => buffer, media), [[2, 14]])
    seq.audioTracks[0].duck.detect = 'signal'
    assert.deepEqual(duckRegions(seq, seq.audioTracks[0], () => null, media), [[2, 14]])
})

test('splitting or trimming a clip keeps its keys where they were in the sequence', () => {
    const seq = createSequence({ tracks: 1, audioTracks: 0 })
    const clip = createProgramClip({ start: 10, duration: 4 })
    clip.keys = { opacity: [{ t: 0, v: 0 }, { t: 2, v: 1, ease: 'none' }, { t: 4, v: 0, ease: 'none' }] }
    insertClip(seq.tracks[0], clip)
    const right = splitClip(seq, clip.id, 11)
    assert.deepEqual(clip.keys.opacity.map(k => [k.t, k.v]), [[0, 0], [1, 0.5]])
    assert.deepEqual(right.keys.opacity.map(k => [k.t, k.v]), [[0, 0.5], [1, 1], [3, 0]])
    trimClip(seq, right.id, 'start', 12)
    assert.equal(right.start, 12)
    assert.deepEqual(right.keys.opacity.map(k => k.t), [-1, 0, 2])
    near(keyValue(right.keys.opacity, 0, 1), 1)
})

test('project.json keys and ducking are checked as they are read', () => {
    const { project, problems } = normalizeProject({
        media: { m: { path: 'media/m.flac' }, v: { path: 'media/v.wav' } },
        sequences: {
            main: {
                duration: 20,
                tracks: [{ clips: [{ start: 0, duration: 4, dsl: 'x', keys: { opacity: [{ t: 2, v: 1 }, { t: 0, v: 0, ease: 'expo.out' }, { t: 'a' }], hue: [] } }] }],
                audioTracks: [
                    { name: 'Music', duck: { under: 'Voice', depth: 3 }, clips: [{ mediaId: 'm', start: 0, keys: { gain: [{ t: 0, v: 0.2 }] } }] },
                    { name: 'Voice', clips: [{ mediaId: 'v', start: 4, duration: 2 }] },
                    { name: 'Other', duck: { under: 'Nobody' } },
                ],
            },
        },
    })
    const seq = project.sequences.main
    assert.deepEqual(seq.tracks[0].clips[0].keys.opacity, [{ t: 0, v: 0, ease: 'expo.out' }, { t: 2, v: 1 }])
    assert.deepEqual(seq.audioTracks[0].duck, { under: 'Voice', depth: -12, attack: 0.3, release: 0.75, hold: 0.5, threshold: -45, detect: 'signal' })
    assert.deepEqual(seq.audioTracks[0].clips[0].keys, { gain: [{ t: 0, v: 0.2 }] })
    assert.equal(seq.audioTracks[2].duck, undefined)
    const messages = problems.map(p => `${p.level}: ${p.message}`)
    assert.ok(messages.some(m => m.startsWith('warning: a key in keys.opacity needs a number "t"')))
    assert.ok(messages.some(m => m.startsWith('warning: "hue" cannot take keys')))
    assert.ok(messages.some(m => m.startsWith('warning: duck.depth must be a number of dB')))
    assert.ok(messages.includes('error: duck.under "Nobody" names no other audio track; it does not duck'))
})
