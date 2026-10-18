/**
 * Thumbnails for clip filmstrips and library cards, rendered by one small
 * dedicated renderer so they never borrow a renderer from the monitor.
 * Requests are cached by program and phase; programs compile once per
 * batch. Thumbnails hear a steady mid-level signal rather than whatever
 * the playhead happens to hear.
 */

import { ProgramRenderer } from './programRenderer.js'
import { loadThumb, saveThumb } from '../storage/db.js'

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
        // A steady mid-level signal on the mix and every channel, so
        // audio-driven programs show a representative frame, not their floor.
        this.audioState = new AudioState()
        this.audioState.setBands(0.5, 0.5, 0.5)
        this.audioState.registerDefaultChannels?.(8)
        for (let ch = 1; ch <= 8; ch++) this.audioState.getDefaultChannelState?.(ch)?.setBands(0.5, 0.5, 0.5)
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
        return `a2:${hashString(dsl)}:${Math.round(phase * 1000)}`
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
            this._fromStore(key).then(bitmap => {
                if (bitmap) {
                    this._finish(key, bitmap)
                    return
                }
                this.queue.push({ key, dsl, phase, priority })
                this.queue.sort((a, b) => a.priority - b.priority)
                this._run()
            })
        }
        return new Promise(resolve => this.waiters.get(key).push(resolve))
    }

    async _fromStore(key) {
        try {
            const record = await loadThumb(key)
            if (!record) return null
            return await createImageBitmap(new Blob([record.bytes], { type: record.type }))
        } catch {
            return null
        }
    }

    async _toStore(key, canvas) {
        try {
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.82))
            if (blob) await saveThumb(key, await blob.arrayBuffer(), blob.type)
        } catch {
            // The cache is a convenience; a failed write only costs a re-render later.
        }
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
                    if (bitmap) this._toStore(item.key, this.renderer.canvas)
                    this._finish(item.key, bitmap)
                    await new Promise(r => requestAnimationFrame(r))
                }
                // Leave the main thread room between programs: compiling is the expensive part.
                await new Promise(r => setTimeout(r, 120))
            }
        } finally {
            this._running = false
        }
    }
}
