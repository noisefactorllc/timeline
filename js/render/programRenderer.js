/**
 * One Noisemaker CanvasRenderer driven by the timeline instead of its own
 * clock. The timeline calls `renderAt(phase)` with an explicit engine phase
 * for every frame, so playback, scrubbing and export are frame exact.
 *
 * A program may read other canvases through `media()` steps: transitions
 * read the outgoing and incoming clips, the post chain reads the
 * composite. `setInputs()` uploads them in step order before each render.
 * Renderers always run on WebGL2, whose drawing buffer stays readable for
 * compositing and export.
 */

import {
    CanvasRenderer, CDN_BASE, extractEffectNamesFromDsl,
} from '../noisemaker/bundle.js'

function stripComments(dsl) {
    return dsl.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')
}

function errorMessage(err) {
    if (!err) return 'Compile failed'
    if (typeof err === 'string') return err
    if (err.message) return err.message
    if (err.error) return String(err.error)
    if (Array.isArray(err.diagnostics) && err.diagnostics.length) {
        return err.diagnostics.map(d => d.message || String(d)).join('\n')
    }
    try { return JSON.stringify(err) } catch { return String(err) }
}

let manifestPromise = null

export class ProgramRenderer {
    constructor({ width, height, audioState }) {
        this.width = width
        this.height = height
        this.canvas = document.createElement('canvas')
        this.canvas.width = width
        this.canvas.height = height
        this.dsl = null
        this.status = 'idle'
        this.error = null
        this.mediaSteps = []
        this._sizes = []
        this._lastPhase = null
        this._renderer = new CanvasRenderer({
            canvas: this.canvas,
            width,
            height,
            basePath: CDN_BASE,
            useBundles: true,
            bundlePath: `${CDN_BASE}/effects`,
            preferWebGPU: false,
            onError: err => { this.lastRuntimeError = errorMessage(err) },
        })
        this._audioState = audioState
        this._ready = null
    }

    async _init() {
        if (!this._ready) {
            // Each renderer needs its own manifest; the first fetch warms the HTTP cache.
            this._ready = (async () => {
                if (manifestPromise) await manifestPromise.catch(() => {})
                const load = this._renderer.loadManifest()
                if (!manifestPromise) manifestPromise = load
                await load
                if (!this._renderer.manifest || !Object.keys(this._renderer.manifest).length) {
                    this._ready = null
                    throw new Error('The effect manifest did not load')
                }
            })()
        }
        return this._ready
    }

    /** Compile a program. Resolves to {success, error}. */
    async load(dsl) {
        this.status = 'compiling'
        this.error = null
        try {
            await this._init()
            const ids = extractEffectNamesFromDsl(stripComments(dsl), this._renderer.manifest || {})
                .map(e => e.effectId)
            if (ids.length) await this._renderer.loadEffects(ids)
            await this._renderer.compile(dsl)
            await this._renderer.pipeline?.whenAsyncInitsSettled?.()
            if (this._audioState) this._renderer.setAudioState(this._audioState)
            this.mediaSteps = this._renderer.getMediaSteps?.() || []
            this._sizes = []
            this.dsl = dsl
            this.status = 'ready'
            this._lastPhase = null
            return { success: true }
        } catch (err) {
            this.status = this.dsl ? 'ready' : 'error'
            this.error = errorMessage(err)
            return { success: false, error: this.error }
        }
    }

    get ready() {
        return this.status === 'ready'
    }

    /** Upload input canvases into the program's media() steps, in order. */
    setInputs(sources) {
        for (let i = 0; i < this.mediaSteps.length; i++) {
            const step = this.mediaSteps[i]
            const src = sources[i] || sources[sources.length - 1]
            if (!src) continue
            try {
                this._renderer.updateTextureFromSource(step.textureId, src, { flipY: false })
                const w = src.width
                const h = src.height
                const size = this._sizes[i]
                if (!size || size[0] !== w || size[1] !== h) {
                    this._renderer.applyStepParameterValues?.({ [`step_${step.stepIndex}`]: { imageSize: [w, h] } })
                    this._sizes[i] = [w, h]
                }
            } catch {
                // A recompile is in flight; the next frame uploads again.
            }
        }
    }

    /**
     * Render at an engine phase (0..1). `seek` zeroes the time step so a
     * jump is not integrated by simulations.
     */
    renderAt(phase, { seek = false } = {}) {
        if (this.status !== 'ready' && !this.dsl) return false
        if (seek || this._lastPhase === null) this._renderer.syncTime(phase)
        this._renderer.render(phase)
        this._lastPhase = phase
        return true
    }

    /** Clear simulation and feedback state so the program starts fresh. */
    resetState() {
        const pipeline = this._renderer.pipeline
        if (!pipeline) return
        try {
            for (const name of pipeline.surfaces?.keys?.() || []) pipeline.clearSurface(name)
        } catch { /* nothing to clear yet */ }
        this._lastPhase = null
    }

    resize(width, height) {
        if (width === this.width && height === this.height) return
        this.width = width
        this.height = height
        this.canvas.width = width
        this.canvas.height = height
        this._renderer.resize(width, height)
        this._sizes = []
        this._lastPhase = null
    }

    async dispose() {
        try {
            await this._renderer.dispose?.({ loseContext: true, resetCanvas: true })
        } catch { /* already gone */ }
        this.status = 'disposed'
    }
}
