/**
 * A pool of program renderers, one WebGL2 context each.
 *
 * Browsers keep only a handful of WebGL contexts alive per page, so the
 * timeline never creates one per clip. Each on-screen clip, transition and
 * post chain borrows a renderer keyed by its instance; renderers that
 * were not used in the current frame are recycled for new keys, least
 * recently used first. Compiles run one at a time, the frame's own needs
 * before lookahead.
 */

import { ProgramRenderer } from './programRenderer.js'

export class RendererPool {
    constructor({ capacity = 12, width, height, audioState }) {
        this.capacity = capacity
        this.width = width
        this.height = height
        this.audioState = audioState
        this.entries = new Map()
        this.frame = 0
        this.dslErrors = new Map()
        this._queue = []
        this._busy = false
        this.compiledListeners = new Set()
    }

    /** Start a new frame; entries used before it become recyclable. */
    beginFrame() {
        this.frame++
        return this.frame
    }

    _evictable() {
        let victim = null
        for (const entry of this.entries.values()) {
            if (entry.lastUsed >= this.frame || entry.reservedFrame >= this.frame || entry.pinned) continue
            if (!victim || entry.lastUsed < victim.lastUsed) victim = entry
        }
        return victim
    }

    /**
     * The renderer entry for `key`, compiling `dsl` if it changed.
     * Returns null when every renderer is busy this frame.
     */
    acquire(key, dsl, { priority = 1 } = {}) {
        let entry = this.entries.get(key)
        if (!entry) {
            let renderer = null
            if (this.entries.size >= this.capacity) {
                const victim = this._evictable()
                if (!victim) return null
                this.entries.delete(victim.key)
                renderer = victim.renderer
                renderer.resetState()
            }
            if (!renderer) {
                renderer = new ProgramRenderer({ width: this.width, height: this.height, audioState: this.audioState })
            }
            renderer.resize(this.width, this.height)
            entry = { key, renderer, wanted: null, compiled: null, lastUsed: -1, reservedFrame: -1, job: null }
            this.entries.set(key, entry)
        }
        if (entry.wanted !== dsl) {
            entry.wanted = dsl
            this._enqueue(entry, priority)
        }
        return entry
    }

    /** Ready to render the program it was asked for (or a previous one while recompiling). */
    isReady(entry) {
        return !!entry && entry.compiled !== null && entry.renderer.ready
    }

    /**
     * Mark an entry used this frame. Returns true when it was not used in
     * the previous frame, meaning it just came on screen.
     */
    touch(entry) {
        const activated = entry.lastUsed < this.frame - 1
        entry.lastUsed = this.frame
        return activated
    }

    _enqueue(entry, priority) {
        this._queue = this._queue.filter(item => item.entry !== entry)
        this._queue.push({ entry, priority })
        this._queue.sort((a, b) => a.priority - b.priority)
        if (!entry.job) {
            entry.job = new Promise(resolve => { entry._resolve = resolve })
        }
        this._pump()
    }

    async _pump() {
        if (this._busy) return
        this._busy = true
        while (this._queue.length) {
            const { entry } = this._queue.shift()
            if (this.entries.get(entry.key) !== entry) {
                entry._resolve?.()
                entry.job = null
                continue
            }
            const dsl = entry.wanted
            const result = await entry.renderer.load(dsl)
            if (result.success) {
                entry.compiled = dsl
                this.dslErrors.delete(dsl)
            } else {
                this.dslErrors.set(dsl, result.error)
                if (entry.compiled === null) entry.failed = dsl
            }
            if (entry.wanted === dsl) {
                entry._resolve?.()
                entry.job = null
            }
            for (const fn of this.compiledListeners) fn(entry, result)
        }
        this._busy = false
    }

    /** Wait until an entry has compiled what it was last asked for. */
    async settle(entry) {
        while (entry.job) await entry.job
        return this.isReady(entry) && entry.compiled === entry.wanted
    }

    errorFor(dsl) {
        return this.dslErrors.get(dsl) || null
    }

    /** Clear every renderer's state, so each program starts fresh when next shown. */
    resetAll() {
        for (const entry of this.entries.values()) {
            entry.renderer.resetState()
            entry.lastUsed = -1
        }
    }

    resizeAll(width, height) {
        this.width = width
        this.height = height
        for (const entry of this.entries.values()) entry.renderer.resize(width, height)
    }

    /** Forget an instance key (its renderer is disposed). */
    async release(key) {
        const entry = this.entries.get(key)
        if (!entry) return
        this.entries.delete(key)
        await entry.renderer.dispose()
    }

    async disposeAll() {
        const all = [...this.entries.values()]
        this.entries.clear()
        await Promise.all(all.map(e => e.renderer.dispose()))
    }
}
