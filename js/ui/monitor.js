/**
 * The program monitor: the rendered frame, the timecode, and meters that
 * show what `audio()` reads right now from the mix and from each audio
 * track, the same values the programs see.
 */

import { formatTimecode } from '../model/time.js'
import { workRange } from '../model/project.js'

function el(tag, className, text) {
    const node = document.createElement(tag)
    if (className) node.className = className
    if (text !== undefined) node.textContent = text
    return node
}

export class MonitorView {
    constructor(root, { store, onScale, onFullscreen }) {
        this.root = root
        this.store = store
        const frame = el('div', 'tl-monitor-frame')
        this.canvas = el('canvas', 'tl-monitor-canvas')
        this.canvas.setAttribute('aria-label', 'Rendered frame')
        this.ctx = this.canvas.getContext('2d', { alpha: false })
        frame.append(this.canvas)
        const overlay = el('div', 'tl-monitor-overlay')
        this.badge = el('div', 'tl-monitor-badge')
        this.badge.hidden = true
        overlay.append(this.badge)
        frame.append(overlay)

        const bar = el('div', 'tl-monitor-bar')
        this.tc = el('div', 'tl-timecode', '00:00:00:00')
        this.info = el('div', 'tl-timecode-sub')
        this.meters = el('div', 'tl-meters')
        this.meters.setAttribute('aria-label', 'Audio levels that audio() reads')
        const scale = el('select', 'tl-select')
        scale.setAttribute('aria-label', 'Playback resolution')
        for (const [value, label] of [['1', 'Full'], ['0.5', 'Half'], ['0.25', 'Quarter']]) {
            const o = el('option', '', label)
            o.value = value
            scale.append(o)
        }
        scale.value = String(store.view.previewScale)
        scale.addEventListener('change', () => onScale(Number(scale.value)))
        this.scaleSelect = scale
        const full = el('button', 'tl-tool')
        full.type = 'button'
        full.title = 'Full screen (F)'
        full.setAttribute('aria-label', 'Full screen')
        full.append(el('span', 'hf-icon', 'fullscreen'))
        full.addEventListener('click', onFullscreen)
        bar.append(this.tc, this.info, el('div', 'tl-spacer'), this.meters, scale, full)
        root.replaceChildren(frame, bar)
        this.frameEl = frame
        this._meterRows = []

        new ResizeObserver(() => this._fit()).observe(frame)
        store.on('playhead', () => this.updateTime())
        store.on('project', () => this._sequenceChanged())
        store.on('view', () => { this.scaleSelect.value = String(store.view.previewScale) })
        this._sequenceChanged()
    }

    _sequenceChanged() {
        const seq = this.store.seq
        if (!seq) return
        this.info.replaceChildren(...[seq.name, `${seq.width}×${seq.height}`, `${seq.fps} fps`, `${seq.bpm} bpm`].map(t => el('span', '', t)))
        this._buildMeters(seq)
        this._fit()
        this.updateTime()
    }

    _buildMeters(seq) {
        const sources = [{ label: 'Mix', key: 'mix' }, ...seq.audioTracks.map((t, i) => ({ label: t.name, key: i + 1 }))]
        const signature = sources.map(s => s.label).join('|')
        if (signature === this._meterSignature) return
        this._meterSignature = signature
        this.meters.replaceChildren()
        this._meterRows = sources.map(src => {
            const group = el('div', 'tl-meter-group')
            group.title = src.key === 'mix' ? 'audio(band: ...)' : `audio(band: ..., channel: ${src.key})`
            const bars = el('div', 'tl-meter-bars')
            const cells = ['low', 'mid', 'high'].map(band => {
                const b = el('div', 'tl-meter-bar')
                b.dataset.band = band
                bars.append(b)
                return b
            })
            group.append(bars, el('div', 'tl-meter-label', src.label))
            this.meters.append(group)
            return { src, cells }
        })
    }

    /** Show live levels from the engine AudioState. */
    updateMeters(state) {
        for (const { src, cells } of this._meterRows) {
            const s = src.key === 'mix' ? state : state.getDefaultChannelState?.(src.key)
            const values = s ? [s.low, s.mid, s.high] : [0, 0, 0]
            cells.forEach((c, i) => c.style.setProperty('--level', String(Math.max(0, Math.min(1, values[i] || 0)).toFixed(3))))
        }
    }

    updateTime() {
        const seq = this.store.seq
        if (!seq) return
        this.tc.textContent = formatTimecode(this.store.playhead, seq.fps)
        const range = workRange(seq)
        if (seq.inPoint !== null || seq.outPoint !== null) {
            this.badge.hidden = false
            this.badge.textContent = `In ${formatTimecode(range.start, seq.fps)}  Out ${formatTimecode(range.end, seq.fps)}`
        } else {
            this.badge.hidden = true
        }
    }

    _fit() {
        const seq = this.store.seq
        if (!seq) return
        const box = this.frameEl.getBoundingClientRect()
        const pad = 28
        const availW = Math.max(10, box.width - pad)
        const availH = Math.max(10, box.height - pad + 8)
        const aspect = seq.width / seq.height
        let w = availW
        let h = w / aspect
        if (h > availH) {
            h = availH
            w = h * aspect
        }
        this.canvas.style.width = `${Math.floor(w)}px`
        this.canvas.style.height = `${Math.floor(h)}px`
    }

    /** Draw a rendered frame. */
    draw(source) {
        if (this.canvas.width !== source.width || this.canvas.height !== source.height) {
            this.canvas.width = source.width
            this.canvas.height = source.height
        }
        this.ctx.drawImage(source, 0, 0)
    }
}
