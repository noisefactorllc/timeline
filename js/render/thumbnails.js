/**
 * Thumbnails for clip filmstrips and library cards, rendered by one small
 * dedicated renderer so they never borrow a renderer from the monitor.
 * Requests are cached by program and phase; programs compile once per
 * batch. Thumbnails see silent audio, so they show a program's resting
 * look rather than whatever the playhead happens to hear.
 */

import { ProgramRenderer } from './programRenderer.js'

export const THUMB_W = 192
export const THUMB_H = 108
const SETTLE_FRAMES = 6

export function hashString(s) {
    let h = 0x811c9dc5
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
    }
    return (h >>> 0).toString(36)
}

export class Thumbnails {
    constructor({ AudioState }) {
        this.audioState = new AudioState()
        this.renderer = null
        this.cache = new Map()
        this.failed = new Set()
        this.queue = []
        this.waiters = new Map()
        this.listeners = new Set()
        this._running = false
        this.paused = false
    }

    onReady(fn) {
        this.listeners.add(fn)
        return () => this.listeners.delete(fn)
    }

    key(dsl, phase) {
        return `${hashString(dsl)}:${Math.round(phase * 1000)}`
    }

    get(dsl, phase) {
        return this.cache.get(this.key(dsl, phase)) || null
    }

    hasFailed(dsl) {
        return this.failed.has(hashString(dsl))
    }

    /** Ask for a thumbnail; resolves to an ImageBitmap, or null when the program fails. */
    request(dsl, phase, { priority = 1 } = {}) {
        const key = this.key(dsl, phase)
        if (this.cache.has(key)) return Promise.resolve(this.cache.get(key))
        if (this.failed.has(hashString(dsl))) return Promise.resolve(null)
        if (!this.waiters.has(key)) {
            this.waiters.set(key, [])
            this.queue.push({ key, dsl, phase, priority })
            this.queue.sort((a, b) => a.priority - b.priority)
        }
        const promise = new Promise(resolve => this.waiters.get(key).push(resolve))
        this._run()
        return promise
    }

    _finish(key, bitmap) {
        if (bitmap) this.cache.set(key, bitmap)
        for (const resolve of this.waiters.get(key) || []) resolve(bitmap)
        this.waiters.delete(key)
        for (const fn of this.listeners) fn(key)
    }

    async _run() {
        if (this._running) return
        this._running = true
        try {
            if (!this.renderer) {
                this.renderer = new ProgramRenderer({ width: THUMB_W, height: THUMB_H, audioState: this.audioState })
            }
            while (this.queue.length) {
                if (this.paused) {
                    await new Promise(r => setTimeout(r, 200))
                    continue
                }
                const head = this.queue[0]
                const batch = this.queue.filter(item => item.dsl === head.dsl)
                this.queue = this.queue.filter(item => item.dsl !== head.dsl)
                const result = this.renderer.dsl === head.dsl ? { success: true } : await this.renderer.load(head.dsl)
                if (!result.success) {
                    this.failed.add(hashString(head.dsl))
                    for (const item of batch) this._finish(item.key, null)
                    continue
                }
                for (const item of batch) {
                    this.renderer.resetState()
                    for (let i = SETTLE_FRAMES; i >= 0; i--) {
                        const p = item.phase - i / 240
                        this.renderer.renderAt(p - Math.floor(p), { seek: i === SETTLE_FRAMES })
                    }
                    let bitmap = null
                    try {
                        bitmap = await createImageBitmap(this.renderer.canvas)
                    } catch {
                        bitmap = null
                    }
                    this._finish(item.key, bitmap)
                    await new Promise(r => requestAnimationFrame(r))
                }
            }
        } finally {
            this._running = false
        }
    }
}
