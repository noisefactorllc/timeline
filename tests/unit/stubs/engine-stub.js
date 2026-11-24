/**
 * A stand-in for the Noisemaker engine bundle, for unit tests of the
 * renderer plumbing. The real bundle loads from the CDN and needs a DOM
 * and WebGL2; these tests only need the shape of the engine's API and a
 * render() that spans awaits, the way a scene() render does.
 */

export const CDN_BASE = 'https://engine.test/1'

export function extractEffectNamesFromDsl() {
    return []
}

/** Every CanvasRenderer the stub built, so tests can reach the latest one. */
export const created = []

export class CanvasRenderer {
    constructor() {
        this.manifest = { 'test-effect': {} }
        this.pipeline = null
        this.mediaSteps = []
        this.canvas = {
            width: 0,
            height: 0,
            // Drives the stub frame's readiness; the composite must read the
            // canvas only while this is true.
            present: true,
            getContext() {
                return null
            },
        }
        created.push(this)
    }

    async loadManifest() {
        return this.manifest
    }

    async loadEffects() {}

    compileError = null

    async compile() {
        if (this.compileError) throw this.compileError
        this.pipeline = {
            surfaces: new Map(),
            async whenAsyncInitsSettled() {},
        }
    }

    setAudioState() {}

    getMediaSteps() {
        return this.mediaSteps
    }

    updateTextureFromSource() {}

    applyStepParameterValues() {}

    syncTime(phase) {
        this.syncedPhase = phase
    }

    resize() {}

    async dispose() {}

    /** One frame whose presentable moment lands after an await, like a scene render. */
    render(phase) {
        this.canvas.present = false
        this.phase = phase
        return new Promise(resolve => {
            setTimeout(() => {
                this.canvas.present = true
                resolve()
            }, 2)
        })
    }
}
