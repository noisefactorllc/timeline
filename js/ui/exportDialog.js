/**
 * The export dialog: choose format, size, range and quality, then watch
 * the render with a live preview of the frames being encoded.
 */

import { registerEscapeable, unregisterEscapeable } from 'handfish'
import { exportSequence, probeCodecs, videoBitrate } from '../export/exporter.js'
import { workRange } from '../model/project.js'
import { formatTimecode, frameCount } from '../model/time.js'

function el(tag, className, attrs = {}) {
    const node = document.createElement(tag)
    if (className) node.className = className
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined) continue
        if (k === 'text') node.textContent = v
        else node.setAttribute(k, v)
    }
    return node
}

function field(label, input) {
    const f = el('label', 'tl-field')
    f.append(el('span', '', { text: label }), input)
    return f
}

function select(options, value) {
    const s = el('select')
    for (const [v, text] of options) s.append(el('option', '', { value: v, text }))
    s.value = value
    return s
}

function fmtTime(seconds) {
    if (!Number.isFinite(seconds)) return '--:--'
    const s = Math.max(0, Math.round(seconds))
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function fileName(project, seq, ext) {
    const base = `${project.name} ${seq.name}`.replace(/[^\p{L}\p{N}\- ]+/gu, '').trim().replace(/\s+/g, '-') || 'timeline'
    return `${base}.${ext}`
}

export class ExportDialog {
    constructor({ store, renderer, pool, audio, actions }) {
        this.store = store
        this.renderer = renderer
        this.pool = pool
        this.audio = audio
        this.actions = actions
        this.dialog = el('dialog', 'hf-dialog tl-dialog', { 'aria-labelledby': 'tl-export-title' })
        document.body.append(this.dialog)
        this.dialog.addEventListener('cancel', e => {
            e.preventDefault()
            this.close()
        })
        this.running = null
        this.lastUrl = null
    }

    open() {
        if (this.dialog.open) return
        this.actions.pause()
        this._renderSettings()
        this.dialog.showModal()
        registerEscapeable(this.dialog, () => this.close())
    }

    close() {
        if (this.running) {
            this.running.abort()
            return
        }
        unregisterEscapeable(this.dialog)
        if (this.dialog.open) this.dialog.close()
        this.actions.redraw()
    }

    _renderSettings() {
        const seq = this.store.seq
        const project = this.store.project
        const hasRange = seq.inPoint !== null || seq.outPoint !== null
        const title = el('h2', 'hf-dialog-title', { id: 'tl-export-title', text: 'Export video' })
        const body = el('div', 'hf-dialog-body')

        const format = select([['mp4', 'MP4 (H.264, AAC)'], ['webm', 'WebM (VP9, Opus)']], 'mp4')
        const sizes = [
            [`${seq.width}x${seq.height}`, `${seq.width} × ${seq.height} (sequence)`],
            [`${Math.round(seq.width / 2)}x${Math.round(seq.height / 2)}`, `${Math.round(seq.width / 2)} × ${Math.round(seq.height / 2)} (half)`],
        ]
        if (seq.height < 2160 && seq.width <= 1920) sizes.push([`${seq.width * 2}x${seq.height * 2}`, `${seq.width * 2} × ${seq.height * 2} (double)`])
        const size = select(sizes, sizes[0][0])
        const range = select([['all', `Whole sequence (${formatTimecode(seq.duration, seq.fps)})`], ...(hasRange ? [['inout', 'In to out']] : [])], hasRange ? 'inout' : 'all')
        const quality = select([['medium', 'Medium'], ['high', 'High'], ['best', 'Best']], 'high')
        const withAudio = el('input', '', { type: 'checkbox' })
        withAudio.checked = true
        const canStream = typeof window.showSaveFilePicker === 'function'
        const stream = el('input', '', { type: 'checkbox' })
        stream.checked = canStream
        const grid = el('div', 'tl-field-grid')
        grid.append(field('Format', format), field('Size', size), field('Range', range), field('Quality', quality), field('Include audio', withAudio))
        if (canStream) grid.append(field('Write to disk while rendering', stream))
        const note = el('p', 'tl-export-note')
        const update = async () => {
            const [w, h] = size.value.split('x').map(Number)
            const r = range.value === 'inout' ? workRange(seq) : { start: 0, end: seq.duration }
            const frames = frameCount(r.end - r.start, seq.fps)
            note.dataset.state = ''
            note.textContent = `${frames} frames at ${seq.fps} fps, ${formatTimecode(r.end - r.start, seq.fps)}. Checking codecs`
            const codecs = await probeCodecs(format.value, w, h, seq.fps)
            if (!codecs.video) {
                note.dataset.state = 'error'
                note.textContent = `This browser cannot encode ${format.value.toUpperCase()} video at this size. Try WebM or a smaller size.`
                start.disabled = true
                return
            }
            start.disabled = false
            const a = withAudio.checked ? (codecs.audio ? codecs.audio.toUpperCase() : 'no audio encoder here, video only') : 'no audio'
            const mbps = videoBitrate(quality.value, w, h, seq.fps) / 1e6
            const mb = Math.round(mbps * (r.end - r.start) / 8 + (withAudio.checked ? 0.024 * (r.end - r.start) : 0))
            note.textContent = `${frames} frames at ${seq.fps} fps, ${formatTimecode(r.end - r.start, seq.fps)}. ${codecs.video.toUpperCase()} video at ${mbps.toFixed(1)} Mbps, ${a}. About ${mb} MB.`
        }
        for (const s of [format, size, range, quality, withAudio]) s.addEventListener('change', update)
        body.append(grid, note)

        const actions = el('div', 'tl-dialog-actions')
        const cancel = el('button', 'tl-button', { type: 'button', text: 'Cancel' })
        cancel.addEventListener('click', () => this.close())
        const start = el('button', 'tl-button is-primary', { type: 'button', text: 'Export' })
        start.addEventListener('click', async () => {
            const [w, h] = size.value.split('x').map(Number)
            const r = range.value === 'inout' ? workRange(seq) : { start: 0, end: seq.duration }
            const ext = format.value
            let fileHandle = null
            if (canStream && stream.checked) {
                try {
                    fileHandle = await window.showSaveFilePicker({
                        suggestedName: fileName(project, seq, ext),
                        types: [{ description: ext.toUpperCase(), accept: { [ext === 'mp4' ? 'video/mp4' : 'video/webm']: [`.${ext}`] } }],
                    })
                } catch (err) {
                    if (err?.name === 'AbortError') return
                    fileHandle = null
                }
            }
            this._run({
                format: format.value, width: w, height: h, start: r.start, end: r.end,
                quality: quality.value, includeAudio: withAudio.checked,
            }, fileHandle)
        })
        actions.append(cancel, start)
        this.dialog.replaceChildren(title, body, actions)
        update()
        start.focus()
    }

    async _run(settings, fileHandle) {
        const seq = this.store.seq
        const project = this.store.project
        const title = el('h2', 'hf-dialog-title', { id: 'tl-export-title', text: `Exporting ${seq.name}` })
        const body = el('div', 'hf-dialog-body')
        const preview = el('canvas', 'tl-export-preview')
        preview.width = 320
        preview.height = Math.round(320 * settings.height / settings.width)
        const pctx = preview.getContext('2d')
        const bar = el('div', 'tl-progress')
        const fill = el('div')
        bar.append(fill)
        const stats = el('div', 'tl-export-stats')
        const left = el('span', '', { text: 'Starting' })
        const right = el('span')
        stats.append(left, right)
        const note = el('p', 'tl-export-note', { text: 'Every frame renders exactly; this can take longer than real time.' })
        body.append(preview, bar, stats, note)
        const actions = el('div', 'tl-dialog-actions')
        const cancel = el('button', 'tl-button', { type: 'button', text: 'Cancel export' })
        actions.append(cancel)
        this.dialog.replaceChildren(title, body, actions)

        const controller = new AbortController()
        this.running = controller
        cancel.addEventListener('click', () => controller.abort())
        let lastPreview = 0
        try {
            const result = await exportSequence({
                seq, project, renderer: this.renderer, pool: this.pool, audio: this.audio, settings, fileHandle,
                signal: controller.signal,
                onProgress: p => {
                    if (p.phase === 'warning') {
                        note.textContent = p.message
                        return
                    }
                    if (p.phase === 'preroll') {
                        left.textContent = `Pre-rolling ${p.done} of ${p.total}`
                        return
                    }
                    if (p.phase === 'finalize') {
                        left.textContent = 'Finishing the file'
                        return
                    }
                    fill.style.setProperty('--p', String(p.done / p.total))
                    left.textContent = `Frame ${p.done} of ${p.total}`
                    right.textContent = `${fmtTime(p.elapsed)} elapsed, ${fmtTime(p.eta)} left`
                    const now = performance.now()
                    if (now - lastPreview > 120) {
                        lastPreview = now
                        pctx.drawImage(p.canvas, 0, 0, preview.width, preview.height)
                    }
                },
            })
            this.running = null
            this._done(result, settings, fileHandle)
        } catch (err) {
            this.running = null
            if (err?.name === 'AbortError') {
                this._renderSettings()
                return
            }
            console.error('[timeline] export failed', err)
            note.dataset.state = 'error'
            note.textContent = `Export failed: ${err?.message || err}`
            cancel.textContent = 'Close'
            cancel.onclick = () => this.close()
        }
        this.actions.redraw()
    }

    _done(result, settings, fileHandle) {
        const seq = this.store.seq
        const project = this.store.project
        const title = el('h2', 'hf-dialog-title', { id: 'tl-export-title', text: 'Export finished' })
        const body = el('div', 'hf-dialog-body')
        const audioText = result.audioCodec ? `${result.audioCodec.toUpperCase()} audio` : 'no audio'
        const actions = el('div', 'tl-dialog-actions')
        const again = el('button', 'tl-button', { type: 'button', text: 'Export again' })
        again.addEventListener('click', () => this._renderSettings())
        const close = el('button', 'tl-button', { type: 'button', text: 'Close' })
        close.addEventListener('click', () => this.close())
        actions.append(again)
        if (result.blob) {
            if (this.lastUrl) URL.revokeObjectURL(this.lastUrl)
            this.lastUrl = URL.createObjectURL(result.blob)
            const video = el('video', 'tl-export-preview', { controls: '', src: this.lastUrl, playsinline: '' })
            body.append(video)
            const mb = (result.blob.size / 1048576).toFixed(1)
            body.append(el('p', 'tl-export-note', { text: `${result.frames} frames, ${result.videoCodec.toUpperCase()} video, ${audioText}, ${mb} MB.` }))
            const name = fileName(project, seq, settings.format)
            const download = el('a', 'tl-button is-primary', { href: this.lastUrl, download: name, text: 'Download video' })
            actions.append(close, download)
        } else {
            body.append(el('p', 'tl-export-note', { text: `Saved ${fileHandle?.name || 'the video'}: ${result.frames} frames, ${result.videoCodec.toUpperCase()} video, ${audioText}.` }))
            actions.append(close)
        }
        this.dialog.replaceChildren(title, body, actions)
        this.lastResult = result
    }
}
