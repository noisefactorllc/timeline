import { test } from 'node:test'
import assert from 'node:assert/strict'

import { AudioAnalyzer, ANALYSIS_HZ, applyFrame, silentFrame } from '../../js/audio/analysis.js'

const SR = 48000

function tone(freq, seconds, amp = 0.8) {
    const n = Math.round(seconds * SR)
    const data = new Float32Array(n)
    for (let i = 0; i < n; i++) data[i] = amp * Math.sin((2 * Math.PI * freq * i) / SR)
    return data
}

test('silence analyses to zero', () => {
    const a = new AudioAnalyzer([new Float32Array(SR)], SR)
    const f = a.frameAt(0.5)
    assert.equal(f.low, 0)
    assert.equal(f.mid, 0)
    assert.equal(f.high, 0)
    assert.equal(f.vol, 0)
    assert.equal(f.waveform[0], 128)
})

test('a low tone lights the low band, a high tone the high band', () => {
    const low = new AudioAnalyzer([tone(190, 1)], SR).frameAt(0.5)
    const high = new AudioAnalyzer([tone(4000, 1)], SR).frameAt(0.5)
    assert.ok(low.low > 0.5, `low band ${low.low}`)
    assert.ok(low.low > low.high)
    assert.ok(high.high > high.low, `high ${high.high} vs low ${high.low}`)
})

test('analysis is a pure function of time', () => {
    const data = tone(300, 2)
    for (let i = SR; i < 2 * SR; i++) data[i] *= 0.1
    const ordered = new AudioAnalyzer([data], SR)
    const ordered1 = ordered.frameAt(0.3).low
    const ordered2 = ordered.frameAt(1.5).low
    const reversed = new AudioAnalyzer([data], SR)
    const reversed2 = reversed.frameAt(1.5).low
    const reversed1 = reversed.frameAt(0.3).low
    assert.equal(ordered1, reversed1)
    assert.equal(ordered2, reversed2)
    assert.ok(ordered1 > ordered2)
})

test('times inside one tick share a frame', () => {
    const a = new AudioAnalyzer([tone(500, 1)], SR)
    const t = 10 / ANALYSIS_HZ
    assert.equal(a.frameAt(t), a.frameAt(t + 0.4 / ANALYSIS_HZ))
})

test('stereo downmixes to mono', () => {
    const left = tone(200, 1)
    const right = new Float32Array(left.length)
    for (let i = 0; i < left.length; i++) right[i] = -left[i]
    const f = new AudioAnalyzer([left, right], SR).frameAt(0.5)
    assert.equal(f.low, 0, 'opposite channels cancel like the analyser downmix')
})

test('applyFrame writes bands with sensitivity and clamps', () => {
    const state = { low: 0, mid: 0, high: 0, vol: 0, fft: new Float32Array(16), raw: 0 }
    const frame = { ...silentFrame(), low: 0.6, mid: 0.2, high: 0.1, vol: 0.3 }
    applyFrame(state, frame, 2)
    assert.equal(state.low, 1)
    assert.equal(state.mid, 0.4)
})
