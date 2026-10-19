/**
 * The demo soundtrack, synthesized in the browser so the demo project
 * needs no audio files. It renders deterministically through an
 * OfflineAudioContext as two stems: drums and synths. Putting them on
 * separate audio tracks lets programs bind to the kick and to the synths
 * independently with `audio(..., channel: N)`.
 *
 * Dark industrial techno at 128 BPM, 32 bars, one minute, in E Phrygian:
 * intro, build, drop, break, drop. A driven kick, a rumble rolling on the offbeats, metal
 * percussion, a drone, an acid line through a dub delay and a phased pad.
 */

export const DEMO_ID = 'refinery'
export const DEMO_BPM = 128
export const DEMO_BARS = 32
export const DEMO_SAMPLE_RATE = 48000

const BEAT = 60 / DEMO_BPM
const BAR = BEAT * 4
const SIXTEENTH = BEAT / 4
export const DEMO_DURATION = DEMO_BARS * BAR

// E minor, E minor, F, D minor: the flat second over an E drone.
const CHORDS = [
    [52, 55, 59],
    [52, 55, 59],
    [53, 57, 60],
    [50, 53, 57],
]
const STAB = [52, 55, 59, 62]

// One bar of acid: [note, accent, slide] per sixteenth, null for a rest.
const ACID_A = [
    [40, 1, 0], [40, 0, 0], [52, 0, 0], [40, 0, 1],
    [41, 1, 0], [40, 0, 0], null, [43, 0, 1],
    [40, 1, 0], [52, 0, 0], [40, 0, 0], [50, 0, 1],
    [41, 0, 0], [40, 1, 0], [46, 0, 1], [40, 0, 0],
]
const ACID_B = [
    [40, 1, 0], [40, 0, 0], [52, 0, 1], [53, 0, 0],
    [40, 1, 0], null, [43, 0, 0], [40, 0, 1],
    [46, 1, 0], [40, 0, 0], [52, 0, 0], [40, 0, 0],
    [41, 1, 1], [43, 0, 0], [40, 0, 0], [55, 1, 0],
]

const midiHz = n => 440 * Math.pow(2, (n - 69) / 12)

function section(bar) {
    if (bar < 8) return 'intro'
    if (bar < 16) return 'build'
    if (bar < 24) return 'drop'
    if (bar < 28) return 'break'
    return 'drop2'
}

/** Seeded PRNG so noise and reverbs are the same every render. */
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

/** Square waves at inharmonic ratios: the metal in hats and clanks. */
function metalBuffer(ctx, seconds, freqs) {
    const sr = ctx.sampleRate
    const buf = ctx.createBuffer(1, Math.ceil(seconds * sr), sr)
    const data = buf.getChannelData(0)
    for (let i = 0; i < data.length; i++) {
        let s = 0
        for (const f of freqs) s += (i * f / sr) % 1 < 0.5 ? 1 : -1
        data[i] = s / freqs.length
    }
    return buf
}

/** A stereo reverb tail: darkened noise under a power-law decay. */
function impulse(ctx, seconds, decay, seed) {
    const rand = mulberry32(seed)
    const n = Math.ceil(seconds * ctx.sampleRate)
    const buf = ctx.createBuffer(2, n, ctx.sampleRate)
    for (let c = 0; c < 2; c++) {
        const data = buf.getChannelData(c)
        let lp = 0
        for (let i = 0; i < n; i++) {
            lp += 0.3 * (rand() * 2 - 1 - lp)
            data[i] = lp * Math.pow(1 - i / n, decay)
        }
    }
    return buf
}

function reverb(ctx, buffer, level, dest) {
    const conv = ctx.createConvolver()
    conv.buffer = buffer
    const g = ctx.createGain()
    g.gain.value = level
    conv.connect(g).connect(dest)
    return conv
}

/** tanh saturation, normalized so full scale stays full scale. */
function shaper(ctx, drive) {
    const ws = ctx.createWaveShaper()
    const n = 2048
    const curve = new Float32Array(n)
    const norm = Math.tanh(drive)
    for (let i = 0; i < n; i++) curve[i] = Math.tanh(drive * ((i / (n - 1)) * 2 - 1)) / norm
    ws.curve = curve
    ws.oversample = '4x'
    return ws
}

function filter(ctx, type, frequency, Q) {
    const f = ctx.createBiquadFilter()
    f.type = type
    f.frequency.value = frequency
    if (Q !== undefined) f.Q.value = Q
    return f
}

function envGain(ctx, dest, t, { attack = 0.002, peak = 1, decay = 0.2 } = {}) {
    const g = ctx.createGain()
    g.gain.setValueAtTime(0.0001, t)
    g.gain.linearRampToValueAtTime(peak, t + attack)
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay)
    g.connect(dest)
    return g
}

function renderDrums(ctx, out, noise) {
    const hatMetal = metalBuffer(ctx, 1, [205.3, 304.4, 369.6, 522.7, 540, 800])
    const clankMetal = metalBuffer(ctx, 1, [311, 417.4, 553.9, 741.2])
    const room = reverb(ctx, impulse(ctx, 2.2, 4, 0xd00d), 0.45, out)

    // The kick runs through one saturator. Its tail dies before the next
    // beat, so the low band of this stem is the kick and nothing else.
    const kickBus = ctx.createGain()
    kickBus.connect(shaper(ctx, 2.2)).connect(filter(ctx, 'lowpass', 5200)).connect(out)

    const kick = (t, level = 1) => {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(190, t)
        osc.frequency.exponentialRampToValueAtTime(52, t + 0.07)
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.4)
        osc.connect(envGain(ctx, kickBus, t, { attack: 0.001, peak: 0.62 * level, decay: 0.36 }))
        osc.start(t)
        osc.stop(t + 0.45)
        const click = ctx.createBufferSource()
        click.buffer = noise
        click.connect(filter(ctx, 'highpass', 2500))
            .connect(envGain(ctx, kickBus, t, { attack: 0.0005, peak: 0.22 * level, decay: 0.01 }))
        click.start(t, (t * 7.31) % 1, 0.03)
    }

    // The clank takes the snare's place on two and four.
    const clankBus = ctx.createGain()
    clankBus.connect(shaper(ctx, 3.5))
        .connect(filter(ctx, 'highpass', 500))
        .connect(filter(ctx, 'highpass', 500))
        .connect(out)
    clankBus.connect(room)
    const clank = (t, level = 1) => {
        const metal = ctx.createBufferSource()
        metal.buffer = clankMetal
        metal.connect(filter(ctx, 'bandpass', 1800, 1.2))
            .connect(envGain(ctx, clankBus, t, { attack: 0.001, peak: 0.2 * level, decay: 0.16 }))
        metal.start(t, (t * 1.37) % 0.5, 0.25)
        const hiss = ctx.createBufferSource()
        hiss.buffer = noise
        hiss.connect(filter(ctx, 'bandpass', 1100, 0.8))
            .connect(envGain(ctx, clankBus, t, { attack: 0.001, peak: 0.24 * level, decay: 0.12 }))
        hiss.start(t, (t * 3.17) % 1, 0.2)
    }

    const hatHp = filter(ctx, 'highpass', 7000)
    hatHp.connect(out)
    const hat = (t, open = false, level = 1, pan = 0) => {
        const p = ctx.createStereoPanner()
        p.pan.value = pan
        p.connect(hatHp)
        const env = { attack: 0.001, peak: (open ? 0.2 : 0.15) * level, decay: open ? 0.18 : 0.035 }
        const metal = ctx.createBufferSource()
        metal.buffer = hatMetal
        metal.connect(envGain(ctx, p, t, env))
        metal.start(t, (t * 2.11) % 0.5, open ? 0.25 : 0.06)
        const hiss = ctx.createBufferSource()
        hiss.buffer = noise
        hiss.connect(envGain(ctx, p, t, { ...env, peak: env.peak * 0.5 }))
        hiss.start(t, (t * 5.71) % 1, open ? 0.25 : 0.06)
    }

    // Pitched-down metal pings bounce around the room in the drops.
    const ping = (t, pan) => {
        const p = ctx.createStereoPanner()
        p.pan.value = pan
        p.connect(out)
        p.connect(room)
        const metal = ctx.createBufferSource()
        metal.buffer = clankMetal
        metal.playbackRate.value = 2.4
        metal.connect(filter(ctx, 'bandpass', 2600, 4))
            .connect(envGain(ctx, p, t, { attack: 0.001, peak: 0.22, decay: 0.09 }))
        metal.start(t, 0.1, 0.12)
    }

    // A boom and a falling wash of noise open each drop.
    const impact = t => {
        const boom = ctx.createOscillator()
        boom.type = 'sine'
        boom.frequency.setValueAtTime(70, t)
        boom.frequency.exponentialRampToValueAtTime(32, t + 1.2)
        boom.connect(envGain(ctx, out, t, { attack: 0.002, peak: 0.34, decay: 1.4 }))
        boom.start(t)
        boom.stop(t + 1.5)
        const lp = filter(ctx, 'lowpass', 9000, 1)
        lp.frequency.setValueAtTime(9000, t)
        lp.frequency.exponentialRampToValueAtTime(150, t + 1.6)
        const wash = ctx.createBufferSource()
        wash.buffer = noise
        wash.loop = true
        const g = envGain(ctx, out, t, { attack: 0.003, peak: 0.26, decay: 1.8 })
        g.connect(room)
        wash.connect(lp).connect(g)
        wash.start(t)
        wash.stop(t + 1.9)
    }

    const ACCENT = [1, 0.45, 0.7, 0.5]
    const PINGS = [3, 6, 11, 14]
    for (let bar = 0; bar < DEMO_BARS; bar++) {
        const s = section(bar)
        const t0 = bar * BAR
        const full = s === 'drop' || s === 'drop2'
        if (bar === 16 || bar === 28) impact(t0)
        for (let beat = 0; beat < 4; beat++) {
            const tb = t0 + beat * BEAT
            const gap = bar === 15 && beat >= 2
            if ((s === 'build' || full) && !gap) kick(tb)
            if (((s === 'build' && bar >= 12) || full) && (beat === 1 || beat === 3) && !gap) clank(tb)
            if (s === 'intro' && bar >= 4) hat(tb + BEAT / 2, false, 0.6)
            if (s === 'break') hat(tb + BEAT / 2, true, 0.45, 0.3)
            if (s === 'build' || full) {
                for (let i = 0; i < 4; i++) {
                    const open = i === 2 && (full || bar >= 12)
                    hat(tb + i * SIXTEENTH, open, open ? 1 : ACCENT[i], (i - 1.5) * 0.15)
                }
            }
        }
        if (full) PINGS.forEach((step, i) => ping(t0 + step * SIXTEENTH, i % 2 ? 0.7 : -0.7))
        if (bar === 15 || bar === 27) {
            for (let i = 0; i < 8; i++) clank(t0 + 2 * BEAT + i * SIXTEENTH, 0.3 + i * 0.1)
        }
    }
}

function renderSynths(ctx, out, noise) {
    const bus = ctx.createGain()
    bus.gain.value = 0.7
    bus.connect(out)
    const hall = reverb(ctx, impulse(ctx, 3.5, 3, 0x51ab), 0.4, bus)

    // Dub delay: dotted eighths bouncing left and right, darker each pass.
    const dubIn = ctx.createGain()
    const dubOut = ctx.createGain()
    dubOut.gain.value = 0.5
    dubOut.connect(bus)
    dubOut.connect(hall)
    const left = ctx.createDelay(2)
    const right = ctx.createDelay(2)
    left.delayTime.value = BEAT * 0.75
    right.delayTime.value = BEAT * 0.75
    const panL = ctx.createStereoPanner()
    const panR = ctx.createStereoPanner()
    panL.pan.value = -0.7
    panR.pan.value = 0.7
    const fbL = ctx.createGain()
    const fbR = ctx.createGain()
    fbL.gain.value = 0.55
    fbR.gain.value = 0.55
    dubIn.connect(left)
    left.connect(panL).connect(dubOut)
    right.connect(panR).connect(dubOut)
    left.connect(filter(ctx, 'lowpass', 2400)).connect(filter(ctx, 'highpass', 240)).connect(fbL).connect(right)
    right.connect(filter(ctx, 'lowpass', 2400)).connect(filter(ctx, 'highpass', 240)).connect(fbR).connect(left)

    // Drone: a sub on E1 under driven, detuned saws, opening through the intro.
    const droneLp = filter(ctx, 'lowpass', 120, 2)
    const droneGain = ctx.createGain()
    droneLp.connect(shaper(ctx, 1.6)).connect(droneGain).connect(bus)
    for (const [note, detune, level, type] of [
        [28, 0, 0.5, 'sine'], [40, -7, 0.22, 'sawtooth'], [40, 7, 0.22, 'sawtooth'],
        [47, -4, 0.12, 'sawtooth'], [52, 3, 0.08, 'sawtooth'],
    ]) {
        const osc = ctx.createOscillator()
        osc.type = type
        osc.frequency.value = midiHz(note)
        osc.detune.value = detune
        const g = ctx.createGain()
        g.gain.value = level
        osc.connect(g).connect(droneLp)
        osc.start(0)
        osc.stop(DEMO_DURATION)
    }
    const df = droneLp.frequency
    df.setValueAtTime(120, 0)
    df.exponentialRampToValueAtTime(700, 8 * BAR)
    df.exponentialRampToValueAtTime(1100, 16 * BAR)
    df.setValueAtTime(480, 16 * BAR)
    df.setValueAtTime(480, 24 * BAR)
    df.exponentialRampToValueAtTime(1400, 28 * BAR)
    df.setValueAtTime(480, 28 * BAR)
    const dg = droneGain.gain
    dg.setValueAtTime(0, 0)
    dg.linearRampToValueAtTime(0.25, 2 * BAR)
    dg.setValueAtTime(0.25, 8 * BAR)
    dg.linearRampToValueAtTime(0.5, 12 * BAR)
    dg.setValueAtTime(0.5, 16 * BAR)
    dg.linearRampToValueAtTime(0.32, 16 * BAR + 0.05)
    dg.setValueAtTime(0.32, 24 * BAR)
    dg.linearRampToValueAtTime(0.6, 24 * BAR + BAR)
    dg.setValueAtTime(0.6, 28 * BAR)
    dg.linearRampToValueAtTime(0.32, 28 * BAR + 0.05)

    // Pad through a four-stage phaser that sweeps slowly, panned by a slower LFO.
    const padIn = ctx.createGain()
    const padOut = ctx.createStereoPanner()
    padOut.connect(bus)
    padOut.connect(hall)
    const dry = ctx.createGain()
    dry.gain.value = 0.6
    padIn.connect(dry).connect(padOut)
    const sweep = ctx.createOscillator()
    sweep.frequency.value = 0.11
    const depth = ctx.createGain()
    depth.gain.value = 520
    sweep.connect(depth)
    let stage = padIn
    for (let i = 0; i < 4; i++) {
        const ap = filter(ctx, 'allpass', 700 + i * 160, 0.7)
        depth.connect(ap.frequency)
        stage.connect(ap)
        stage = ap
    }
    const wet = ctx.createGain()
    wet.gain.value = 0.6
    stage.connect(wet).connect(padOut)
    const drift = ctx.createOscillator()
    drift.frequency.value = 0.07
    const driftDepth = ctx.createGain()
    driftDepth.gain.value = 0.45
    drift.connect(driftDepth).connect(padOut.pan)
    sweep.start(0)
    drift.start(0)
    sweep.stop(DEMO_DURATION)
    drift.stop(DEMO_DURATION)

    const pad = (t, notes, len, level, cutoff) => {
        const lp = filter(ctx, 'lowpass', cutoff, 0.4)
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, t)
        g.gain.linearRampToValueAtTime(level, t + 0.25)
        g.gain.setValueAtTime(level, t + len - 0.1)
        g.gain.linearRampToValueAtTime(0.0001, t + len + 0.4)
        lp.connect(g).connect(padIn)
        notes.forEach((n, i) => {
            for (const detune of [-11, 0, 11]) {
                const osc = ctx.createOscillator()
                osc.type = 'sawtooth'
                osc.frequency.value = midiHz(n)
                osc.detune.value = detune
                const pan = ctx.createStereoPanner()
                pan.pan.value = (i - 1) * 0.4 + detune / 40
                const v = ctx.createGain()
                v.gain.value = 0.045
                osc.connect(v).connect(pan).connect(lp)
                osc.start(t)
                osc.stop(t + len + 0.45)
            }
        })
    }

    // Acid: one monophonic voice, a resonant low pass with an envelope per
    // note, glides on slides, driven, and sent to the dub delay.
    const acidOsc = ctx.createOscillator()
    acidOsc.type = 'sawtooth'
    const acidLp = filter(ctx, 'lowpass', 200, 16)
    const acidAmp = ctx.createGain()
    const acidOut = ctx.createGain()
    acidOut.gain.value = 0.2
    const acidSend = ctx.createGain()
    acidSend.gain.value = 0.45
    acidOsc.connect(acidLp).connect(acidAmp).connect(shaper(ctx, 2.8)).connect(acidOut).connect(bus)
    acidOut.connect(acidSend).connect(dubIn)
    acidAmp.gain.setValueAtTime(0, 0)
    acidOsc.start(0)
    acidOsc.stop(DEMO_DURATION)
    let gliding = false
    let lastHz = midiHz(40)
    const acidStep = (t, step, cutoff, level) => {
        if (!step) {
            gliding = false
            return
        }
        const [note, accent, slide] = step
        const hz = midiHz(note)
        if (gliding) {
            acidOsc.frequency.setValueAtTime(lastHz, t)
            acidOsc.frequency.exponentialRampToValueAtTime(hz, t + 0.045)
        } else {
            acidOsc.frequency.setValueAtTime(hz, t)
            acidLp.frequency.setValueAtTime(Math.min(9000, cutoff * (accent ? 5 : 3.2)), t)
            acidLp.frequency.exponentialRampToValueAtTime(cutoff, t + (accent ? 0.16 : 0.11))
            acidAmp.gain.setValueAtTime(0, t)
            acidAmp.gain.linearRampToValueAtTime(level * (accent ? 1 : 0.7), t + 0.003)
        }
        if (!slide) {
            const off = t + SIXTEENTH * 0.55
            acidAmp.gain.setValueAtTime(level * (accent ? 1 : 0.7), off)
            acidAmp.gain.linearRampToValueAtTime(0, off + 0.008)
        }
        gliding = !!slide
        lastHz = hz
    }

    // Rumble: a ghost of the kick through a dark reverb, driven, low passed
    // and ducked on every beat so it rolls on the offbeats.
    const rumbleVerb = ctx.createConvolver()
    rumbleVerb.buffer = impulse(ctx, 1.4, 2.5, 0xbeef)
    const rumbleDuck = ctx.createGain()
    rumbleDuck.gain.setValueAtTime(0, 0)
    rumbleVerb.connect(shaper(ctx, 3))
        .connect(filter(ctx, 'lowpass', 120))
        .connect(filter(ctx, 'lowpass', 120))
        .connect(rumbleDuck)
        .connect(bus)
    const rumble = t => {
        const osc = ctx.createOscillator()
        osc.type = 'sine'
        osc.frequency.setValueAtTime(190, t)
        osc.frequency.exponentialRampToValueAtTime(52, t + 0.07)
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.4)
        osc.connect(envGain(ctx, rumbleVerb, t, { attack: 0.001, peak: 0.6, decay: 0.36 }))
        osc.start(t)
        osc.stop(t + 0.45)
        rumbleDuck.gain.setValueAtTime(0, t)
        rumbleDuck.gain.linearRampToValueAtTime(0.5, t + BEAT * 0.5)
        rumbleDuck.gain.linearRampToValueAtTime(0, t + BEAT * 0.98)
    }

    const stab = (t, level) => {
        const bp = filter(ctx, 'bandpass', 1200, 1)
        const g = envGain(ctx, dubIn, t, { attack: 0.002, peak: level, decay: 0.14 })
        g.connect(bus)
        bp.connect(g)
        for (const n of STAB) {
            const osc = ctx.createOscillator()
            osc.type = 'sawtooth'
            osc.frequency.value = midiHz(n)
            osc.connect(bp)
            osc.start(t)
            osc.stop(t + 0.2)
        }
    }

    // Before each drop: noise rising through a band pass and a siren
    // climbing three octaves, cut dead on the downbeat.
    const riser = (t, len) => {
        const bp = filter(ctx, 'bandpass', 300, 2)
        bp.frequency.setValueAtTime(300, t)
        bp.frequency.exponentialRampToValueAtTime(8000, t + len)
        const g = ctx.createGain()
        g.gain.setValueAtTime(0.0001, t)
        g.gain.exponentialRampToValueAtTime(0.28, t + len)
        g.gain.linearRampToValueAtTime(0, t + len + 0.01)
        const src = ctx.createBufferSource()
        src.buffer = noise
        src.loop = true
        src.connect(bp).connect(g).connect(bus)
        src.start(t)
        src.stop(t + len + 0.02)
        const siren = ctx.createOscillator()
        siren.type = 'sawtooth'
        siren.frequency.setValueAtTime(midiHz(40), t)
        siren.frequency.exponentialRampToValueAtTime(midiHz(76), t + len)
        const lp = filter(ctx, 'lowpass', 400, 4)
        lp.frequency.setValueAtTime(400, t)
        lp.frequency.exponentialRampToValueAtTime(6000, t + len)
        const sg = ctx.createGain()
        sg.gain.setValueAtTime(0.0001, t)
        sg.gain.exponentialRampToValueAtTime(0.1, t + len)
        sg.gain.linearRampToValueAtTime(0, t + len + 0.01)
        siren.connect(lp).connect(shaper(ctx, 2)).connect(sg).connect(bus)
        sg.connect(hall)
        siren.start(t)
        siren.stop(t + len + 0.02)
    }

    const sweepAt = (bar, from, to) => from + (to - from) * (0.5 - 0.5 * Math.cos(2 * Math.PI * (bar % 4) / 4))
    for (let bar = 0; bar < DEMO_BARS; bar++) {
        const s = section(bar)
        const t0 = bar * BAR
        const full = s === 'drop' || s === 'drop2'
        const chord = CHORDS[bar % 4]
        const padLevel = { intro: 0.45, build: 0.5, drop: 0.32, break: 0.95, drop2: 0.32 }[s]
        pad(t0, chord, BAR, padLevel, s === 'break' ? 2400 : 1400)

        let cutoff = null
        let level = 1
        if (s === 'intro' && bar >= 4) {
            cutoff = 150 * Math.pow(320 / 150, (bar - 4) / 3)
            level = 0.55
        } else if (s === 'build') {
            cutoff = 260 * Math.pow(1400 / 260, (bar - 8) / 7)
            level = 0.8
        } else if (s === 'drop') {
            cutoff = sweepAt(bar, 500, 1800)
        } else if (s === 'break' && bar >= 26) {
            cutoff = 220
            level = 0.6
        } else if (s === 'drop2') {
            cutoff = sweepAt(bar, 700, 2300)
        }
        const pattern = bar % 2 ? ACID_B : ACID_A
        for (let i = 0; i < 16; i++) {
            const t = t0 + i * SIXTEENTH
            if (cutoff === null) acidStep(t, null)
            else acidStep(t, pattern[i], cutoff, level)
        }

        if (full) {
            for (let beat = 0; beat < 4; beat++) rumble(t0 + beat * BEAT)
            stab(t0 + 6 * SIXTEENTH, 0.1)
            if (bar % 2) stab(t0 + 14 * SIXTEENTH, 0.07)
        }
        if (s === 'break' && bar % 2 === 0) stab(t0 + 2 * SIXTEENTH, 0.12)
        if (bar === 15 || bar === 27) riser(t0, BAR)
    }
}

async function renderStem(build, seconds, level) {
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
    master.gain.value = level
    master.connect(comp).connect(ctx.destination)
    build(ctx, master, noiseBuffer(ctx, 2, 0x5eed))
    return ctx.startRendering()
}

/** Render the demo stems. Resolves to { drums, synths } AudioBuffers. */
export async function renderDemoStems() {
    const [drums, synths] = await Promise.all([
        renderStem(renderDrums, DEMO_DURATION, 0.52),
        renderStem(renderSynths, DEMO_DURATION, 0.7),
    ])
    return { drums, synths }
}
