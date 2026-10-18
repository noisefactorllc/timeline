/**
 * Tempo and first-beat detection for a song, so its beat grid can line up
 * with the music.
 *
 * An onset envelope (positive spectral flux of log magnitudes) is
 * autocorrelated over the lags of 70 to 180 BPM; each lag is scored
 * together with its double, under a gentle preference for tempos near
 * 125 BPM. The beat phase is the offset whose comb of beats collects the most
 * onset energy.
 */

const N = 1024
const HOP = 512

function makeFft(n) {
    const bits = Math.log2(n)
    const rev = new Uint32Array(n)
    for (let i = 0; i < n; i++) {
        let r = 0
        for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b)
        rev[i] = r
    }
    const cos = new Float64Array(n / 2)
    const sin = new Float64Array(n / 2)
    for (let i = 0; i < n / 2; i++) {
        cos[i] = Math.cos((2 * Math.PI * i) / n)
        sin[i] = -Math.sin((2 * Math.PI * i) / n)
    }
    return (re, im) => {
        for (let i = 0; i < n; i++) {
            const j = rev[i]
            if (j > i) {
                let t = re[i]; re[i] = re[j]; re[j] = t
                t = im[i]; im[i] = im[j]; im[j] = t
            }
        }
        for (let size = 2; size <= n; size <<= 1) {
            const half = size >> 1
            const step = n / size
            for (let s = 0; s < n; s += size) {
                for (let k = 0; k < half; k++) {
                    const wr = cos[k * step]
                    const wi = sin[k * step]
                    const a = s + k
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
}

/** Onset strength per hop, mean-removed and half-wave rectified. */
export function onsetEnvelope(channels, sampleRate, maxSeconds = 90) {
    const length = Math.min(channels[0].length, Math.floor(maxSeconds * sampleRate))
    const frames = Math.max(0, Math.floor((length - N) / HOP))
    const fft = makeFft(N)
    const re = new Float64Array(N)
    const im = new Float64Array(N)
    const win = new Float64Array(N)
    for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N)
    const bins = N / 2
    let prev = new Float64Array(bins)
    const env = new Float64Array(frames)
    for (let f = 0; f < frames; f++) {
        const off = f * HOP
        for (let i = 0; i < N; i++) {
            let v = channels[0][off + i]
            if (channels.length > 1) v = (v + channels[1][off + i]) * 0.5
            re[i] = v * win[i]
            im[i] = 0
        }
        fft(re, im)
        const cur = new Float64Array(bins)
        let flux = 0
        for (let k = 1; k < bins; k++) {
            cur[k] = Math.log1p(1000 * Math.hypot(re[k], im[k]))
            const d = cur[k] - prev[k]
            if (d > 0) flux += d
        }
        env[f] = flux
        prev = cur
    }
    // Remove the local mean (about half a second) and keep the rises.
    const rate = sampleRate / HOP
    const w = Math.max(1, Math.round(rate * 0.25))
    const out = new Float64Array(frames)
    let acc = 0
    const prefix = new Float64Array(frames + 1)
    for (let i = 0; i < frames; i++) {
        acc += env[i]
        prefix[i + 1] = acc
    }
    for (let i = 0; i < frames; i++) {
        const a = Math.max(0, i - w)
        const b = Math.min(frames, i + w + 1)
        const mean = (prefix[b] - prefix[a]) / (b - a)
        out[i] = Math.max(0, env[i] - mean)
    }
    return { envelope: out, rate }
}

function autocorr(env, lag) {
    let s = 0
    for (let i = 0; i + lag < env.length; i++) s += env[i] * env[i + lag]
    return s / Math.max(1, env.length - lag)
}

function interpolated(env, x) {
    const i = Math.floor(x)
    const f = x - i
    if (i < 0 || i + 1 >= env.length) return 0
    return env[i] * (1 - f) + env[i + 1] * f
}

/**
 * Detect tempo and the time of the first beat.
 * @returns {{bpm: number, offset: number, confidence: number}|null}
 */
export function detectTempo(channels, sampleRate, { minBpm = 70, maxBpm = 180 } = {}) {
    const { envelope, rate } = onsetEnvelope(channels, sampleRate)
    if (envelope.length < rate * 4) return null
    const minLag = Math.floor((60 * rate) / maxBpm)
    const maxLag = Math.ceil((60 * rate) / minBpm)
    const scores = new Float64Array(maxLag + 2)
    let best = -1
    let bestScore = 0
    let total = 0
    for (let lag = minLag; lag <= maxLag; lag++) {
        const bpm = (60 * rate) / lag
        const prior = Math.exp(-0.5 * Math.pow(Math.log2(bpm / 125) / 0.9, 2))
        const score = (autocorr(envelope, lag) + 0.5 * autocorr(envelope, lag * 2)) * prior
        scores[lag] = score
        total += score
        if (score > bestScore) {
            bestScore = score
            best = lag
        }
    }
    if (best < 0 || bestScore <= 0) return null
    // Parabolic refinement around the best lag.
    let lag = best
    if (best > minLag && best < maxLag) {
        const a = scores[best - 1]
        const b = scores[best]
        const c = scores[best + 1]
        const denom = a - 2 * b + c
        if (denom < 0) lag = best + 0.5 * (a - c) / denom
    }
    const coarse = (60 * rate) / lag
    // Refine: comb the whole envelope at nearby tempos; drift punishes a wrong one.
    const comb = bpm => {
        const period = (60 * rate) / bpm
        const steps = Math.max(8, Math.round(period * 2))
        let best = { energy: -1, phase: 0 }
        for (let s = 0; s < steps; s++) {
            const phase = (s / steps) * period
            let energy = 0
            let beats = 0
            for (let x = phase; x < envelope.length; x += period) {
                energy += interpolated(envelope, x)
                beats++
            }
            energy /= Math.max(1, beats)
            if (energy > best.energy) best = { energy, phase }
        }
        return best
    }
    let bpm = coarse
    let fit = comb(coarse)
    for (let candidate = coarse - 2; candidate <= coarse + 2; candidate += 0.05) {
        const c = comb(candidate)
        if (c.energy > fit.energy) {
            fit = c
            bpm = candidate
        }
    }
    if (Math.abs(bpm - Math.round(bpm)) < 0.2) bpm = Math.round(bpm)
    else bpm = Math.round(bpm * 10) / 10
    const { phase: bestPhase } = comb(bpm)
    const confidence = bestScore / (total / Math.max(1, maxLag - minLag + 1))
    // Onset frames start at the window's beginning; the hit sits mid-window.
    const offset = ((bestPhase + N / HOP / 2) / rate) % (60 / bpm)
    return { bpm, offset, confidence }
}
