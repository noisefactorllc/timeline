/**
 * Renders one frame of a sequence: every visible layer at its local time,
 * transitions through their DSL mixers, a 2D composite of the layers in
 * track order with each clip's opacity and blend mode, then the
 * sequence's post chain over the composite. Nested sequences render the
 * same way into their own composite and become a layer of their parent.
 *
 * Audio analysis is fed once per frame at the root sequence's time, so
 * every program, nested or not, and the post chain read the same values.
 */

import { activeLayers, upcoming } from '../model/evaluate.js'
import { loopPhase } from '../model/time.js'
import { transitionPreset } from '../data/presets.js'

const MAX_DEPTH = 4

const COMPOSITE_OPS = {
    normal: 'source-over',
    add: 'lighter',
    screen: 'screen',
    multiply: 'multiply',
    overlay: 'overlay',
    lighten: 'lighten',
    darken: 'darken',
    difference: 'difference',
    exclusion: 'exclusion',
    'color-dodge': 'color-dodge',
    'color-burn': 'color-burn',
    'hard-light': 'hard-light',
    'soft-light': 'soft-light',
    hue: 'hue',
    saturation: 'saturation',
    color: 'color',
    luminosity: 'luminosity',
}

const ease = x => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, x)))) / 2

export function transitionDsl(transition) {
    return transition.dsl && transition.dsl.trim() ? transition.dsl : transitionPreset(transition.preset).dsl
}

export class SequenceRenderer {
    constructor({ pool, audio, getProject }) {
        this.pool = pool
        this.audio = audio
        this.getProject = getProject
        this.composites = new Map()
        this.lastMissing = 0
        this.exporting = false
    }

    _composite(path) {
        let entry = this.composites.get(path)
        const { width, height } = this.pool
        if (!entry) {
            const canvas = document.createElement('canvas')
            const ctx = canvas.getContext('2d', { alpha: false })
            entry = { canvas, ctx }
            this.composites.set(path, entry)
        }
        if (entry.canvas.width !== width || entry.canvas.height !== height) {
            entry.canvas.width = width
            entry.canvas.height = height
        }
        return entry
    }

    _black() {
        return this._composite('__black').canvas
    }

    /** Render a frame for preview. Programs still compiling are skipped. */
    renderFrame(seq, t, { seek = false } = {}) {
        this.pool.beginFrame()
        this.audio.feed(seq, t)
        const ctx = { mode: 'render', seek, missing: 0, rootFps: seq.fps }
        const canvas = this._renderSeq(seq, t, 'root', 0, ctx)
        this.lastMissing = ctx.missing
        return { canvas, missing: ctx.missing }
    }

    /**
     * Render a frame with every program compiled first: export uses this,
     * so no frame is ever missing a layer.
     */
    async renderFrameExact(seq, t, { seek = false } = {}) {
        await this.prepareFrame(seq, t)
        this.audio.feed(seq, t)
        const ctx = { mode: 'render', seek, missing: 0, rootFps: seq.fps }
        const canvas = this._renderSeq(seq, t, 'root', 0, ctx)
        return { canvas, missing: ctx.missing }
    }

    /**
     * Compile everything the frame at `t` needs, reporting
     * onProgress(compiled, total) as each program settles. The frame's
     * renderers stay reserved until the next frame begins.
     */
    async prepareFrame(seq, t, onProgress = () => {}) {
        const frame = this.pool.beginFrame()
        const collect = { mode: 'collect', entries: [], frame, missing: 0 }
        this._renderSeq(seq, t, 'root', 0, collect)
        const total = collect.entries.length
        let compiled = 0
        onProgress(0, total)
        await Promise.all(collect.entries.map(e => this.pool.settle(e).then(() => onProgress(++compiled, total))))
        return { total, missing: collect.missing }
    }

    /** Compile what plays in the next few seconds before it is needed. */
    prefetch(seq, t0, t1) {
        const { clips, transitions } = upcoming(seq, t0, t1)
        for (const clip of clips) {
            if (clip.type === 'program') this.pool.acquire(`root/${clip.id}`, clip.dsl, { priority: 2 })
        }
        for (const transition of transitions) {
            if (transition.from && transition.to) {
                this.pool.acquire(`root/${transition.id}`, transitionDsl(transition), { priority: 2 })
            }
        }
    }

    _entry(key, dsl, ctx, priority = 0) {
        const entry = this.pool.acquire(key, dsl, { priority })
        if (!entry) {
            ctx.missing++
            return null
        }
        if (ctx.mode === 'collect') {
            entry.reservedFrame = ctx.frame
            ctx.entries.push(entry)
            return null
        }
        if (!this.pool.isReady(entry)) {
            ctx.missing++
            return null
        }
        return entry
    }

    _clipSource(clip, localTime, path, depth, ctx) {
        if (clip.type === 'sequence') {
            const child = this.getProject()?.sequences?.[clip.sequenceId]
            if (!child || depth >= MAX_DEPTH) return null
            const d = child.duration
            let local = localTime
            if (clip.loopSequence !== false && d > 0) {
                local = ((localTime % d) + d) % d
            } else {
                local = Math.max(0, Math.min(d - 1 / child.fps, localTime))
            }
            return this._renderSeq(child, local, `${path}/${clip.id}`, depth + 1, ctx)
        }
        const entry = this._entry(`${path}/${clip.id}`, clip.dsl, ctx)
        if (!entry) return null
        const activated = this.pool.touch(entry)
        if (activated) entry.renderer.resetState()
        entry.renderer.renderAt(loopPhase(localTime, clip.loop), { seek: ctx.seek || activated })
        return entry.renderer.canvas
    }

    _renderSeq(seq, t, path, depth, ctx) {
        const layers = activeLayers(seq, t)
        const drawn = []
        for (const layer of layers) {
            if (layer.kind === 'clip') {
                const src = this._clipSource(layer.clip, layer.localTime, path, depth, ctx)
                if (src) drawn.push({ canvas: src, opacity: layer.clip.opacity ?? 1, blend: layer.clip.blend })
                continue
            }
            const { transition, progress, a, b } = layer
            if (!a || !b) {
                const side = a || b
                const src = this._clipSource(side.clip, side.localTime, path, depth, ctx)
                const fade = a ? 1 - ease(progress) : ease(progress)
                if (src) drawn.push({ canvas: src, opacity: (side.clip.opacity ?? 1) * fade, blend: side.clip.blend })
                continue
            }
            const srcA = this._clipSource(a.clip, a.localTime, path, depth, ctx) || (ctx.mode === 'render' ? this._black() : null)
            const srcB = this._clipSource(b.clip, b.localTime, path, depth, ctx) || (ctx.mode === 'render' ? this._black() : null)
            const entry = this._entry(`${path}/${transition.id}`, transitionDsl(transition), ctx)
            const opacity = (a.clip.opacity ?? 1) * (1 - progress) + (b.clip.opacity ?? 1) * progress
            const blend = progress < 0.5 ? a.clip.blend : b.clip.blend
            if (!entry) {
                // Fall back to a plain dissolve while the transition compiles.
                if (srcA) drawn.push({ canvas: srcA, opacity: opacity, blend })
                if (srcB) drawn.push({ canvas: srcB, opacity: opacity * ease(progress), blend })
                continue
            }
            this.pool.touch(entry)
            entry.renderer.setInputs([srcA, srcB])
            entry.renderer.renderAt(Math.min(progress, 0.99999), { seek: true })
            drawn.push({ canvas: entry.renderer.canvas, opacity, blend })
        }

        if (ctx.mode === 'collect') {
            if (seq.post?.enabled && seq.post.dsl?.trim()) this._entry(`${path}/post`, seq.post.dsl, ctx)
            return null
        }

        const comp = this._composite(path)
        const g = comp.ctx
        g.globalCompositeOperation = 'source-over'
        g.globalAlpha = 1
        g.fillStyle = '#000'
        g.fillRect(0, 0, comp.canvas.width, comp.canvas.height)
        for (const layer of drawn) {
            if (layer.opacity <= 0) continue
            g.globalAlpha = Math.min(1, layer.opacity)
            g.globalCompositeOperation = COMPOSITE_OPS[layer.blend] || 'source-over'
            g.drawImage(layer.canvas, 0, 0, comp.canvas.width, comp.canvas.height)
        }
        g.globalAlpha = 1
        g.globalCompositeOperation = 'source-over'

        if (seq.post?.enabled && seq.post.dsl?.trim()) {
            const entry = this._entry(`${path}/post`, seq.post.dsl, ctx)
            if (entry) {
                const activated = this.pool.touch(entry)
                entry.renderer.setInputs([comp.canvas])
                entry.renderer.renderAt(loopPhase(t, seq.post.loop || 8), { seek: ctx.seek || activated })
                return entry.renderer.canvas
            }
        }
        return comp.canvas
    }
}
