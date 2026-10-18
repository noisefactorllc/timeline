import { test } from 'node:test'
import assert from 'node:assert/strict'

import { detectTempo } from '../../js/audio/tempo.js'

const SR = 48000

function clickTrack(bpm, offset, seconds, { accentEvery = 4 } = {}) {
    const data = new Float32Array(Math.round(seconds * SR))
    const beat = 60 / bpm
    let seed = 7
    const rand = () => {
        seed = (seed * 16807) % 2147483647
        return seed / 2147483647 * 2 - 1
    }
    for (let k = 0; offset + k * beat < seconds; k++) {
        const start = Math.round((offset + k * beat) * SR)
        const amp = k % accentEvery === 0 ? 0.9 : 0.6
        for (let i = 0; i < 2400 && start + i < data.length; i++) {
            const env = Math.exp(-i / 300)
            data[start + i] += amp * env * (0.6 * Math.sin(2 * Math.PI * 90 * i / SR) + 0.4 * rand())
        }
    }
    return data
}

test('detects the tempo and first beat of a click track', () => {
    const result = detectTempo([clickTrack(128, 0.2, 20)], SR)
    assert.ok(result)
    assert.equal(result.bpm, 128)
    assert.ok(Math.abs(result.offset - 0.2) < 0.02, `offset ${result.offset}`)
})

test('detects slower and faster tempos without halving or doubling', () => {
    assert.equal(detectTempo([clickTrack(90, 0.05, 20)], SR).bpm, 90)
    assert.equal(detectTempo([clickTrack(174, 0.1, 20)], SR).bpm, 174)
})

test('returns null for audio too short to judge', () => {
    assert.equal(detectTempo([new Float32Array(SR)], SR), null)
})
