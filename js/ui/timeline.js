/**
 * The timeline panel: editing toolbar, ruler, markers, track lanes with
 * clips, transitions and the post lane, and the playhead.
 *
 * Video tracks stack upper over lower, so V1 is drawn at the bottom of the
 * video block. Clips show frames of their own program along their length.
 * Drags preview with transforms and commit as one undoable edit when the
 * pointer is released.
 */

import { clipEnd, findClip, createProgramClip, createSequenceClip, createAudioClip, wouldCreateCycle } from '../model/project.js'
import { transitionSpan } from '../model/evaluate.js'
import { moveClips, trimClip, setTransitionDuration, addTransition, cutNear, insertClip, addMarker } from '../model/edit.js'
import { formatTimecode, formatRulerLabel, barSeconds, beatSeconds, loopPhase, clamp } from '../model/time.js'
import { transitionPreset, postPreset } from '../data/presets.js'
import { THUMB_W, THUMB_H } from '../render/thumbnails.js'
import { cachedAudioBuffer, waveformPeaks } from '../audio/media.js'
import { showContextMenu } from './contextMenu.js'
import { TRANSITIONS } from '../data/presets.js'
import { splitClip, deleteTransition } from '../model/edit.js'

const SNAP_PX = 8
const DRAG_THRESHOLD = 3
const MIN_PPS = 2
const MAX_PPS = 600

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

function icon(name) {
    return el('span', 'hf-icon', { text: name, 'aria-hidden': 'true' })
}

export function loopLabel(loop, seq) {
    const bar = barSeconds(seq.bpm, seq.beatsPerBar)
    const beat = beatSeconds(seq.bpm)
    const bars = loop / bar
    if (Math.abs(bars - Math.round(bars)) < 1e-3 && bars >= 1) return `${Math.round(bars)} bar${Math.round(bars) === 1 ? '' : 's'}`
    const beats = loop / beat
    if (Math.abs(beats - Math.round(beats)) < 1e-3) return `${Math.round(beats)} beat${Math.round(beats) === 1 ? '' : 's'}`
    return `${loop.toFixed(1)}s`
}

/** The DSL effects a post chain applies, for its lane label. */
export function chainSummary(dsl) {
    const names = []
    const re = /\.([a-zA-Z][a-zA-Z0-9]*)\s*\(/g
    let m
    while ((m = re.exec(dsl))) {
        if (!['write', 'subchain'].includes(m[1])) names.push(m[1])
    }
    return names.length ? names.join(' › ') : 'pass-through'
}

export class TimelineView {
    constructor(root, { store, thumbs, pool, actions, audio }) {
        this.root = root
        this.store = store
        this.thumbs = thumbs
        this.pool = pool
        this.actions = actions
        this.audio = audio
        this.drag = null
        this._stripRaf = 0
        this._build()
        store.on('project', () => this.render())
        store.on('selection', () => this.render())
        store.on('view', () => this.render())
        store.on('playhead', () => this.updatePlayhead())
        thumbs.onReady(() => this._scheduleStrips())
        pool.compiledListeners.add((entry, result) => {
            if (!result.success || entry.hadError) this.render()
            entry.hadError = !result.success
        })
    }

    get pps() {
        return this.store.view.pxPerSecond
    }

    // --- skeleton ----------------------------------------------------------

    _build() {
        const root = this.root
        root.replaceChildren()

        const toolbar = el('div', 'tl-toolbar', { role: 'toolbar', 'aria-label': 'Editing tools' })
        const tool = (iconName, label, onClick, extra = {}) => {
            const b = el('button', `tl-tool ${extra.className || ''}`, { type: 'button', 'aria-label': label, 'data-title': label, title: label })
            b.append(icon(iconName))
            if (extra.pressed !== undefined) b.setAttribute('aria-pressed', String(extra.pressed))
            b.addEventListener('click', onClick)
            toolbar.append(b)
            return b
        }
        tool('content_cut', 'Cut at playhead (Cmd+K)', () => this.actions.cutAtPlayhead())
        tool('join', 'Add transition at the nearest cut (Cmd+D)', () => this.actions.addTransitionAtPlayhead())
        tool('bookmark_add', 'Add marker (M)', () => this.actions.addMarker())
        tool('login', 'Set in point (I)', () => this.actions.setIn())
        tool('logout', 'Set out point (O)', () => this.actions.setOut())
        toolbar.append(el('div', 'tl-toolbar-sep'))
        this.snapBtn = tool('align_horizontal_center', 'Snapping (S)', () => this.store.setView({ snapping: !this.store.view.snapping }), { pressed: true })
        this.gridBtn = tool('grid_4x4', 'Beat grid (G)', () => this.store.setView({ beatGrid: !this.store.view.beatGrid }), { pressed: true })
        toolbar.append(el('div', 'tl-spacer'))
        tool('zoom_out', 'Zoom out (-)', () => this.zoomBy(1 / 1.5))
        this.zoomInput = el('input', 'tl-zoom', { type: 'range', min: '0', max: '1000', 'aria-label': 'Zoom' })
        this.zoomInput.addEventListener('input', () => {
            const v = Number(this.zoomInput.value) / 1000
            this.setZoom(MIN_PPS * Math.pow(MAX_PPS / MIN_PPS, v))
        })
        toolbar.append(this.zoomInput)
        tool('zoom_in', 'Zoom in (=)', () => this.zoomBy(1.5))
        tool('fit_screen', 'Fit sequence (\\)', () => this.zoomToFit())

        const body = el('div', 'tl-body')
        const headers = el('div', 'tl-headers')
        this.headerSpacer = el('div', 'tl-header-spacer')
        const addV = el('button', 'tl-track-btn', { type: 'button', title: 'Add video track', 'aria-label': 'Add video track' })
        addV.append(icon('add'))
        addV.addEventListener('click', () => this.actions.addTrack('visual'))
        const addA = el('button', 'tl-track-btn', { type: 'button', title: 'Add audio track', 'aria-label': 'Add audio track' })
        addA.append(icon('graphic_eq'))
        addA.addEventListener('click', () => this.actions.addTrack('audio'))
        this.headerSpacer.append(el('span', 'tl-track-name', { text: 'Tracks' }), addV, addA)
        this.headersViewport = el('div', 'tl-headers-viewport')
        this.headersViewport.style.cssText = 'position:relative;overflow:hidden;height:calc(100% - var(--tl-ruler-h) - var(--tl-marker-h))'
        this.headersInner = el('div', 'tl-headers-inner')
        this.headersViewport.append(this.headersInner)
        headers.append(this.headerSpacer, this.headersViewport)

        this.scroll = el('div', 'tl-scroll')
        this.content = el('div', 'tl-content')
        this.ruler = el('div', 'tl-ruler', { 'aria-label': 'Ruler: click or drag to move the playhead' })
        this.rulerCanvas = el('canvas')
        this.ruler.append(this.rulerCanvas)
        this.markersEl = el('div', 'tl-markers')
        this.lanes = el('div', 'tl-lanes')
        this.content.append(this.ruler, this.markersEl, this.lanes)
        this.scroll.append(this.content)
        body.append(headers, this.scroll)
        root.append(toolbar, body)

        this.playheadEl = el('div', 'tl-playhead')
        const cap = el('span', 'tl-playhead-cap')
        this.playheadEl.append(cap)
        this.snapEl = el('div', 'tl-snapline', { hidden: '' })

        this.scroll.addEventListener('scroll', () => {
            this.headersInner.style.transform = `translateY(${-this.scroll.scrollTop}px)`
            this.store.view.scrollX = this.scroll.scrollLeft
            this._drawRuler()
            this._scheduleStrips()
        })
        this.scroll.addEventListener('wheel', e => this._onWheel(e), { passive: false })
        this.ruler.addEventListener('pointerdown', e => this._onRulerDown(e))
        cap.addEventListener('pointerdown', e => this._onRulerDown(e))
        this.lanes.addEventListener('pointerdown', e => this._onLanesDown(e))
        this.lanes.addEventListener('dblclick', e => this._onDblClick(e))
        this.lanes.addEventListener('contextmenu', e => this._onContextMenu(e))
        this.lanes.addEventListener('dragover', e => this._onDragOver(e))
        this.lanes.addEventListener('dragleave', e => this._onDragLeave(e))
        this.lanes.addEventListener('drop', e => this._onDrop(e))
        new ResizeObserver(() => {
            this._sizeContent()
            this._drawRuler()
            this._scheduleStrips()
        }).observe(this.scroll)
    }

    // --- coordinates -------------------------------------------------------

    timeToX(t) {
        return t * this.pps
    }

    xToTime(clientX) {
        const rect = this.scroll.getBoundingClientRect()
        return (clientX - rect.left + this.scroll.scrollLeft) / this.pps
    }

    _sizeContent() {
        const seq = this.store.seq
        if (!seq) return
        const w = Math.max(this.scroll.clientWidth, this.timeToX(seq.duration) + 240)
        this.content.style.width = `${w}px`
    }

    // --- rendering -----------------------------------------------------------

    render() {
        const seq = this.store.seq
        if (!seq) return
        this._sizeContent()
        this.snapBtn.setAttribute('aria-pressed', String(this.store.view.snapping))
        this.gridBtn.setAttribute('aria-pressed', String(this.store.view.beatGrid))
        this.zoomInput.value = String(Math.round(1000 * Math.log(this.pps / MIN_PPS) / Math.log(MAX_PPS / MIN_PPS)))
        const bar = barSeconds(seq.bpm, seq.beatsPerBar) * this.pps
        const beat = beatSeconds(seq.bpm) * this.pps
        this.root.style.setProperty('--tl-bar-px', `${bar}px`)
        this.root.style.setProperty('--tl-beat-px', `${beat >= 6 ? beat : bar}px`)
        this.root.style.setProperty('--tl-grid-x', `${(seq.gridOffset || 0) * this.pps}px`)

        this._renderHeaders(seq)
        this._renderLanes(seq)
        this._renderMarkers(seq)
        this._drawRuler()
        this.updatePlayhead()
        this._scheduleStrips()
    }

    _orderedLanes(seq) {
        const lanes = []
        for (let i = seq.tracks.length - 1; i >= 0; i--) lanes.push({ kind: 'video', track: seq.tracks[i], index: i })
        seq.audioTracks.forEach((track, i) => lanes.push({ kind: 'audio', track, index: i }))
        lanes.push({ kind: 'post' })
        return lanes
    }

    _renderHeaders(seq) {
        const sel = this.store.selection
        const frag = document.createDocumentFragment()
        for (const lane of this._orderedLanes(seq)) {
            if (lane.kind === 'post') {
                const h = el('div', 'tl-track-header is-post')
                const name = el('span', 'tl-track-name', { text: 'Post' })
                const toggle = el('button', 'tl-track-btn', {
                    type: 'button',
                    'aria-pressed': String(!!seq.post?.enabled),
                    'aria-label': 'Post chain on',
                    title: 'Turn the post chain on or off',
                })
                toggle.append(icon('auto_awesome'))
                toggle.addEventListener('click', e => {
                    e.stopPropagation()
                    this.store.edit('Toggle post chain', s => { s.post.enabled = !s.post.enabled })
                })
                h.append(name, toggle)
                h.addEventListener('click', () => this.store.selectPost())
                frag.append(h)
                continue
            }
            const { track } = lane
            const h = el('div', `tl-track-header is-${lane.kind}${sel.track === track.id ? ' is-target' : ''}`)
            const name = el('span', 'tl-track-name', { text: track.name })
            if (lane.kind === 'audio') {
                name.append(el('span', 'tl-track-sub', { text: `channel: ${lane.index + 1}` }))
            }
            h.append(name)
            const btn = (kind, label, pressed, iconName, onClick) => {
                const b = el('button', 'tl-track-btn', { type: 'button', 'aria-pressed': String(pressed), 'aria-label': label, title: label, 'data-kind': kind })
                if (iconName) b.append(icon(iconName))
                else b.textContent = kind === 'mute' ? 'M' : 'S'
                b.addEventListener('click', e => {
                    e.stopPropagation()
                    onClick()
                })
                h.append(b)
            }
            if (lane.kind === 'video') {
                btn('hide', `Hide ${track.name}`, track.hidden, track.hidden ? 'visibility_off' : 'visibility', () =>
                    this.store.edit('Toggle track visibility', s => { s.tracks.find(t => t.id === track.id).hidden = !track.hidden }))
                btn('lock', `Lock ${track.name}`, track.locked, track.locked ? 'lock' : 'lock_open', () =>
                    this.store.edit('Toggle track lock', s => { s.tracks.find(t => t.id === track.id).locked = !track.locked }))
            } else {
                btn('mute', `Mute ${track.name}`, track.muted, null, () =>
                    this.store.edit('Toggle mute', s => { s.audioTracks.find(t => t.id === track.id).muted = !track.muted }))
                btn('solo', `Solo ${track.name}`, track.solo, null, () =>
                    this.store.edit('Toggle solo', s => { s.audioTracks.find(t => t.id === track.id).solo = !track.solo }))
            }
            h.addEventListener('click', () => this.store.setTargetTrack(track.id))
            h.addEventListener('dblclick', () => this.actions.renameTrack(track.id))
            frag.append(h)
        }
        this.headersInner.replaceChildren(frag)
    }

    _renderLanes(seq) {
        const sel = this.store.selection
        const frag = document.createDocumentFragment()
        this._clipEls = new Map()
        for (const lane of this._orderedLanes(seq)) {
            const laneEl = el('div', `tl-lane is-${lane.kind}`)
            laneEl.dataset.kind = lane.kind
            if (lane.track) {
                laneEl.dataset.trackId = lane.track.id
                if (sel.track === lane.track.id) laneEl.classList.add('is-target')
                if (lane.track.hidden) laneEl.classList.add('is-hidden-track')
            }
            if (this.store.view.beatGrid && lane.kind !== 'post') laneEl.append(el('div', 'tl-grid'))
            if (lane.kind === 'post') {
                const post = seq.post || {}
                const b = el('button', `tl-post${post.enabled ? '' : ' is-off'}${sel.post ? ' is-selected' : ''}`, {
                    type: 'button',
                    'aria-label': 'Post chain',
                })
                b.style.width = `${Math.max(40, this.timeToX(seq.duration))}px`
                b.dataset.post = '1'
                b.append(icon('auto_awesome'), el('span', '', { text: post.enabled ? postPreset(post.preset).name : 'Post off' }),
                    el('span', 'tl-post-chain', { text: chainSummary(post.dsl || '') }))
                laneEl.append(b)
            } else if (lane.kind === 'video') {
                for (const clip of lane.track.clips) laneEl.append(this._clipEl(seq, clip, 'video'))
                for (const transition of lane.track.transitions) {
                    const tEl = this._transitionEl(lane.track, transition)
                    if (tEl) laneEl.append(tEl)
                }
            } else {
                for (const clip of lane.track.clips) laneEl.append(this._clipEl(seq, clip, 'audio'))
            }
            frag.append(laneEl)
        }
        const range = seq.inPoint !== null || seq.outPoint !== null
        if (range) {
            const inT = seq.inPoint ?? 0
            const outT = seq.outPoint ?? seq.duration
            const inout = el('div', 'tl-inout')
            inout.style.left = `${this.timeToX(inT)}px`
            inout.style.width = `${this.timeToX(outT - inT)}px`
            inout.style.top = '0'
            inout.style.height = '3px'
            frag.append(inout)
            const dimL = el('div', 'tl-inout-dim')
            dimL.style.left = '0'
            dimL.style.width = `${this.timeToX(inT)}px`
            const dimR = el('div', 'tl-inout-dim')
            dimR.style.left = `${this.timeToX(outT)}px`
            dimR.style.width = `${Math.max(0, this.timeToX(seq.duration - outT))}px`
            frag.append(dimL, dimR)
        }
        if (!seq.tracks.some(t => t.clips.length) && !seq.audioTracks.some(t => t.clips.length)) {
            const empty = el('div', 'tl-lanes-empty')
            empty.append(el('strong', '', { text: 'This sequence is empty' }),
                document.createTextNode('Drag a program from the library onto a video track, and drop a song anywhere on the window to add audio.'))
            frag.append(empty)
        }
        const end = el('div', 'tl-seq-end')
        end.style.left = `${this.timeToX(seq.duration)}px`
        end.style.right = '0'
        frag.append(end, this.playheadEl, this.snapEl)
        this.lanes.replaceChildren(frag)
    }

    _clipEl(seq, clip, kind) {
        const sel = this.store.selection
        const node = el('div', `tl-clip${kind === 'audio' ? ' is-audio' : ''}${clip.type === 'sequence' ? ' is-sequence' : ''}`, {
            tabindex: '0',
            role: 'button',
            'aria-label': `${clip.name}, ${formatTimecode(clip.start, seq.fps)}`,
        })
        node.dataset.clipId = clip.id
        if (sel.clips.has(clip.id)) node.classList.add('is-selected')
        if (clip.tint) node.style.setProperty('--tint', clip.tint)
        if (clip.type === 'sequence') {
            const child = this.store.project.sequences[clip.sequenceId]
            const tint = child?.tracks.flatMap(t => t.clips).find(c => c.tint)?.tint
            if (tint) node.style.setProperty('--tint', tint)
        }
        if (clip.type === 'program' && this.pool.errorFor(clip.dsl)) node.classList.add('is-error')
        node.style.left = `${this.timeToX(clip.start)}px`
        node.style.width = `${Math.max(2, this.timeToX(clip.duration))}px`

        if (kind === 'audio') {
            const wave = el('canvas', 'tl-clip-wave')
            node.append(wave)
        } else if (clip.type === 'program') {
            const strip = el('canvas', 'tl-clip-strip')
            node.append(strip)
        }
        const label = el('div', 'tl-clip-label')
        label.append(el('span', 'tl-clip-name', { text: clip.name }))
        if (kind === 'video') {
            if (clip.type === 'sequence') {
                const tag = el('span', 'tl-clip-tag')
                tag.append(icon('layers'), document.createTextNode(' nested'))
                label.append(tag)
            } else {
                label.append(el('span', 'tl-clip-tag', { text: loopLabel(clip.loop, seq) }))
                if (/audio\s*\(/.test(clip.dsl)) {
                    const tag = el('span', 'tl-clip-tag', { title: 'Reads audio()' })
                    tag.append(icon('graphic_eq'))
                    label.append(tag)
                }
            }
            if (clip.blend && clip.blend !== 'normal') label.append(el('span', 'tl-clip-tag', { text: clip.blend }))
        }
        node.append(label)
        node.append(el('div', 'tl-clip-handle is-start', { 'data-edge': 'start' }), el('div', 'tl-clip-handle is-end', { 'data-edge': 'end' }))
        this._clipEls.set(clip.id, { node, clip, kind })
        return node
    }

    _transitionEl(track, transition) {
        const span = transitionSpan(track, transition)
        if (!span) return null
        const sel = this.store.selection
        const node = el('button', `tl-transition${sel.transition === transition.id ? ' is-selected' : ''}`, {
            type: 'button',
            'aria-label': `${transitionPreset(transition.preset).name} transition`,
            title: `${transitionPreset(transition.preset).name}, ${transition.duration.toFixed(2)}s`,
        })
        node.dataset.transitionId = transition.id
        node.dataset.trackId = track.id
        node.style.left = `${this.timeToX(span.start)}px`
        node.style.width = `${Math.max(8, this.timeToX(span.end - span.start))}px`
        if (span.a?.tint) node.style.setProperty('--a', span.a.tint)
        if (span.b?.tint) node.style.setProperty('--b', span.b.tint)
        const label = transition.from && transition.to ? transitionPreset(transition.preset).name : transition.from ? 'Fade out' : 'Fade in'
        node.append(el('span', '', { text: label }))
        node.append(el('div', 'tl-transition-handle is-start', { 'data-edge': 'start' }), el('div', 'tl-transition-handle is-end', { 'data-edge': 'end' }))
        return node
    }

    _renderMarkers(seq) {
        const frag = document.createDocumentFragment()
        for (const marker of seq.markers) {
            const b = el('button', 'tl-marker', {
                type: 'button',
                'aria-selected': String(this.store.selection.marker === marker.id),
                title: `${marker.name}, ${formatTimecode(marker.time, seq.fps)}`,
                text: marker.name,
            })
            b.style.left = `${this.timeToX(marker.time)}px`
            b.dataset.markerId = marker.id
            b.addEventListener('pointerdown', e => this._onMarkerDown(e, marker))
            frag.append(b)
        }
        this.markersEl.replaceChildren(frag)
    }

    _drawRuler() {
        const seq = this.store.seq
        if (!seq) return
        const canvas = this.rulerCanvas
        const dpr = window.devicePixelRatio || 1
        const viewW = this.scroll.clientWidth
        const h = this.ruler.clientHeight || 30
        const left = this.scroll.scrollLeft
        canvas.style.left = `${left}px`
        canvas.style.width = `${viewW}px`
        if (canvas.width !== Math.round(viewW * dpr) || canvas.height !== Math.round(h * dpr)) {
            canvas.width = Math.round(viewW * dpr)
            canvas.height = Math.round(h * dpr)
        }
        const g = canvas.getContext('2d')
        g.setTransform(dpr, 0, 0, dpr, 0, 0)
        g.clearRect(0, 0, viewW, h)
        const styles = getComputedStyle(this.root)
        const dim = styles.getPropertyValue('--hf-text-dim').trim() || '#999'
        const muted = styles.getPropertyValue('--hf-text-muted').trim() || '#555'
        const inoutColor = styles.getPropertyValue('--hf-blue').trim() || '#48f'
        const pps = this.pps
        const t0 = left / pps
        const t1 = (left + viewW) / pps

        if (seq.inPoint !== null || seq.outPoint !== null) {
            const a = ((seq.inPoint ?? 0) * pps) - left
            const b = ((seq.outPoint ?? seq.duration) * pps) - left
            g.globalAlpha = 0.35
            g.fillStyle = inoutColor
            g.fillRect(a, h - 6, b - a, 6)
            g.globalAlpha = 1
        }

        const useBars = this.store.view.beatGrid
        g.font = '10px "Noto Sans Mono", "Noto Sans Mono Blank"'
        g.textBaseline = 'top'
        if (useBars) {
            const bar = barSeconds(seq.bpm, seq.beatsPerBar)
            const beat = beatSeconds(seq.bpm)
            const off = seq.gridOffset || 0
            let every = 1
            while (bar * every * pps < 56) every *= 2
            const firstBar = Math.floor((t0 - off) / bar)
            for (let i = firstBar; off + i * bar <= t1; i++) {
                if (i < 0) continue
                const x = (off + i * bar) * pps - left
                const major = i % every === 0
                g.fillStyle = major ? dim : muted
                g.fillRect(Math.round(x), major ? 12 : 20, 1, major ? h - 12 : h - 20)
                if (major) g.fillText(`${i + 1}`, Math.round(x) + 4, 3)
                if (beat * pps >= 10) {
                    g.fillStyle = muted
                    for (let b = 1; b < seq.beatsPerBar; b++) {
                        const bx = (off + i * bar + b * beat) * pps - left
                        g.fillRect(Math.round(bx), h - 6, 1, 6)
                    }
                }
            }
            g.fillStyle = muted
            g.textAlign = 'right'
            g.fillText(formatRulerLabel(t0, 1), viewW - 6, 3)
            g.textAlign = 'left'
        } else {
            const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300]
            const step = steps.find(s => s * pps >= 70) || 600
            const minor = step / 5
            for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
                if (t < 0) continue
                const x = t * pps - left
                const isMajor = Math.abs(t / step - Math.round(t / step)) < 1e-6
                g.fillStyle = isMajor ? dim : muted
                g.fillRect(Math.round(x), isMajor ? 12 : 22, 1, isMajor ? h - 12 : h - 22)
                if (isMajor) g.fillText(formatRulerLabel(t, step), Math.round(x) + 4, 3)
            }
        }
    }

    updatePlayhead() {
        const seq = this.store.seq
        if (!seq) return
        const t = this.store.playhead
        this.playheadEl.style.left = `${this.timeToX(t)}px`
        if (this.store.playing) {
            const x = this.timeToX(t)
            const viewW = this.scroll.clientWidth
            const left = this.scroll.scrollLeft
            if (x > left + viewW * 0.85 || x < left) this.scroll.scrollLeft = Math.max(0, x - viewW * 0.15)
        }
    }

    // --- filmstrips and waveforms ---------------------------------------------

    _scheduleStrips() {
        if (this._stripRaf) return
        this._stripRaf = requestAnimationFrame(() => {
            this._stripRaf = 0
            this._drawStrips()
        })
    }

    _drawStrips() {
        const seq = this.store.seq
        if (!seq || !this._clipEls) return
        const left = this.scroll.scrollLeft
        const viewW = this.scroll.clientWidth
        const dpr = Math.min(2, window.devicePixelRatio || 1)
        for (const { node, clip, kind } of this._clipEls.values()) {
            const x0 = this.timeToX(clip.start)
            const x1 = this.timeToX(clipEnd(clip))
            const vis0 = Math.max(x0, left - 100)
            const vis1 = Math.min(x1, left + viewW + 100)
            const canvas = node.querySelector(kind === 'audio' ? '.tl-clip-wave' : '.tl-clip-strip')
            if (!canvas) continue
            if (vis1 <= vis0) {
                canvas.style.display = 'none'
                continue
            }
            canvas.style.display = 'block'
            const w = vis1 - vis0
            const h = node.clientHeight || 60
            canvas.style.left = `${vis0 - x0}px`
            canvas.style.width = `${w}px`
            const cw = Math.max(1, Math.round(w * dpr))
            const ch = Math.max(1, Math.round((kind === 'audio' ? h - 18 : h - 2) * dpr))
            if (canvas.width !== cw) canvas.width = cw
            if (canvas.height !== ch) canvas.height = ch
            const g = canvas.getContext('2d')
            g.setTransform(dpr, 0, 0, dpr, 0, 0)
            g.clearRect(0, 0, w, ch / dpr)
            if (kind === 'audio') this._drawWave(g, clip, vis0 - x0, w, ch / dpr)
            else this._drawFilm(g, seq, clip, vis0 - x0, w, ch / dpr)
        }
    }

    _drawFilm(g, seq, clip, offsetPx, w, h) {
        const tileW = Math.max(24, h * (THUMB_W / THUMB_H))
        const first = Math.floor(offsetPx / tileW)
        const last = Math.ceil((offsetPx + w) / tileW)
        for (let i = first; i < last; i++) {
            const xIn = i * tileW
            const tMid = (xIn + tileW / 2) / this.pps
            const local = clip.offset + Math.min(tMid, clip.duration)
            let phase = loopPhase(local, clip.loop)
            phase = Math.round(phase * 32) / 32 % 1
            const bmp = this.thumbs.get(clip.dsl, phase)
            const x = xIn - offsetPx
            if (bmp) {
                g.globalAlpha = 0.92
                g.drawImage(bmp, x, 0, tileW, h)
                g.globalAlpha = 1
            } else if (!this.thumbs.hasFailed(clip.dsl)) {
                this.thumbs.request(clip.dsl, phase, { priority: 1 })
            }
        }
    }

    _drawWave(g, clip, offsetPx, w, h) {
        const media = this.store.project.media[clip.mediaId]
        const buffer = media ? cachedAudioBuffer(media) : null
        const styles = getComputedStyle(this.root)
        g.fillStyle = styles.getPropertyValue('--hf-green').trim() || '#4c8'
        if (!buffer) {
            g.globalAlpha = 0.25
            g.fillRect(0, h / 2 - 0.5, w, 1)
            g.globalAlpha = 1
            return
        }
        const secondsPerPx = 1 / this.pps
        const buckets = Math.max(64, Math.min(200000, Math.ceil(buffer.duration * this.pps)))
        const peaks = waveformPeaks(buffer, buckets)
        const mid = h / 2
        g.globalAlpha = 0.8
        for (let px = 0; px < w; px++) {
            const t = clip.offset + (offsetPx + px) * secondsPerPx
            const b = Math.floor((t / buffer.duration) * buckets)
            if (b < 0 || b >= buckets) continue
            const lo = peaks[b * 2]
            const hi = peaks[b * 2 + 1]
            const y0 = mid - hi * mid * (clip.gain ?? 1)
            const y1 = mid - lo * mid * (clip.gain ?? 1)
            g.fillRect(px, y0, 1, Math.max(1, y1 - y0))
        }
        g.globalAlpha = 1
    }

    // --- zoom ----------------------------------------------------------------

    setZoom(pps, anchorClientX = null) {
        const next = clamp(pps, MIN_PPS, MAX_PPS)
        const rect = this.scroll.getBoundingClientRect()
        const anchorX = anchorClientX === null ? this.timeToX(this.store.playhead) - this.scroll.scrollLeft : anchorClientX - rect.left
        const anchorT = (this.scroll.scrollLeft + anchorX) / this.pps
        this.store.setView({ pxPerSecond: next })
        this.scroll.scrollLeft = Math.max(0, anchorT * next - anchorX)
    }

    zoomBy(f, anchorClientX = null) {
        this.setZoom(this.pps * f, anchorClientX)
    }

    zoomToFit() {
        const seq = this.store.seq
        const w = this.scroll.clientWidth - 40
        this.store.setView({ pxPerSecond: clamp(w / seq.duration, MIN_PPS, MAX_PPS) })
        this.scroll.scrollLeft = 0
    }

    _onWheel(e) {
        if (e.ctrlKey || e.metaKey) {
            e.preventDefault()
            this.zoomBy(Math.exp(-e.deltaY * 0.004), e.clientX)
        }
    }

    // --- snapping ------------------------------------------------------------

    _snapPoints(excludeIds = new Set()) {
        const seq = this.store.seq
        const points = [0, seq.duration, this.store.playhead]
        for (const track of [...seq.tracks, ...seq.audioTracks]) {
            for (const clip of track.clips) {
                if (excludeIds.has(clip.id)) continue
                points.push(clip.start, clipEnd(clip))
            }
        }
        for (const m of seq.markers) points.push(m.time)
        if (seq.inPoint !== null) points.push(seq.inPoint)
        if (seq.outPoint !== null) points.push(seq.outPoint)
        return points
    }

    /** Snap any of `times` to the nearest point; returns the shift to apply. */
    _snap(times, excludeIds) {
        if (!this.store.view.snapping) {
            this.snapEl.hidden = true
            return 0
        }
        const seq = this.store.seq
        const points = this._snapPoints(excludeIds)
        let best = null
        const consider = (from, to) => {
            const d = Math.abs(to - from) * this.pps
            if (d <= SNAP_PX && (!best || d < best.d)) best = { d, shift: to - from, at: to }
        }
        for (const t of times) {
            for (const p of points) consider(t, p)
            if (this.store.view.beatGrid) {
                const beat = beatSeconds(seq.bpm)
                const off = seq.gridOffset || 0
                consider(t, Math.round((t - off) / beat) * beat + off)
            }
        }
        if (!best) {
            this.snapEl.hidden = true
            return 0
        }
        this.snapEl.hidden = false
        this.snapEl.style.left = `${this.timeToX(best.at)}px`
        return best.shift
    }

    _frameSnap(t) {
        const fps = this.store.seq.fps
        return Math.round(t * fps) / fps
    }

    // --- pointer interactions -------------------------------------------------

    _onRulerDown(e) {
        if (e.button !== 0) return
        e.preventDefault()
        const seq = this.store.seq
        const move = ev => {
            let t = clamp(this.xToTime(ev.clientX), 0, seq.duration)
            if (this.store.view.snapping && !ev.shiftKey) {
                const points = this._snapPoints().slice(3)
                for (const p of points) {
                    if (Math.abs(p - t) * this.pps <= SNAP_PX) {
                        t = p
                        break
                    }
                }
            }
            this.actions.scrubTo(t)
        }
        move(e)
        const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    }

    _laneAtY(clientY) {
        const lanes = [...this.lanes.querySelectorAll('.tl-lane')]
        for (const lane of lanes) {
            const r = lane.getBoundingClientRect()
            if (clientY >= r.top && clientY < r.bottom) return lane
        }
        return null
    }

    _onLanesDown(e) {
        if (e.button !== 0) return
        const target = e.target
        const transitionEl = target.closest('.tl-transition')
        const clipEl = target.closest('.tl-clip')
        const postEl = target.closest('.tl-post')
        if (postEl) {
            this.store.selectPost()
            return
        }
        if (transitionEl) {
            this._onTransitionDown(e, transitionEl)
            return
        }
        if (clipEl) {
            this._onClipDown(e, clipEl)
            return
        }
        const lane = target.closest('.tl-lane')
        if (lane?.dataset.trackId) {
            this.store.selection.track = lane.dataset.trackId
            for (const l of this.lanes.querySelectorAll('.tl-lane')) l.classList.toggle('is-target', l === lane)
            for (const h of this.headersInner.children) h.classList.remove('is-target')
        }
        this._startMarquee(e)
    }

    _onClipDown(e, clipEl) {
        e.preventDefault()
        const seq = this.store.seq
        const id = clipEl.dataset.clipId
        const found = findClip(seq, id)
        if (!found) return
        const edge = e.target.closest('.tl-clip-handle')?.dataset.edge
        const sel = this.store.selection
        sel.track = found.track.id
        if (e.shiftKey || e.metaKey) this.store.selectClip(id, { additive: true })
        else if (!sel.clips.has(id)) this.store.selectClip(id)
        else this.store.emit('selection')
        if (found.track.locked) return

        const startX = e.clientX
        const startY = e.clientY
        if (edge) {
            this._dragTrim(e, found, edge, this.lanes.querySelector(`.tl-clip[data-clip-id="${id}"]`))
            return
        }
        const ids = [...this.store.selection.clips]
        const clips = ids.map(cid => findClip(seq, cid)).filter(Boolean)
        const els = clips.map(c => this.lanes.querySelector(`.tl-clip[data-clip-id="${c.clip.id}"]`)).filter(Boolean)
        const exclude = new Set(ids)
        const startLane = this._laneAtY(e.clientY)
        const laneList = [...this.lanes.querySelectorAll('.tl-lane')]
        let moved = false
        let delta = 0
        let trackDelta = 0
        const move = ev => {
            const dx = ev.clientX - startX
            const dy = ev.clientY - startY
            if (!moved && Math.hypot(dx, dy) < DRAG_THRESHOLD) return
            moved = true
            els.forEach(n => n.classList.add('is-dragging'))
            delta = dx / this.pps
            const minStart = Math.min(...clips.map(c => c.clip.start))
            delta = Math.max(delta, -minStart)
            const primary = found.clip
            const shift = ev.altKey ? 0 : this._snap([primary.start + delta, clipEnd(primary) + delta], exclude)
            delta = this._frameSnap(primary.start + delta + shift) - primary.start
            const lane = this._laneAtY(ev.clientY)
            const sameKind = lane && startLane && lane.dataset.kind === startLane.dataset.kind
            if (sameKind) {
                const visual = found.kind === 'visual'
                const fromIdx = laneList.indexOf(startLane)
                const toIdx = laneList.indexOf(lane)
                trackDelta = visual ? fromIdx - toIdx : toIdx - fromIdx
            }
            const dyPx = sameKind ? (lane.getBoundingClientRect().top - startLane.getBoundingClientRect().top) : 0
            for (const n of els) n.style.transform = `translate(${delta * this.pps}px, ${dyPx}px)`
        }
        const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            this.snapEl.hidden = true
            if (!moved) return
            if (Math.abs(delta) < 1e-9 && trackDelta === 0) {
                els.forEach(n => { n.style.transform = '' ; n.classList.remove('is-dragging') })
                return
            }
            this.store.edit('Move clips', s => moveClips(s, ids, delta, trackDelta))
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    }

    _dragTrim(e, found, edge, clipEl) {
        const seq = this.store.seq
        const { clip } = found
        const startX = e.clientX
        const orig = { start: clip.start, end: clipEnd(clip) }
        let time = edge === 'start' ? orig.start : orig.end
        const exclude = new Set([clip.id])
        const move = ev => {
            const dt = (ev.clientX - startX) / this.pps
            let t = (edge === 'start' ? orig.start : orig.end) + dt
            if (!ev.altKey) t += this._snap([t], exclude)
            t = this._frameSnap(t)
            time = t
            const s = edge === 'start' ? Math.min(t, orig.end - 1 / seq.fps) : orig.start
            const en = edge === 'end' ? Math.max(t, orig.start + 1 / seq.fps) : orig.end
            clipEl.style.left = `${this.timeToX(s)}px`
            clipEl.style.width = `${this.timeToX(en - s)}px`
            this.actions.scrubTo(edge === 'start' ? s : en - 1 / seq.fps, { quiet: true })
        }
        const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            this.snapEl.hidden = true
            const limits = {}
            if (found.kind === 'audio') {
                const media = this.store.project.media[clip.mediaId]
                if (media?.duration) limits.sourceDuration = media.duration
            } else if (clip.type === 'sequence' && clip.loopSequence === false) {
                const child = this.store.project.sequences[clip.sequenceId]
                if (child) limits.sourceDuration = child.duration
            }
            this.store.edit('Trim clip', s => trimClip(s, clip.id, edge, time, limits))
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    }

    _onTransitionDown(e, node) {
        e.preventDefault()
        const id = node.dataset.transitionId
        const trackId = node.dataset.trackId
        const edge = e.target.closest('.tl-transition-handle')?.dataset.edge
        this.store.selectTransition(id)
        node = this.lanes.querySelector(`.tl-transition[data-transition-id="${id}"]`)
        if (!edge || !node) return
        const seq = this.store.seq
        const track = seq.tracks.find(t => t.id === trackId)
        const transition = track?.transitions.find(t => t.id === id)
        const span = transition && transitionSpan(track, transition)
        if (!span) return
        let duration = transition.duration
        const move = ev => {
            const t = this.xToTime(ev.clientX)
            if (transition.from && transition.to) duration = Math.max(1 / seq.fps, 2 * Math.abs(t - span.cut))
            else if (transition.to) duration = Math.max(1 / seq.fps, t - span.start)
            else duration = Math.max(1 / seq.fps, span.end - t)
            if (this.store.view.snapping && this.store.view.beatGrid) {
                const beat = beatSeconds(seq.bpm) / 2
                const snapped = Math.round(duration / beat) * beat
                if (Math.abs(snapped - duration) * this.pps < SNAP_PX && snapped > 0) duration = snapped
            }
            const s = transition.from && transition.to ? span.cut - duration / 2 : transition.to ? span.start : span.end - duration
            node.style.left = `${this.timeToX(s)}px`
            node.style.width = `${this.timeToX(duration)}px`
        }
        const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            this.store.edit('Change transition length', s => setTransitionDuration(s, id, duration))
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    }

    _onMarkerDown(e, marker) {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        this.store.selectMarker(marker.id)
        const startX = e.clientX
        const seq = this.store.seq
        let moved = false
        let time = marker.time
        const node = this.markersEl.querySelector(`[data-marker-id="${marker.id}"]`)
        const move = ev => {
            if (!moved && Math.abs(ev.clientX - startX) < DRAG_THRESHOLD) return
            moved = true
            let t = clamp(marker.time + (ev.clientX - startX) / this.pps, 0, seq.duration)
            t += this._snap([t], new Set())
            time = this._frameSnap(t)
            if (node) node.style.left = `${this.timeToX(time)}px`
        }
        const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            this.snapEl.hidden = true
            if (moved) {
                this.store.edit('Move marker', s => {
                    const m = s.markers.find(x => x.id === marker.id)
                    if (m) m.time = time
                    s.markers.sort((a, b) => a.time - b.time)
                })
            } else {
                this.actions.seek(marker.time)
            }
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    }

    _startMarquee(e) {
        e.preventDefault()
        const contentRect = () => this.content.getBoundingClientRect()
        const start = { x: e.clientX - contentRect().left, y: e.clientY - contentRect().top }
        const box = el('div', 'tl-marquee')
        let active = false
        const additive = e.shiftKey || e.metaKey
        const before = new Set(additive ? this.store.selection.clips : [])
        const move = ev => {
            const r = contentRect()
            const cur = { x: ev.clientX - r.left, y: ev.clientY - r.top }
            if (!active && Math.hypot(cur.x - start.x, cur.y - start.y) < DRAG_THRESHOLD) return
            if (!active) {
                active = true
                this.content.append(box)
            }
            const x0 = Math.min(start.x, cur.x)
            const y0 = Math.min(start.y, cur.y)
            const x1 = Math.max(start.x, cur.x)
            const y1 = Math.max(start.y, cur.y)
            Object.assign(box.style, { left: `${x0}px`, top: `${y0}px`, width: `${x1 - x0}px`, height: `${y1 - y0}px` })
            const hits = new Set(before)
            for (const { node, clip } of this._clipEls.values()) {
                const cr = node.getBoundingClientRect()
                const nx0 = cr.left - r.left
                const ny0 = cr.top - r.top
                if (nx0 < x1 && nx0 + cr.width > x0 && ny0 < y1 && ny0 + cr.height > y0) hits.add(clip.id)
            }
            for (const { node, clip } of this._clipEls.values()) node.classList.toggle('is-selected', hits.has(clip.id))
            this._marqueeHits = hits
        }
        const up = ev => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
            box.remove()
            if (active) {
                this.store.selectClips([...(this._marqueeHits || [])])
            } else {
                if (!additive) this.store.clearSelection()
                this.actions.scrubTo(clamp(this.xToTime(ev.clientX), 0, this.store.seq.duration))
            }
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    }

    _onContextMenu(e) {
        e.preventDefault()
        const seq = this.store.seq
        const t = this._frameSnap(clamp(this.xToTime(e.clientX), 0, seq.duration))
        const transitionEl = e.target.closest('.tl-transition')
        const clipEl = e.target.closest('.tl-clip')
        if (transitionEl) {
            const id = transitionEl.dataset.transitionId
            this.store.selectTransition(id)
            const found = seq.tracks.flatMap(tr => tr.transitions).find(x => x.id === id)
            const items = []
            if (found?.from && found?.to) {
                for (const preset of TRANSITIONS) {
                    items.push({ label: preset.name, checked: found.preset === preset.id, onSelect: () => this.actions.applyTransitionPreset(preset.id) })
                }
                items.push({ separator: true })
            }
            items.push({ label: 'Remove transition', danger: true, onSelect: () => this.store.edit('Remove transition', s => deleteTransition(s, id)) })
            showContextMenu(e.clientX, e.clientY, items)
            return
        }
        if (clipEl) {
            const id = clipEl.dataset.clipId
            const found = findClip(seq, id)
            if (!found) return
            if (!this.store.selection.clips.has(id)) this.store.selectClip(id)
            const visual = found.kind === 'visual'
            const inside = t > found.clip.start && t < clipEnd(found.clip)
            const bar = barSeconds(seq.bpm, seq.beatsPerBar)
            const items = [
                { label: 'Split here', disabled: !inside || found.track.locked, onSelect: () => this.store.edit('Split clip', s => { splitClip(s, id, t) }) },
                { label: 'Duplicate', shortcut: 'Shift Cmd D', onSelect: () => this.actions.duplicate() },
                { label: 'Copy', shortcut: 'Cmd C', onSelect: () => this.actions.copy() },
            ]
            if (visual) {
                items.push({ separator: true })
                items.push({
                    label: 'Fade in', disabled: found.track.locked, onSelect: () => this.store.edit('Fade in', s => {
                        const tr = s.tracks.find(x => x.id === found.track.id)
                        return addTransition(tr, { from: null, to: id, duration: Math.min(bar, found.clip.duration) }) ? undefined : false
                    }),
                })
                items.push({
                    label: 'Fade out', disabled: found.track.locked, onSelect: () => this.store.edit('Fade out', s => {
                        const tr = s.tracks.find(x => x.id === found.track.id)
                        return addTransition(tr, { from: id, to: null, duration: Math.min(bar, found.clip.duration) }) ? undefined : false
                    }),
                })
                if (found.clip.type === 'sequence') {
                    items.push({ label: 'Open sequence', onSelect: () => this.store.setActiveSequence(found.clip.sequenceId) })
                }
            }
            items.push({ separator: true }, { label: 'Delete', danger: true, shortcut: 'Del', onSelect: () => this.actions.deleteSelection() })
            showContextMenu(e.clientX, e.clientY, items)
            return
        }
        showContextMenu(e.clientX, e.clientY, [
            { label: 'Paste here', disabled: !this.actions.hasClipboard(), onSelect: () => this.actions.pasteAt(t) },
            { label: 'Add marker here', onSelect: () => this.store.edit('Add marker', s => { addMarker(s, t) }) },
            { separator: true },
            { label: 'Set in point here', onSelect: () => this.store.edit('Set in point', s => { s.inPoint = t; if (s.outPoint !== null && s.outPoint <= t) s.outPoint = null }) },
            { label: 'Set out point here', onSelect: () => this.store.edit('Set out point', s => { s.outPoint = t; if (s.inPoint !== null && s.inPoint >= t) s.inPoint = null }) },
        ])
    }

    _onDblClick(e) {
        const clipEl = e.target.closest('.tl-clip')
        if (!clipEl) return
        const found = findClip(this.store.seq, clipEl.dataset.clipId)
        if (found?.clip.type === 'sequence') this.store.setActiveSequence(found.clip.sequenceId)
        else this.actions.focusEditor()
    }

    // --- drops from the library --------------------------------------------------

    _payload(e) {
        const raw = e.dataTransfer?.getData('application/x-timeline')
        if (!raw) return null
        try { return JSON.parse(raw) } catch { return null }
    }

    _onDragOver(e) {
        if (!e.dataTransfer?.types.includes('application/x-timeline')) return
        e.preventDefault()
        e.dataTransfer.dropEffect = 'copy'
        const lane = this._laneAtY(e.clientY)
        for (const l of this.lanes.querySelectorAll('.tl-lane.is-drop')) if (l !== lane) l.classList.remove('is-drop')
        lane?.classList.add('is-drop')
    }

    _onDragLeave(e) {
        if (!this.lanes.contains(e.relatedTarget)) {
            for (const l of this.lanes.querySelectorAll('.tl-lane.is-drop')) l.classList.remove('is-drop')
        }
    }

    _onDrop(e) {
        const payload = this._payload(e)
        for (const l of this.lanes.querySelectorAll('.tl-lane.is-drop')) l.classList.remove('is-drop')
        if (!payload) return
        e.preventDefault()
        const lane = this._laneAtY(e.clientY)
        if (!lane) return
        const seq = this.store.seq
        let t = clamp(this.xToTime(e.clientX), 0, seq.duration)
        t = this._frameSnap(t + this._snap([t], new Set()))
        this.snapEl.hidden = true
        this.dropPayload(payload, lane.dataset.kind, lane.dataset.trackId, t, e.clientX)
    }

    /** Place a library item on a lane at `t`. Shared with keyboard adds. */
    dropPayload(payload, laneKind, trackId, t, clientX = null) {
        const seq = this.store.seq
        const bar = barSeconds(seq.bpm, seq.beatsPerBar)
        if (payload.kind === 'post' && laneKind === 'post') {
            this.store.edit('Set post chain', s => {
                s.post.preset = payload.id
                s.post.dsl = postPreset(payload.id).dsl
                s.post.enabled = true
            })
            this.store.selectPost()
            return
        }
        if (payload.kind === 'transition' && laneKind === 'video') {
            const track = seq.tracks.find(x => x.id === trackId)
            const tolerance = clientX === null ? Infinity : 60 / this.pps
            const cut = track && cutNear(track, t, tolerance)
            if (!cut) {
                this.actions.status('Drop a transition on a cut between two clips, or on a clip edge')
                return
            }
            let created = null
            this.store.edit('Add transition', s => {
                const tr = s.tracks.find(x => x.id === trackId)
                created = addTransition(tr, {
                    from: cut.from, to: cut.to, duration: beatSeconds(s.bpm) * 2,
                    preset: payload.id, dsl: transitionPreset(payload.id).dsl,
                })
                return created ? undefined : false
            })
            if (created) this.store.selectTransition(created.id)
            return
        }
        if ((payload.kind === 'program' || payload.kind === 'sequence') && laneKind === 'video') {
            if (payload.kind === 'sequence' && wouldCreateCycle(this.store.project, seq.id, payload.id)) {
                this.actions.status('A sequence cannot contain itself')
                return
            }
            let clip
            if (payload.kind === 'program') {
                clip = createProgramClip({ name: payload.name, dsl: payload.dsl, tint: payload.tint, start: t, duration: bar * 4, loop: bar * 4 })
            } else {
                const child = this.store.project.sequences[payload.id]
                clip = createSequenceClip({ sequenceId: payload.id, name: child?.name || 'Sequence', start: t, duration: child?.duration || bar * 4 })
            }
            clip.duration = Math.min(clip.duration, Math.max(1 / seq.fps, seq.duration - t))
            this.store.edit('Add clip', s => {
                insertClip(s.tracks.find(x => x.id === trackId), clip)
            })
            this.store.selectClip(clip.id)
            return
        }
        if (payload.kind === 'audio' && laneKind === 'audio') {
            const media = this.store.project.media[payload.id]
            if (!media) return
            const clip = createAudioClip({ mediaId: media.id, name: media.name, start: t, duration: Math.min(media.duration || 10, seq.duration - t) })
            this.store.edit('Add audio', s => {
                insertClip(s.audioTracks.find(x => x.id === trackId), clip)
            })
            this.store.selectClip(clip.id)
            return
        }
        const where = { program: 'a video track', sequence: 'a video track', transition: 'a cut on a video track', post: 'the post lane', audio: 'an audio track' }
        this.actions.status(`Drop this on ${where[payload.kind] || 'the timeline'}`)
    }
}
