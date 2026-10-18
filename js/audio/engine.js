/**
 * The audio engine: mixes a sequence's audio tracks, plays the mix as the
 * master clock, and feeds the engine AudioState that every program reads
 * through `audio()`.
 *
 * Wiring into the DSL:
 *   audio(band: audioBand.low)                         the full mix
 *   audio(band: audioBand.low, channel: 2)             audio track A2
 *   audio(band: audioBand.low, name: "Drums", channel: 1)   the track named Drums
 *
 * Track analysis ignores mute, so a muted track can drive visuals without
 * being heard. The mix respects mute, solo and track gain. Analysis is a
 * pure function of sequence time (see analysis.js), so preview, scrubbing
 * and export see the same values.
 */

import { AudioAnalyzer, applyFrame, silentFrame } from './analysis.js'
import { getAudioBuffer, SAMPLE_RATE } from './media.js'
import { clipEnd } from '../model/project.js'

const SILENT = silentFrame()

function mixKey(project, seq) {
    return JSON.stringify({
        d: seq.duration,
        t: seq.audioTracks.map(t => ({
            id: t.id, n: t.name, m: t.muted, s: t.solo, g: t.gain,
            c: t.clips.map(c => [c.mediaId, c.start, c.duration, c.offset, c.gain, c.fadeIn, c.fadeOut]),
        })),
        media: seq.audioTracks.flatMap(t => t.clips.map(c => project.media[c.mediaId]?.id || null)),
    })
}

async function renderTrack(project, seq, track) {
    const length = Math.max(1, Math.ceil(seq.duration * SAMPLE_RATE))
    const ctx = new OfflineAudioContext({ numberOfChannels: 2, length, sampleRate: SAMPLE_RATE })
    let any = false
    for (const clip of track.clips) {
        const media = project.media[clip.mediaId]
        let buffer = null
        try {
            buffer = await getAudioBuffer(media)
        } catch (err) {
            console.warn('[timeline] audio unavailable', err?.message || err)
        }
        if (!buffer || clip.start >= seq.duration) continue
        any = true
        const src = ctx.createBufferSource()
        src.buffer = buffer
        const g = ctx.createGain()
        const start = clip.start
        const end = Math.min(clipEnd(clip), seq.duration)
        const level = clip.gain ?? 1
        const fadeIn = Math.min(clip.fadeIn || 0, end - start)
        const fadeOut = Math.min(clip.fadeOut || 0, end - start - fadeIn)
        g.gain.setValueAtTime(fadeIn > 0 ? 0 : level, start)
        if (fadeIn > 0) g.gain.linearRampToValueAtTime(level, start + fadeIn)
        if (fadeOut > 0) {
            g.gain.setValueAtTime(level, end - fadeOut)
            g.gain.linearRampToValueAtTime(0, end)
        }
        src.connect(g).connect(ctx.destination)
        const offset = Math.max(0, clip.offset)
        if (offset < buffer.duration) src.start(start, offset, end - start)
    }
    if (!any) return null
    const rendered = await ctx.startRendering()
    const gain = track.gain ?? 1
    if (gain !== 1) {
        for (let c = 0; c < rendered.numberOfChannels; c++) {
            const data = rendered.getChannelData(c)
            for (let i = 0; i < data.length; i++) data[i] *= gain
        }
    }
    return rendered
}

function analyzerFor(buffer) {
    if (!buffer) return null
    const channels = []
    for (let c = 0; c < Math.min(2, buffer.numberOfChannels); c++) channels.push(buffer.getChannelData(c))
    return new AudioAnalyzer(channels, buffer.sampleRate)
}

export class AudioEngine {
    /** @param {{AudioState: Function}} engine - the Noisemaker AudioState class */
    constructor({ AudioState }) {
        this.state = new AudioState()
        this.mixes = new Map()
        this.ctx = null
        this.output = null
        this.source = null
        this.playing = false
        this._clock = null
        this._registered = ''
        this._channelCount = 0
        this.onMixChanged = null
    }

    /** Mix a sequence's audio (cached until its audio arrangement changes). */
    async mix(project, seq) {
        const key = mixKey(project, seq)
        const existing = this.mixes.get(seq.id)
        if (existing && existing.key === key) return existing.ready
        const entry = { key, master: null, tracks: new Map(), analyzers: { master: null, tracks: new Map() } }
        entry.ready = (async () => {
            const rendered = await Promise.all(seq.audioTracks.map(t => renderTrack(project, seq, t)))
            const soloed = seq.audioTracks.some(t => t.solo)
            let master = null
            seq.audioTracks.forEach((track, i) => {
                const buf = rendered[i]
                entry.tracks.set(track.id, buf)
                entry.analyzers.tracks.set(track.id, analyzerFor(buf))
                const audible = buf && !track.muted && (!soloed || track.solo)
                if (!audible) return
                if (!master) {
                    master = new AudioBuffer({ numberOfChannels: 2, length: buf.length, sampleRate: SAMPLE_RATE })
                }
                for (let c = 0; c < 2; c++) {
                    const dst = master.getChannelData(c)
                    const src = buf.getChannelData(Math.min(c, buf.numberOfChannels - 1))
                    for (let s = 0; s < dst.length; s++) dst[s] += src[s]
                }
            })
            entry.master = master
            entry.analyzers.master = analyzerFor(master)
            return entry
        })()
        this.mixes.set(seq.id, entry)
        const result = await entry.ready
        if (this.mixes.get(seq.id) === entry) this.onMixChanged?.(seq.id)
        return result
    }

    currentMix(seqId) {
        const entry = this.mixes.get(seqId)
        return entry && entry.analyzers ? entry : null
    }

    _registerTracks(seq) {
        const signature = seq.audioTracks.map(t => `${t.id}:${t.name}`).join('|')
        if (signature === this._registered) return
        this._registered = signature
        const count = Math.max(1, seq.audioTracks.length)
        this.state.registerDefaultChannels?.(count)
        this._channelCount = count
        for (const track of seq.audioTracks) {
            this.state.registerDevice?.({ id: track.id, name: track.name, channelCount: 1 })
        }
    }

    /** Write the analysis for sequence time `t` into the shared AudioState. */
    feed(seq, t) {
        const sens = seq.audioSensitivity ?? 1
        this._registerTracks(seq)
        const mix = this.currentMix(seq.id)
        const master = mix?.analyzers.master
        applyFrame(this.state, master ? master.frameAt(t) : SILENT, sens)
        seq.audioTracks.forEach((track, i) => {
            const analyzer = mix?.analyzers.tracks.get(track.id)
            const frame = analyzer ? analyzer.frameAt(t) : SILENT
            applyFrame(this.state.getDefaultChannelState?.(i + 1), frame, sens)
            const device = this.state.getDeviceChannelState?.({ id: track.id, name: track.name, channel: 1 })
            if (device && device !== this.state) applyFrame(device, frame, sens)
        })
    }

    /** Analysis values for display (meters). */
    levels(seq, t) {
        const mix = this.currentMix(seq.id)
        const frame = mix?.analyzers.master ? mix.analyzers.master.frameAt(t) : SILENT
        return frame
    }

    // --- playback --------------------------------------------------------

    _ensureContext() {
        if (this.ctx) return this.ctx
        const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext
        if (!Ctor) return null
        this.ctx = new Ctor({ sampleRate: SAMPLE_RATE, latencyHint: 'interactive' })
        this.output = this.ctx.createGain()
        this.output.connect(this.ctx.destination)
        return this.ctx
    }

    /** Call from a user gesture so the browser lets audio start. */
    async unlock() {
        const ctx = this._ensureContext()
        if (ctx && ctx.state !== 'running') {
            try { await ctx.resume() } catch { /* stays suspended until a gesture */ }
        }
    }

    play(seq, t) {
        this.stop()
        const ctx = this._ensureContext()
        const master = this.currentMix(seq.id)?.master
        this.playing = true
        if (ctx && ctx.state === 'running' && master && t < master.duration) {
            const src = ctx.createBufferSource()
            src.buffer = master
            src.connect(this.output)
            const at = ctx.currentTime + 0.02
            src.start(at, Math.max(0, t))
            this.source = src
            this._clock = { kind: 'audio', at, t0: t }
        } else {
            this._clock = { kind: 'wall', at: performance.now(), t0: t }
        }
    }

    stop() {
        if (this.source) {
            try { this.source.stop() } catch { /* already stopped */ }
            this.source.disconnect()
            this.source = null
        }
        this.playing = false
        this._clock = null
    }

    /** Playhead time while playing, from the audio clock when there is audio. */
    time() {
        const c = this._clock
        if (!c) return null
        if (c.kind === 'audio' && this.ctx) {
            const latency = this.ctx.outputLatency || this.ctx.baseLatency || 0
            return c.t0 + Math.max(0, this.ctx.currentTime - c.at - latency)
        }
        return c.t0 + (performance.now() - c.at) / 1000
    }

    /** A short burst of audio at `t`, for scrubbing. */
    scrub(seq, t) {
        if (this.playing) return
        const ctx = this._ensureContext()
        const master = this.currentMix(seq.id)?.master
        if (!ctx || ctx.state !== 'running' || !master || t < 0 || t >= master.duration) return
        const now = performance.now()
        if (this._lastScrub && now - this._lastScrub < 45) return
        this._lastScrub = now
        const src = ctx.createBufferSource()
        src.buffer = master
        const g = ctx.createGain()
        const at = ctx.currentTime
        g.gain.setValueAtTime(0, at)
        g.gain.linearRampToValueAtTime(0.9, at + 0.005)
        g.gain.setValueAtTime(0.9, at + 0.055)
        g.gain.linearRampToValueAtTime(0, at + 0.07)
        src.connect(g).connect(this.output)
        src.start(at, t, 0.075)
    }

    /**
     * The mix for an export range as one AudioBuffer exactly
     * `frames / fps` long (silence where there is no audio).
     */
    exportBuffer(seq, start, end) {
        const master = this.currentMix(seq.id)?.master
        const length = Math.max(1, Math.round((end - start) * SAMPLE_RATE))
        const out = new AudioBuffer({ numberOfChannels: 2, length, sampleRate: SAMPLE_RATE })
        if (!master) return out
        const from = Math.round(start * SAMPLE_RATE)
        for (let c = 0; c < 2; c++) {
            const src = master.getChannelData(c)
            const dst = out.getChannelData(c)
            const avail = Math.max(0, Math.min(length, src.length - from))
            if (avail > 0) dst.set(src.subarray(from, from + avail))
        }
        return out
    }
}
