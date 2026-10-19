/**
 * Renders one frame of a sequence: every visible layer at its local time,
 * transitions through their DSL mixers, a 2D composite of the layers in
 * track order with each clip's opacity and blend mode, then the
 * sequence's post chain over the composite. Nested sequences render the
 * same way into their own composite and become a layer of their parent.
 * Text, image and video clips draw through the graphics renderer.
 *
 * A program clip that reads `media()` reads the composite of the tracks
 * beneath it, the way the post chain reads the whole frame, so a program
 * can run a title or a logo through its effects.
 *
 * Audio analysis is fed once per frame at the root sequence's time, so
 * every program, nested or not, and the post chain read the same values.
 */

import { activeLayers, upcoming } from '../model/evaluate.js'
import { isGraphic } from '../model/project.js'
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
    constructor({ pool, audio, getProject, graphics }) {
        this.pool = pool
        this.audio = audio
        this.getProject = getProject
        this.graphics = graphics
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
        const ctx = { mode: 'render', seek, missing: 0, rootFps: seq.fps, exact: false }
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
        const ctx = { mode: 'render', seek, missing: 0, rootFps: seq.fps, exact: true }
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
        const collect = { mode: 'collect', entries: [], assets: [], frame, missing: 0 }
        this._renderSeq(seq, t, 'root', 0, collect)
        const total = collect.entries.length + collect.assets.length
        let compiled = 0
        onProgress(0, total)
        await Promise.all([
            ...collect.entries.map(e => this.pool.settle(e).then(() => onProgress(++compiled, total))),
            ...collect.assets.map(job => job.then(() => onProgress(++compiled, total))),
        ])
        return { total, missing: collect.missing }
    }

    /** Compile what plays in the next few seconds before it is needed. */
    prefetch(seq, t0, t1) {
        const { clips, transitions } = upcoming(seq, t0, t1)
        for (const clip of clips) {
            if (clip.type === 'program') this.pool.acquire(`root/${clip.id}`, clip.dsl, { priority: 2 })
            else if (isGraphic(clip)) this.graphics?.prefetch(clip)
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

    /**
     * The canvas a clip contributes at its local time. `below()` gives the
     * composite of the layers beneath it, which a program's media() reads.
     */
    _clipSource(clip, localTime, path, depth, ctx, seq, below) {
        if (isGraphic(clip)) {
            if (!this.graphics) return null
            if (ctx.mode === 'collect') {
                ctx.assets.push(this.graphics.prepare(clip, localTime).catch(() => null))
                return null
            }
            const { width, height } = this.pool
            return this.graphics.draw(clip, localTime, `${path}/${clip.id}`, width, height, { pixel: width / seq.width, exact: ctx.exact })
        }
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
        if (entry.renderer.mediaSteps.length && below) entry.renderer.setInputs([below()])
        entry.renderer.renderAt(loopPhase(localTime, clip.loop), { seek: ctx.seek || activated })
        return entry.renderer.canvas
    }

    /** Paint layers over black into a 2D composite. */
    _paint(comp, drawn) {
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
        return comp.canvas
    }

    _renderSeq(seq, t, path, depth, ctx) {
        const layers = activeLayers(seq, t)
        const drawn = []
        // The layers so far, composited once per layer that asks for them.
        const belowFor = key => () => this._paint(this._composite(`${path}/${key}/below`), drawn)
        for (const layer of layers) {
            if (layer.kind === 'clip') {
                const src = this._clipSource(layer.clip, layer.localTime, path, depth, ctx, seq, belowFor(layer.clip.id))
                if (src) drawn.push({ canvas: src, opacity: layer.clip.opacity ?? 1, blend: layer.clip.blend })
                continue
            }
            const { transition, progress, a, b } = layer
            if (!a || !b) {
                const side = a || b
                const src = this._clipSource(side.clip, side.localTime, path, depth, ctx, seq, belowFor(side.clip.id))
                const fade = a ? 1 - ease(progress) : ease(progress)
                if (src) drawn.push({ canvas: src, opacity: (side.clip.opacity ?? 1) * fade, blend: side.clip.blend })
                continue
            }
            const opacity = (a.clip.opacity ?? 1) * (1 - progress) + (b.clip.opacity ?? 1) * progress
            const blend = progress < 0.5 ? a.clip.blend : b.clip.blend
            if (isGraphic(a.clip) || isGraphic(b.clip)) {
                // Graphics are see-through, so they cross-fade over the tracks beneath instead of mixing to an opaque frame.
                const srcA = this._clipSource(a.clip, a.localTime, path, depth, ctx, seq, belowFor(a.clip.id))
                const srcB = this._clipSource(b.clip, b.localTime, path, depth, ctx, seq, belowFor(b.clip.id))
                if (srcA) drawn.push({ canvas: srcA, opacity: (a.clip.opacity ?? 1) * (1 - ease(progress)), blend: a.clip.blend })
                if (srcB) drawn.push({ canvas: srcB, opacity: (b.clip.opacity ?? 1) * ease(progress), blend: b.clip.blend })
                continue
            }
            const srcA = this._clipSource(a.clip, a.localTime, path, depth, ctx, seq, belowFor(a.clip.id)) || (ctx.mode === 'render' ? this._black() : null)
            const srcB = this._clipSource(b.clip, b.localTime, path, depth, ctx, seq, belowFor(b.clip.id)) || (ctx.mode === 'render' ? this._black() : null)
            const entry = this._entry(`${path}/${transition.id}`, transitionDsl(transition), ctx)
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
        this._paint(comp, drawn)

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
