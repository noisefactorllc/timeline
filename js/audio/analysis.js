/**
 * Deterministic audio analysis for `audio()` bindings.
 *
 * Live apps feed the engine from a Web Audio AnalyserNode, which smooths
 * over however many animation frames happened to run. A timeline must give
 * the same values when it plays, scrubs or exports, so this reproduces the
 * AnalyserNode algorithm offline as a pure function of time: a Blackman
 * window over the 256 samples before each 60 Hz tick, magnitude, the
 * analyser's exponential smoothing unrolled over earlier ticks, decibel to
 * byte mapping, then the engine's band math (AudioState.updateFromAnalyser)
 * with its rolling average. Settings match Noisedeck's live analyser.
 */

export const FFT_SIZE = 256
export const BINS = FFT_SIZE / 2
export const ANALYSIS_HZ = 60
const SMOOTHING = 0.5
const MIN_DB = -80
const MAX_DB = -30
const ROLLING = 3
const HISTORY = 12

const WINDOW = new Float32Array(FFT_SIZE)
for (let n = 0; n < FFT_SIZE; n++) {
    WINDOW[n] = 0.42 - 0.5 * Math.cos((2 * Math.PI * n) / FFT_SIZE) + 0.08 * Math.cos((4 * Math.PI * n) / FFT_SIZE)
}

// Radix-2 FFT tables for N = 256.
const LOG2N = Math.log2(FFT_SIZE)
const BITREV = new Uint16Array(FFT_SIZE)
for (let i = 0; i < FFT_SIZE; i++) {
    let r = 0
    for (let b = 0; b < LOG2N; b++) r |= ((i >> b) & 1) << (LOG2N - 1 - b)
    BITREV[i] = r
}
const COS = new Float64Array(FFT_SIZE / 2)
const SIN = new Float64Array(FFT_SIZE / 2)
for (let i = 0; i < FFT_SIZE / 2; i++) {
    COS[i] = Math.cos((2 * Math.PI * i) / FFT_SIZE)
    SIN[i] = -Math.sin((2 * Math.PI * i) / FFT_SIZE)
}

const re = new Float64Array(FFT_SIZE)
const im = new Float64Array(FFT_SIZE)

/** In-place FFT of the module scratch buffers. */
function fft() {
    for (let i = 0; i < FFT_SIZE; i++) {
        const j = BITREV[i]
        if (j > i) {
            const tr = re[i]; re[i] = re[j]; re[j] = tr
            const ti = im[i]; im[i] = im[j]; im[j] = ti
        }
    }
    for (let size = 2; size <= FFT_SIZE; size <<= 1) {
        const half = size >> 1
        const step = FFT_SIZE / size
        for (let start = 0; start < FFT_SIZE; start += size) {
            for (let k = 0; k < half; k++) {
                const wr = COS[k * step]
                const wi = SIN[k * step]
                const a = start + k
                const b = a + half
                const xr = re[b] * wr - im[b] * wi
                const xi = re[b] * wi + im[b] * wr
                re[b] = re[a] - xr
                im[b] = im[a] - xi
                re[a] += xr
                im[a] += xi
            }
        }
    }
}

function avgBytes(buf, from, to) {
    const end = Math.min(to, buf.length)
    let sum = 0
    for (let i = from; i < end; i++) sum += buf[i]
    return sum / (end - from) / 255
}

/** A silent analysis frame. */
export function silentFrame() {
    const waveform = new Uint8Array(FFT_SIZE)
    waveform.fill(128)
    return {
        low: 0, mid: 0, high: 0, vol: 0, raw: 0,
        fft: new Float32Array(16),
        spectrum: new Uint8Array(BINS),
        waveform,
    }
}

export class AudioAnalyzer {
    /**
     * @param {Float32Array[]} channels - PCM channels (1 or 2)
     * @param {number} sampleRate
     */
    constructor(channels, sampleRate) {
        this.channels = channels
        this.sampleRate = sampleRate
        this.length = channels[0]?.length || 0
        this._raw = new Map()
        this._bytes = new Map()
        this._frames = new Map()
    }

    _sample(i) {
        if (i < 0 || i >= this.length) return 0
        const ch = this.channels
        return ch.length > 1 ? (ch[0][i] + ch[1][i]) * 0.5 : ch[0][i]
    }

    _endSample(tick) {
        return Math.round((tick / ANALYSIS_HZ) * this.sampleRate)
    }

    _remember(map, key, value, limit = 720) {
        map.set(key, value)
        if (map.size > limit) map.delete(map.keys().next().value)
        return value
    }

    /** |X[k]| / N for the window ending at a tick. */
    rawMagnitudes(tick) {
        const hit = this._raw.get(tick)
        if (hit) return hit
        const end = this._endSample(tick)
        const start = end - FFT_SIZE
        for (let n = 0; n < FFT_SIZE; n++) {
            re[n] = this._sample(start + n) * WINDOW[n]
            im[n] = 0
        }
        fft()
        const mags = new Float32Array(BINS)
        for (let k = 0; k < BINS; k++) mags[k] = Math.hypot(re[k], im[k]) / FFT_SIZE
        return this._remember(this._raw, tick, mags)
    }

    /** getByteFrequencyData at a tick, with the analyser's smoothing unrolled. */
    frequencyBytes(tick) {
        const hit = this._bytes.get(tick)
        if (hit) return hit
        const smoothed = new Float64Array(BINS)
        let weight = 1 - SMOOTHING
        for (let j = 0; j <= HISTORY; j++) {
            const t = tick - j
            if (this._endSample(t) <= 0) break
            const mags = this.rawMagnitudes(t)
            for (let k = 0; k < BINS; k++) smoothed[k] += weight * mags[k]
            weight *= SMOOTHING
        }
        const bytes = new Uint8Array(BINS)
        const scale = 255 / (MAX_DB - MIN_DB)
        for (let k = 0; k < BINS; k++) {
            const v = smoothed[k]
            if (!(v > 0)) continue
            const db = 20 * Math.log10(v)
            bytes[k] = Math.max(0, Math.min(255, Math.floor(scale * (db - MIN_DB))))
        }
        return this._remember(this._bytes, tick, bytes)
    }

    _bands(tick) {
        const buf = this.frequencyBytes(tick)
        return { low: avgBytes(buf, 1, 2), mid: avgBytes(buf, 2, 12), high: avgBytes(buf, 12, 47) }
    }

    /** Analysis at time `t` (seconds), quantized to the 60 Hz tick grid. */
    frameAt(t) {
        const tick = Math.floor(t * ANALYSIS_HZ + 1e-9)
        const hit = this._frames.get(tick)
        if (hit) return hit
        const buf = this.frequencyBytes(tick)
        let low = 0
        let mid = 0
        let high = 0
        let count = 0
        for (let j = 0; j < ROLLING; j++) {
            const b = this._bands(tick - j)
            low += b.low
            mid += b.mid
            high += b.high
            count++
        }
        const fftBins = new Float32Array(16)
        const step = Math.max(1, Math.floor(BINS / 16))
        let sum = 0
        for (let i = 0; i < 16; i++) {
            fftBins[i] = buf[i * step] / 255
            sum += fftBins[i]
        }
        const end = this._endSample(tick)
        const waveform = new Uint8Array(FFT_SIZE)
        for (let n = 0; n < FFT_SIZE; n++) {
            const x = this._sample(end - FFT_SIZE + n)
            waveform[n] = Math.max(0, Math.min(255, Math.floor(128 * (1 + x))))
        }
        let rawSum = 0
        for (let n = 0; n < 128; n++) rawSum += this._sample(end - 128 + n)
        const frame = {
            low: low / count,
            mid: mid / count,
            high: high / count,
            vol: sum / 16,
            raw: Math.max(-1, Math.min(1, rawSum / 128)),
            fft: fftBins,
            spectrum: buf,
            waveform,
        }
        return this._remember(this._frames, tick, frame, 240)
    }
}

/**
 * Write an analysis frame into an engine AudioState (or one of its channel
 * states), applying the sequence's sensitivity like Noisedeck does.
 */
export function applyFrame(state, frame, sensitivity = 1) {
    if (!state) return
    const s = sensitivity
    state.low = Math.min(1, frame.low * s)
    state.mid = Math.min(1, frame.mid * s)
    state.high = Math.min(1, frame.high * s)
    state.vol = Math.min(1, frame.vol * s)
    if (state.fft) state.fft.set(frame.fft)
    state.setSpectrum?.(frame.spectrum)
    state.setWaveform?.(frame.waveform)
    state.setRaw?.(frame.raw)
}
