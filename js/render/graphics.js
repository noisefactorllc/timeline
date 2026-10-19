/**
 * Draws text, image and video clips: each into its own transparent canvas
 * at the frame's size, at the clip's position, scale and rotation, with its
 * enter and exit motion. The sequence renderer composites the canvas like
 * any layer, and a program above it can read it through `media()`.
 *
 * Positions are fractions of the frame (0.5, 0.5 is the centre) and text
 * size is a fraction of the frame's height, so a clip looks the same in the
 * half-size preview and the full-size export.
 *
 * Export draws exact frames: `prepare()` loads the font or image and
 * decodes the video frame for the time first. The preview never waits: it
 * draws what is ready and redraws through `onChange` when more arrives.
 */

import { ease } from '../model/ease.js'
import { keyValue } from '../model/automation.js'
import { mediaBlob, mediaKey } from '../audio/media.js'
import { loadFont, fontStatus, cssFamily, onFontLoaded } from './fonts.js'

const MOTION_TRAVEL = 0.08
const MOTION_BLUR = 0.03

/** How an enter or exit motion shapes a graphic; `v` is how far in it is, 0..1. */
function applyMotion(state, preset, v, side) {
    switch (preset) {
        case 'fade':
            state.alpha *= v
            break
        case 'rise':
            state.alpha *= v
            state.dy += (side === 'enter' ? 1 : -1) * (1 - v) * MOTION_TRAVEL
            break
        case 'drop':
            state.alpha *= v
            state.dy += (side === 'enter' ? -1 : 1) * (1 - v) * MOTION_TRAVEL
            break
        case 'scale':
            state.alpha *= v
            state.scale *= 0.85 + 0.15 * v
            break
        case 'wipe':
            if (side === 'enter') state.wipeTo = Math.min(state.wipeTo, v)
            else state.wipeFrom = Math.max(state.wipeFrom, 1 - v)
            break
        case 'blur':
            state.alpha *= v
            state.blur = Math.max(state.blur, (1 - v) * MOTION_BLUR)
            break
        case 'type':
            state.reveal = Math.min(state.reveal, v)
            break
    }
}

/** The motion state of a graphic `elapsed` seconds into its clip. */
export function motionAt(clip, elapsed) {
    const state = { alpha: 1, dy: 0, scale: 1, blur: 0, wipeFrom: 0, wipeTo: 1, reveal: 1 }
    const enter = clip.enter
    if (enter && enter.preset !== 'none' && enter.duration > 0 && elapsed < enter.duration) {
        applyMotion(state, enter.preset, ease(enter.ease)(elapsed / enter.duration), 'enter')
    }
    const exit = clip.exit
    const remaining = clip.duration - elapsed
    if (exit && exit.preset !== 'none' && exit.duration > 0 && remaining < exit.duration) {
        applyMotion(state, exit.preset, 1 - ease(exit.ease)(1 - remaining / exit.duration), 'exit')
    }
    // Type-on is a text effect; on an image or a video it fades.
    if (clip.type !== 'text' && state.reveal < 1) {
        state.alpha *= state.reveal
        state.reveal = 1
    }
    return state
}

/** Break text into lines no wider than `maxWidth`, keeping its own line breaks. */
function wrapLines(g, text, maxWidth) {
    const lines = []
    for (const paragraph of String(text).split('\n')) {
        const words = paragraph.split(/(\s+)/)
        let line = ''
        for (const word of words) {
            const next = line + word
            if (line.trim() && g.measureText(next.trimEnd()).width > maxWidth) {
                lines.push(line.trimEnd())
                line = word.trimStart()
            } else {
                line = next
            }
        }
        lines.push(line.trimEnd())
    }
    return lines
}

/** Fit natural size (iw, ih) into the frame (W, H); `pixel` maps media pixels to frame pixels. */
function fitSize(fit, iw, ih, W, H, pixel) {
    if (fit === 'fill') return [W, H]
    if (fit === 'none') return [iw * pixel, ih * pixel]
    const s = fit === 'cover' ? Math.max(W / iw, H / ih) : Math.min(W / iw, H / ih)
    return [iw * s, ih * s]
}

/**
 * Decoded frames of one video file. `frameAt(t)` resolves the frame shown
 * at `t` exactly, decoding forward from the last frame when it can and
 * seeking when it must; calls run one at a time.
 */
class VideoReader {
    static async open(blob) {
        const mb = await import('mediabunny')
        const input = new mb.Input({ source: new mb.BlobSource(blob), formats: mb.ALL_FORMATS })
        const track = await input.getPrimaryVideoTrack()
        if (!track) throw new Error('it has no video track')
        if (!(await track.canDecode())) throw new Error(`this browser cannot decode its ${track.codec || 'video'} video`)
        const reader = new VideoReader()
        reader.input = input
        reader.sink = new mb.CanvasSink(track)
        reader.first = await track.getFirstTimestamp()
        reader.duration = await track.computeDuration()
        reader.width = track.displayWidth
        reader.height = track.displayHeight
        return reader
    }

    constructor() {
        this.current = null
        this.upcoming = null
        this.frames = null
        this.chain = Promise.resolve()
        this.wanted = null
        this.busy = false
    }

    _covers(frame, t) {
        return frame && t >= frame.timestamp - 1e-6 && t < frame.timestamp + Math.max(frame.duration, 1e-3) - 1e-6
    }

    frameAt(t) {
        const run = this.chain.then(() => this._frameAt(t))
        this.chain = run.catch(() => {})
        return run
    }

    async _frameAt(t) {
        t = Math.max(this.first, t)
        if (this._covers(this.current, t)) return this.current
        // Playing forward: take frames from the running decoder until one covers t.
        if (this.frames && this.current && t > this.current.timestamp && t < this.current.timestamp + 2) {
            for (;;) {
                if (!this.upcoming) {
                    const next = await this.frames.next()
                    if (next.done) return this.current
                    this.upcoming = next.value
                }
                if (this.upcoming.timestamp > t + 1e-6) return this.current
                this.current = this.upcoming
                this.upcoming = null
                if (this._covers(this.current, t)) return this.current
            }
        }
        // A jump: decode the frame at t, then keep decoding forward from it.
        await this.frames?.return?.()
        this.upcoming = null
        this.current = (await this.sink.getCanvas(t)) || (await this.sink.getCanvas(this.first))
        this.frames = this.current ? this.sink.canvases(this.current.timestamp + Math.max(this.current.duration, 1e-3) / 2) : null
        return this.current
    }

    /** For the preview: decode toward `t` in the background; `done()` runs when a frame lands. */
    request(t, done) {
        this.wanted = t
        if (this.busy) return
        this.busy = true
        ;(async () => {
            while (this.wanted !== null) {
                const want = this.wanted
                this.wanted = null
                try {
                    await this.frameAt(want)
                    done()
                } catch { /* the next request tries again */ }
            }
            this.busy = false
        })()
    }
}

export class GraphicsRenderer {
    constructor({ getProject, onChange = () => {} }) {
        this.getProject = getProject
        this.onChange = onChange
        this.canvases = new Map()
        this.textLayers = new WeakMap()
        this.images = new Map()
        this.videos = new Map()
        onFontLoaded(() => this.onChange())
    }

    _media(clip) {
        return this.getProject()?.media?.[clip.mediaId] || null
    }

    _canvas(key, width, height) {
        let entry = this.canvases.get(key)
        if (!entry) {
            const canvas = document.createElement('canvas')
            entry = { canvas, ctx: canvas.getContext('2d') }
            this.canvases.set(key, entry)
        }
        if (entry.canvas.width !== width || entry.canvas.height !== height) {
            entry.canvas.width = width
            entry.canvas.height = height
        }
        return entry
    }

    _image(media) {
        const key = mediaKey(media)
        let entry = this.images.get(key)
        if (!entry) {
            entry = { status: 'loading', image: null, error: null }
            entry.promise = (async () => {
                try {
                    const url = URL.createObjectURL(await mediaBlob(media))
                    const image = new Image()
                    image.src = url
                    await image.decode()
                    entry.image = image
                    entry.width = image.naturalWidth || 1024
                    entry.height = image.naturalHeight || 1024
                    entry.status = 'ready'
                    this.onChange()
                } catch (err) {
                    entry.status = 'failed'
                    entry.error = `${media.name} did not load: ${err?.message || 'not an image this browser can show'}`
                }
            })()
            this.images.set(key, entry)
        }
        return entry
    }

    _video(media) {
        const key = mediaKey(media)
        let entry = this.videos.get(key)
        if (!entry) {
            entry = { status: 'loading', reader: null, error: null }
            entry.promise = (async () => {
                try {
                    entry.reader = await VideoReader.open(await mediaBlob(media))
                    entry.status = 'ready'
                } catch (err) {
                    entry.status = 'failed'
                    entry.error = `${media.name} cannot play: ${err?.message || 'it did not decode'}`
                }
            })()
            this.videos.set(key, entry)
        }
        return entry
    }

    /** Seconds into the video file for a clip's local time. */
    _videoTime(clip, localTime, reader) {
        const length = Math.max(1e-3, reader.duration - reader.first)
        if (clip.loopVideo) return reader.first + (((localTime % length) + length) % length)
        return Math.min(reader.first + Math.max(0, localTime), reader.duration - 1e-4)
    }

    /** Load what the clip needs to draw at `localTime`. Resolves an error message, or null. */
    async prepare(clip, localTime) {
        if (clip.type === 'text') {
            await loadFont(clip.font, clip.weight, clip.italic)
            return null
        }
        const media = this._media(clip)
        if (!media) return `"${clip.name}" has no media`
        if (clip.type === 'image') {
            const entry = this._image(media)
            await entry.promise
            return entry.error
        }
        const entry = this._video(media)
        await entry.promise
        if (entry.error) return entry.error
        await entry.reader.frameAt(this._videoTime(clip, localTime, entry.reader))
        return null
    }

    /** Start loading what upcoming clips need, without waiting. */
    prefetch(clip) {
        if (clip.type === 'text') fontStatus(clip.font, clip.weight, clip.italic)
        else {
            const media = this._media(clip)
            if (media?.kind === 'image') this._image(media)
            else if (media?.kind === 'video') this._video(media)
        }
    }

    /**
     * Draw a clip at its local time into its canvas and return the canvas.
     * `pixel` is frame pixels per sequence pixel (the preview scale).
     */
    draw(clip, localTime, key, width, height, { pixel = 1, exact = false } = {}) {
        const { canvas, ctx: g } = this._canvas(key, width, height)
        g.setTransform(1, 0, 0, 1, 0, 0)
        g.globalAlpha = 1
        g.filter = 'none'
        g.clearRect(0, 0, width, height)
        const elapsed = localTime - (clip.offset || 0)
        const m = motionAt(clip, elapsed)
        if (m.alpha <= 0 || m.wipeTo <= m.wipeFrom) return canvas

        let content = null
        if (clip.type === 'text') content = this._textContent(g, clip, width, height, m)
        else if (clip.type === 'image') {
            const media = this._media(clip)
            const entry = media && this._image(media)
            if (entry?.status === 'ready') {
                const [w, h] = fitSize(clip.fit, entry.width, entry.height, width, height, pixel)
                content = { left: -w / 2, top: -h / 2, width: w, height: h, paint: () => g.drawImage(entry.image, -w / 2, -h / 2, w, h) }
            }
        } else if (clip.type === 'video') {
            const media = this._media(clip)
            const entry = media && this._video(media)
            const reader = entry?.status === 'ready' ? entry.reader : null
            if (reader) {
                const t = this._videoTime(clip, localTime, reader)
                if (!exact) reader.request(t, () => this.onChange())
                const frame = reader.current
                if (frame) {
                    const [w, h] = fitSize(clip.fit, reader.width, reader.height, width, height, pixel)
                    content = { left: -w / 2, top: -h / 2, width: w, height: h, paint: () => g.drawImage(frame.canvas, -w / 2, -h / 2, w, h) }
                }
            }
        }
        if (!content) return canvas

        const keys = clip.keys || {}
        const x = keyValue(keys.x, elapsed, clip.x)
        const y = keyValue(keys.y, elapsed, clip.y)
        const scale = keyValue(keys.scale, elapsed, clip.scale)
        const rotation = keyValue(keys.rotation, elapsed, clip.rotation || 0)
        g.save()
        g.globalAlpha = Math.max(0, Math.min(1, m.alpha))
        if (m.blur > 0) g.filter = `blur(${(m.blur * height).toFixed(2)}px)`
        g.translate(x * width, (y + m.dy) * height)
        g.rotate((rotation * Math.PI) / 180)
        g.scale(scale * m.scale, scale * m.scale)
        if (m.wipeFrom > 0 || m.wipeTo < 1) {
            g.beginPath()
            g.rect(content.left + content.width * m.wipeFrom, content.top - height, content.width * (m.wipeTo - m.wipeFrom), content.height + height * 2)
            g.clip()
        }
        content.paint()
        g.restore()
        return canvas
    }

    /** Lay out a text clip; its block is anchored at the clip's position by its alignment. */
    _textContent(g, clip, width, height, m) {
        const px = clip.size * height
        if (px <= 0 || !clip.text) return null
        fontStatus(clip.font, clip.weight, clip.italic)
        g.font = `${clip.italic ? 'italic ' : ''}${clip.weight} ${px}px ${cssFamily(clip.font)}`
        g.letterSpacing = `${(clip.letterSpacing || 0) * px}px`
        g.textBaseline = 'middle'
        g.textAlign = clip.align
        const lines = wrapLines(g, clip.text, clip.maxWidth * width)
        const lineHeight = px * clip.lineHeight
        const metrics = lines.map(line => g.measureText(line))
        const blockW = Math.max(1, ...metrics.map(metric => metric.width))
        const blockH = lines.length * lineHeight
        const left = clip.align === 'left' ? 0 : clip.align === 'right' ? -blockW : -blockW / 2
        const top = -blockH / 2
        let visible = Infinity
        if (m.reveal < 1) visible = Math.floor(m.reveal * lines.reduce((n, line) => n + [...line].length, 0))
        const padX = px * (clip.backgroundPaddingX ?? 0.3)
        const padY = px * (clip.backgroundPaddingY ?? 0.3)
        const boxW = blockW + padX * 2
        const boxH = blockH + padY * 2
        const radius = Math.min(px * (clip.backgroundRadius ?? 0), boxW / 2, boxH / 2)
        const outlineWidth = px * (clip.outline?.width || 0)
        const spread = outlineWidth / 2
        let x0 = Math.min(left - spread, left - (clip.background ? padX : 0))
        let y0 = Math.min(top - spread, top - (clip.background ? padY : 0))
        let x1 = Math.max(left + blockW + spread, left + blockW + (clip.background ? padX : 0))
        let y1 = Math.max(top + blockH + spread, top + blockH + (clip.background ? padY : 0))
        if (clip.shadow) {
            const blur = px * clip.shadow.blur * 2
            x0 = Math.min(x0, left - spread + px * clip.shadow.x - blur)
            y0 = Math.min(y0, top - spread + px * clip.shadow.y - blur)
            x1 = Math.max(x1, left + blockW + spread + px * clip.shadow.x + blur)
            y1 = Math.max(y1, top + blockH + spread + px * clip.shadow.y + blur)
        }
        return {
            left: x0,
            top: y0,
            width: x1 - x0,
            height: y1 - y0,
            paint: () => {
                if (clip.background) {
                    g.fillStyle = clip.background
                    if (radius > 0) {
                        g.beginPath()
                        g.roundRect(left - padX, top - padY, boxW, boxH, radius)
                        g.fill()
                    } else {
                        g.fillRect(left - padX, top - padY, boxW, boxH)
                    }
                }
                const paintText = ctx => {
                    ctx.font = g.font
                    ctx.letterSpacing = g.letterSpacing
                    ctx.textBaseline = g.textBaseline
                    ctx.textAlign = g.textAlign
                    ctx.fillStyle = clip.color
                    ctx.strokeStyle = clip.outline?.color || '#000000'
                    ctx.lineWidth = outlineWidth
                    ctx.lineJoin = 'round'
                    let remaining = visible
                    lines.forEach((line, i) => {
                        if (remaining <= 0) return
                        const chars = [...line]
                        const shown = chars.length > remaining ? chars.slice(0, remaining).join('') : line
                        remaining -= chars.length
                        // A partly typed line keeps the position it has when complete.
                        const x = clip.align === 'left' || shown === line ? 0 : clip.align === 'right' ? -(metrics[i].width - g.measureText(shown).width) : -(metrics[i].width - g.measureText(shown).width) / 2
                        const y = top + lineHeight * (i + 0.5)
                        if (outlineWidth > 0) ctx.strokeText(shown, x, y)
                        ctx.fillText(shown, x, y)
                    })
                }
                g.save()
                if (clip.shadow) {
                    // Shadow the complete glyph block once, so outlines cast filled
                    // shadows and every line's foreground stays above every shadow.
                    const inkLeft = Math.floor(Math.min(...metrics.map(metric => -metric.actualBoundingBoxLeft)) - spread - 2)
                    const inkRight = Math.ceil(Math.max(...metrics.map(metric => metric.actualBoundingBoxRight)) + spread + 2)
                    const inkTop = Math.floor(Math.min(...metrics.map((metric, i) => top + lineHeight * (i + 0.5) - metric.actualBoundingBoxAscent)) - spread - 2)
                    const inkBottom = Math.ceil(Math.max(...metrics.map((metric, i) => top + lineHeight * (i + 0.5) + metric.actualBoundingBoxDescent)) + spread + 2)
                    let layer = this.textLayers.get(clip)
                    if (!layer) {
                        const canvas = document.createElement('canvas')
                        layer = { canvas, ctx: canvas.getContext('2d') }
                        this.textLayers.set(clip, layer)
                    }
                    const w = Math.max(1, inkRight - inkLeft), h = Math.max(1, inkBottom - inkTop)
                    if (layer.canvas.width !== w || layer.canvas.height !== h) {
                        layer.canvas.width = w
                        layer.canvas.height = h
                    }
                    layer.ctx.clearRect(0, 0, w, h)
                    layer.ctx.save()
                    layer.ctx.translate(-inkLeft, -inkTop)
                    paintText(layer.ctx)
                    layer.ctx.restore()
                    const tf = g.getTransform()
                    const x = px * clip.shadow.x, y = px * clip.shadow.y
                    g.shadowColor = clip.shadow.color
                    g.shadowBlur = px * clip.shadow.blur * Math.hypot(tf.a, tf.b)
                    g.shadowOffsetX = tf.a * x + tf.c * y
                    g.shadowOffsetY = tf.b * x + tf.d * y
                    g.drawImage(layer.canvas, inkLeft, inkTop)
                } else paintText(g)
                g.restore()
            },
        }
    }

    /** A small picture of an image or video clip's media at a time, for the timeline; null until it is ready. */
    thumbnail(media, time = 0) {
        if (media.kind === 'image') {
            const entry = this._image(media)
            return entry.status === 'ready' ? entry.image : null
        }
        if (media.kind !== 'video') return null
        const key = `${mediaKey(media)}@${time.toFixed(1)}`
        if (!this.thumbs) this.thumbs = new Map()
        const hit = this.thumbs.get(key)
        if (hit !== undefined) return hit
        this.thumbs.set(key, null)
        if (this.thumbs.size > 600) this.thumbs.delete(this.thumbs.keys().next().value)
        ;(async () => {
            try {
                if (!this.thumbSinks) this.thumbSinks = new Map()
                let sink = this.thumbSinks.get(mediaKey(media))
                if (!sink) {
                    const mb = await import('mediabunny')
                    const input = new mb.Input({ source: new mb.BlobSource(await mediaBlob(media)), formats: mb.ALL_FORMATS })
                    const track = await input.getPrimaryVideoTrack()
                    sink = { sink: new mb.CanvasSink(track, { height: 72 }), chain: Promise.resolve(), first: await track.getFirstTimestamp() }
                    this.thumbSinks.set(mediaKey(media), sink)
                }
                const job = sink.chain.then(() => sink.sink.getCanvas(Math.max(sink.first, time)))
                sink.chain = job.catch(() => {})
                const frame = await job
                if (frame) {
                    this.thumbs.set(key, frame.canvas)
                    this.onThumbnail?.()
                }
            } catch { /* the clip shows no picture */ }
        })()
        return null
    }

    /** What stops a clip drawing, if anything: a missing file or an undecodable video. */
    problemFor(clip) {
        if (clip.type === 'text') return null
        const media = this._media(clip)
        if (!media) return `"${clip.name}" has no media`
        const entry = clip.type === 'image' ? this.images.get(mediaKey(media)) : this.videos.get(mediaKey(media))
        return entry?.error || null
    }
}
