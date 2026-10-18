/**
 * The demo soundtrack, synthesized in the browser so the demo project
 * needs no audio files. It renders deterministically through an
 * OfflineAudioContext as two stems: drums and music. Putting them on
 * separate audio tracks lets programs bind to the kick and to the harmony
 * independently with `audio(..., channel: N)`.
 *
 * 128 BPM, 32 bars, one minute, A minor: intro, build, drop, break, drop.
 */

export const DEMO_BPM = 128
export const DEMO_BARS = 32
export const DEMO_SAMPLE_RATE = 48000

const BEAT = 60 / DEMO_BPM
const BAR = BEAT * 4
const SIXTEENTH = BEAT / 4
export const DEMO_DURATION = DEMO_BARS * BAR

// Am, F, C, G as MIDI notes.
const CHORDS = [
    [57, 60, 64],
    [53, 57, 60],
    [48, 52, 55],
    [55, 59, 62],
]
const ROOTS = [45, 41, 48, 43]
const LEAD = [
    [76, 0, 2], [74, 2, 1], [72, 3, 1], [74, 4, 2], [72, 6, 1], [69, 7, 1],
    [72, 8, 3], [67, 11, 1], [69, 12, 4],
]

const midiHz = n => 440 * Math.pow(2, (n - 69) / 12)

function section(bar) {
    if (bar < 8) return 'intro'
    if (bar < 16) return 'build'
    if (bar < 24) return 'drop'
    if (bar < 28) return 'break'
    return 'drop2'
}

/** Seeded PRNG so the noise buffer is the same every render. */
function mulberry32(seed) {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

function noiseBuffer(ctx, seconds, seed) {
    const rand = mulberry32(seed)
    const buf = ctx.createBuffer(1, Math.ceil(seconds * ctx.sampleRate), ctx.sampleRate)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = rand() * 2 - 1
    return buf
}

function envGain(ctx, out, t, { attack = 0.002, peak = 1, decay = 0.2, curve = 'exp' } = {}) {
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(peak, t + attack)
    if (curve === 'exp') g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    else g.gain.linearRampToValueAtTime(0, t + attack + decay)
    g.connect(out)
    return g
}

function renderDrums(ctx, out, noise) {
    const kick = (t, level = 1) => {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(160, t)
        osc.frequency.exponentialRampToValueAtTime(44, t + 0.11)
        osc.connect(envGain(ctx, out, t, { attack: 0.001, peak: 0.95 * level, decay: 0.42 }))
        osc.start(t)
        osc.stop(t + 0.5)
        const click = ctx.createBufferSource()
        click.buffer = noise
        const hp = ctx.createBiquadFilter()
        hp.type = 'highpass'
        hp.frequency.value = 3000
        click.connect(hp).connect(envGain(ctx, out, t, { attack: 0.0005, peak: 0.25 * level, decay: 0.012 }))
        click.start(t, (t * 7.31) % 1, 0.03)
    }
    const clap = t => {
        const bp = ctx.createBiquadFilter()
        bp.type = 'bandpass'
        bp.frequency.value = 1400
        bp.Q.value = 0.9
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, t)
        for (const [dt, v] of [[0, 0.7], [0.011, 0.6], [0.022, 0.75]]) {
            g.gain.setValueAtTime(v, t + dt)
            g.gain.exponentialRampToValueAtTime(0.05, t + dt + 0.009)
        }
        g.gain.setValueAtTime(0.5, t + 0.03)
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
        const src = ctx.createBufferSource()
        src.buffer = noise
        src.connect(bp).connect(g).connect(out)
        src.start(t, (t * 3.17) % 1, 0.3)
    }
    const hat = (t, open = false, level = 1) => {
        const hp = ctx.createBiquadFilter()
        hp.type = 'highpass'
        hp.frequency.value = open ? 6500 : 8000
        const src = ctx.createBufferSource()
        src.buffer = noise
        src.connect(hp).connect(envGain(ctx, out, t, {
            attack: 0.001, peak: (open ? 0.22 : 0.16) * level, decay: open ? 0.2 : 0.045,
        }))
        src.start(t, (t * 5.71) % 1, open ? 0.3 : 0.08)
    }
    const crash = t => {
        const hp = ctx.createBiquadFilter()
        hp.type = 'highpass'
        hp.frequency.value = 4500
        const src = ctx.createBufferSource()
        src.buffer = noise
        src.connect(hp).connect(envGain(ctx, out, t, { attack: 0.002, peak: 0.3, decay: 1.8 }))
        src.start(t, 0.2, 2)
    }

    for (let bar = 0; bar < DEMO_BARS; bar++) {
        const s = section(bar)
        const t0 = bar * BAR
        const full = s === 'drop' || s === 'drop2'
        if (bar === 16 || bar === 28) crash(t0)
        for (let beat = 0; beat < 4; beat++) {
            const tb = t0 + beat * BEAT
            if (s === 'build' || full) kick(tb, bar === 15 && beat === 3 ? 0 : 1)
            if ((s === 'build' && bar >= 12) || full) {
                if (beat === 1 || beat === 3) clap(tb)
            }
            if (s !== 'intro' || bar >= 4) hat(tb + BEAT / 2, full, 1)
            if (full || s === 'build') {
                hat(tb + SIXTEENTH, false, 0.55)
                hat(tb + 3 * SIXTEENTH, false, 0.7)
            }
        }
        if (bar === 15 || bar === 27) {
            for (let i = 0; i < 8; i++) clap(t0 + 2 * BEAT + i * (BEAT / 4))
        }
    }
}

function renderMusic(ctx, out, noise) {
    const bus = ctx.createGain()
    bus.gain.value = 0.9
    bus.connect(out)

    // Arp delay: dotted eighth with feedback.
    const delay = ctx.createDelay(2)
    delay.delayTime.value = BEAT * 0.75
    const feedback = ctx.createGain()
    feedback.gain.value = 0.38
    const wet = ctx.createGain()
    wet.gain.value = 0.35
    delay.connect(feedback).connect(delay)
    delay.connect(wet).connect(bus)

    const pad = (t, notes, len, level) => {
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 1600
        lp.Q.value = 0.4
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, t)
        g.gain.linearRampToValueAtTime(level, t + 0.6)
        g.gain.setValueAtTime(level, t + len - 0.4)
        g.gain.linearRampToValueAtTime(0.0001, t + len + 0.3)
        lp.connect(g).connect(bus)
        notes.forEach((n, i) => {
            for (const detune of [-9, 0, 9]) {
                const osc = ctx.createOscillator()
                osc.type = 'sawtooth'
                osc.frequency.value = midiHz(n)
                osc.detune.value = detune
                const pan = ctx.createStereoPanner()
                pan.pan.value = ((i - 1) * 0.4 + detune / 30)
                const v = ctx.createGain()
                v.gain.value = 0.05
                osc.connect(v).connect(pan).connect(lp)
                osc.start(t)
                osc.stop(t + len + 0.4)
            }
        })
    }
    const bass = (t, note, len) => {
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.Q.value = 6
        lp.frequency.setValueAtTime(220, t)
        lp.frequency.exponentialRampToValueAtTime(1100, t + 0.02)
        lp.frequency.exponentialRampToValueAtTime(240, t + len)
        lp.connect(envGain(ctx, bus, t, { attack: 0.004, peak: 0.42, decay: len }))
        for (const [type, mult, level] of [['sawtooth', 1, 0.7], ['square', 0.5, 0.5]]) {
            const osc = ctx.createOscillator()
            osc.type = type
            osc.frequency.value = midiHz(note) * mult
            const v = ctx.createGain()
            v.gain.value = level
            osc.connect(v).connect(lp)
            osc.start(t)
            osc.stop(t + len + 0.05)
        }
    }
    const pluck = (t, note, level, cutoff) => {
        const osc = ctx.createOscillator()
        osc.type = 'square'
        osc.frequency.value = midiHz(note)
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.setValueAtTime(cutoff, t)
        lp.frequency.exponentialRampToValueAtTime(300, t + 0.18)
        const g = envGain(ctx, bus, t, { attack: 0.002, peak: level, decay: 0.2 })
        g.connect(delay)
        osc.connect(lp).connect(g)
        osc.start(t)
        osc.stop(t + 0.25)
    }
    const lead = (t, note, len) => {
        const osc = ctx.createOscillator()
        osc.type = 'sawtooth'
        osc.frequency.value = midiHz(note)
        const vib = ctx.createOscillator()
        vib.frequency.value = 5.5
        const vibAmt = ctx.createGain()
        vibAmt.gain.setValueAtTime(0, t)
        vibAmt.gain.linearRampToValueAtTime(9, t + Math.min(len, 0.5))
        vib.connect(vibAmt).connect(osc.detune)
        const lp = ctx.createBiquadFilter()
        lp.type = 'lowpass'
        lp.frequency.value = 2600
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, t)
        g.gain.linearRampToValueAtTime(0.13, t + 0.02)
        g.gain.setValueAtTime(0.11, t + len * 0.8)
        g.gain.linearRampToValueAtTime(0.0001, t + len)
        osc.connect(lp).connect(g).connect(bus)
        g.connect(delay)
        osc.start(t)
        vib.start(t)
        osc.stop(t + len + 0.05)
        vib.stop(t + len + 0.05)
    }
    const riser = (t, len) => {
        const bp = ctx.createBiquadFilter()
        bp.type = 'bandpass'
        bp.Q.value = 2
        bp.frequency.setValueAtTime(300, t)
        bp.frequency.exponentialRampToValueAtTime(7000, t + len)
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(0.35, t + len)
        g.gain.linearRampToValueAtTime(0, t + len + 0.02)
        const src = ctx.createBufferSource()
        src.buffer = noise
        src.loop = true
        src.connect(bp).connect(g).connect(bus)
        src.start(t)
        src.stop(t + len + 0.05)
    }

    for (let bar = 0; bar < DEMO_BARS; bar++) {
        const s = section(bar)
        const t0 = bar * BAR
        const chord = CHORDS[bar % 4]
        const root = ROOTS[bar % 4]
        const full = s === 'drop' || s === 'drop2'
        if (s !== 'drop2' || bar < 31) pad(t0, chord, BAR, s === 'break' ? 0.9 : full ? 0.55 : 0.75)
        if (s === 'build' || full) {
            for (let e = 0; e < 8; e++) {
                if (e % 2 === 0 && !full) continue
                bass(t0 + e * (BEAT / 2) + (e % 2 === 0 ? 0 : 0), root - 12, BEAT / 2 * 0.85)
            }
        }
        if (s !== 'intro' || bar >= 2) {
            const opening = s === 'intro' ? 500 + bar * 250 : s === 'break' ? 1800 : 3200
            const tones = [...chord, chord[0] + 12, chord[1] + 12, chord[2] + 12]
            for (let i = 0; i < 16; i++) {
                if (s === 'intro' && i % 2 === 1) continue
                const n = tones[(i * 5 + bar) % tones.length] + 12
                pluck(t0 + i * SIXTEENTH, n, full ? 0.07 : 0.09, opening)
            }
        }
        if (full) {
            const phraseBar = (bar - (s === 'drop' ? 16 : 28)) % 4
            for (const [note, at, len] of LEAD) {
                const beat = at
                if (Math.floor(beat / 4) !== phraseBar % 4) continue
                lead(t0 + (beat % 4) * BEAT, note, len * BEAT * 0.95)
            }
        }
        if (bar === 15 || bar === 27) riser(t0, BAR)
    }
}

async function renderStem(build, seconds) {
    const ctx = new OfflineAudioContext({
        numberOfChannels: 2,
        length: Math.ceil(seconds * DEMO_SAMPLE_RATE),
        sampleRate: DEMO_SAMPLE_RATE,
    })
    const comp = ctx.createDynamicsCompressor()
    comp.threshold.value = -10
    comp.ratio.value = 3
    comp.attack.value = 0.005
    comp.release.value = 0.12
    const master = ctx.createGain()
    master.gain.value = 0.85
    master.connect(comp).connect(ctx.destination)
    build(ctx, master, noiseBuffer(ctx, 2, 0x5eed))
    return ctx.startRendering()
}

/** Render the demo stems. Resolves to { drums, music } AudioBuffers. */
export async function renderDemoStems() {
    const [drums, music] = await Promise.all([
        renderStem(renderDrums, DEMO_DURATION),
        renderStem(renderMusic, DEMO_DURATION),
    ])
    return { drums, music }
}
