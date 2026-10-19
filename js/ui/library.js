/**
 * The library: programs, transitions, post chains, sequences and media
 * (audio, images and video).
 * Drag anything onto the timeline, or activate it to add it at the
 * playhead on the target track. Program cards show a frame rendered by the
 * thumbnail renderer once they scroll into view.
 */

import { TRANSITIONS, POST_PRESETS } from '../data/presets.js'
import { STARTER_PROGRAMS } from '../data/demoProject.js'
import { formatTimecode } from '../model/time.js'

const LIBRARY_URL = 'https://visualize.noisedeck.app/data/programs.json'
const TABS = [
    ['programs', 'Programs'],
    ['transitions', 'Transitions'],
    ['post', 'Post'],
    ['sequences', 'Sequences'],
    ['media', 'Media'],
]

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

function draggable(node, payload) {
    node.draggable = true
    node.addEventListener('dragstart', e => {
        e.dataTransfer.setData('application/x-timeline', JSON.stringify(payload))
        e.dataTransfer.effectAllowed = 'copy'
    })
}

export class LibraryView {
    constructor(root, { store, thumbs, actions }) {
        this.root = root
        this.store = store
        this.thumbs = thumbs
        this.actions = actions
        this.tab = 'programs'
        this.query = ''
        this.programs = STARTER_PROGRAMS.map(p => ({ ...p, source: 'Timeline' }))
        this._observer = new IntersectionObserver(entries => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue
                this._observer.unobserve(entry.target)
                entry.target._loadThumb?.()
            }
        }, { root: null, rootMargin: '120px' })

        this.tabsEl = el('div', 'tl-panel-tabs', { role: 'tablist', 'aria-label': 'Library' })
        for (const [id, label] of TABS) {
            const b = el('button', 'tl-panel-tab', { type: 'button', role: 'tab', 'aria-selected': String(id === this.tab), text: label })
            b.dataset.tab = id
            b.addEventListener('click', () => this.setTab(id))
            this.tabsEl.append(b)
        }
        this.body = el('div', 'tl-panel-body', { role: 'tabpanel' })
        root.replaceChildren(this.tabsEl, this.body)
        store.on('project', () => {
            if (this.tab === 'sequences' || this.tab === 'media') this.render()
        })
        this.render()
        this._loadLibrary()
    }

    async _loadLibrary() {
        try {
            const res = await fetch(LIBRARY_URL, { cache: 'no-cache' })
            if (!res.ok) throw new Error(`HTTP ${res.status}`)
            const list = await res.json()
            const seen = new Set(this.programs.map(p => p.name.toLowerCase()))
            for (const p of list) {
                if (!p?.dsl || /media\s*\(/.test(p.dsl)) continue
                const name = p.title || 'Program'
                if (seen.has(name.toLowerCase())) continue
                seen.add(name.toLowerCase())
                this.programs.push({ name, dsl: p.dsl, tint: p.tint || null, tags: p.tags || [], source: 'Noisedeck library' })
            }
            if (this.tab === 'programs') this.render()
        } catch (err) {
            console.warn('[timeline] program library unavailable', err?.message || err)
        }
    }

    setTab(id) {
        this.tab = id
        for (const b of this.tabsEl.children) b.setAttribute('aria-selected', String(b.dataset.tab === id))
        this.render()
    }

    render() {
        const scroll = this.body.scrollTop
        this.body.replaceChildren()
        switch (this.tab) {
            case 'programs': this._renderPrograms(); break
            case 'transitions': this._renderTransitions(); break
            case 'post': this._renderPost(); break
            case 'sequences': this._renderSequences(); break
            case 'media': this._renderMedia(); break
        }
        this.body.scrollTop = scroll
    }

    _renderPrograms() {
        const search = el('input', 'tl-search', { type: 'search', placeholder: 'Filter programs', 'aria-label': 'Filter programs' })
        search.value = this.query
        const grid = el('div', 'tl-cards')
        const fill = () => {
            grid.replaceChildren()
            const q = this.query.trim().toLowerCase()
            const items = this.programs.filter(p => !q || p.name.toLowerCase().includes(q) || p.tags?.some(t => t.includes(q)) || p.dsl.includes(q))
            for (const p of items) grid.append(this._programCard(p))
            if (!items.length) grid.append(el('p', 'tl-hint', { text: 'No programs match.' }))
        }
        search.addEventListener('input', () => {
            this.query = search.value
            fill()
        })
        fill()
        this.body.append(search, el('p', 'tl-hint', { text: 'Drag a program onto a video track. Double-click to add it at the playhead.' }), grid)
    }

    _programCard(p) {
        const card = el('button', 'tl-card', { type: 'button', title: `${p.name}: drag to the timeline` })
        if (p.tint) card.style.setProperty('--tl-tint', p.tint)
        const thumb = el('div', 'tl-card-thumb')
        if (/audio\s*\(/.test(p.dsl)) {
            const badge = el('span', 'tl-card-badge', { title: 'Reacts to audio' })
            badge.append(icon('graphic_eq'))
            badge.querySelector('.hf-icon').style.fontSize = '11px'
            thumb.append(badge)
        }
        card.append(thumb, el('span', 'tl-card-title', { text: p.name }))
        draggable(card, { kind: 'program', name: p.name, dsl: p.dsl, tint: p.tint })
        card.addEventListener('dblclick', () => this.actions.addPayloadAtPlayhead({ kind: 'program', name: p.name, dsl: p.dsl, tint: p.tint }))
        card.addEventListener('keydown', e => {
            if (e.key === 'Enter') this.actions.addPayloadAtPlayhead({ kind: 'program', name: p.name, dsl: p.dsl, tint: p.tint })
        })
        card._loadThumb = async () => {
            const bmp = await this.thumbs.request(p.dsl, 0.3, { priority: 3 })
            if (!bmp || !card.isConnected) return
            const c = el('canvas')
            c.width = bmp.width
            c.height = bmp.height
            c.getContext('2d').drawImage(bmp, 0, 0)
            thumb.prepend(c)
        }
        this._observer.observe(card)
        return card
    }

    _row({ title, sub, swatch, iconName, current = false, onActivate, payload }) {
        const row = el('button', 'tl-row', { type: 'button' })
        if (current) row.setAttribute('aria-current', 'true')
        if (swatch) {
            const s = el('span', 'tl-row-swatch')
            s.style.setProperty('--tl-swatch', swatch)
            row.append(s)
        }
        const main = el('span', 'tl-row-main')
        main.append(el('span', 'tl-row-title', { text: title }))
        if (sub) main.append(el('span', 'tl-row-sub', { text: sub }))
        row.append(main)
        if (iconName) row.append(icon(iconName))
        if (onActivate) row.addEventListener('click', onActivate)
        if (payload) draggable(row, payload)
        return row
    }

    _renderTransitions() {
        const rows = el('div', 'tl-rows')
        const gradients = [
            'linear-gradient(90deg, var(--hf-blue), var(--hf-red))',
            'linear-gradient(90deg, var(--hf-blue), var(--hf-text-bright), var(--hf-red))',
        ]
        TRANSITIONS.forEach((t, i) => rows.append(this._row({
            title: t.name,
            swatch: gradients[i % 2],
            iconName: 'join',
            payload: { kind: 'transition', id: t.id },
            onActivate: () => this.actions.applyTransitionPreset(t.id),
        })))
        this.body.append(
            el('p', 'tl-hint', { text: 'Drop a transition on a cut, or select a cut and choose one. Each is a DSL program you can edit.' }),
            rows,
        )
    }

    _renderPost() {
        const seq = this.store.seq
        const rows = el('div', 'tl-rows')
        for (const p of POST_PRESETS) {
            rows.append(this._row({
                title: p.name,
                sub: seq.post?.preset === p.id && seq.post.enabled ? 'In use' : null,
                current: seq.post?.preset === p.id && seq.post.enabled,
                swatch: 'linear-gradient(90deg, color-mix(in oklch, var(--hf-blue) 50%, transparent), color-mix(in oklch, var(--hf-yellow) 50%, transparent))',
                iconName: 'auto_awesome',
                payload: { kind: 'post', id: p.id },
                onActivate: () => this.actions.applyPostPreset(p.id),
            }))
        }
        this.body.append(
            el('p', 'tl-hint', { text: 'One post chain runs over the whole sequence for a consistent look. Choose one here, then edit its DSL in the inspector.' }),
            rows,
        )
    }

    _renderSequences() {
        const project = this.store.project
        const buttons = el('div', 'tl-button-row')
        const add = el('button', 'tl-button', { type: 'button' })
        add.append(icon('add'), document.createTextNode('New sequence'))
        add.addEventListener('click', () => this.actions.newSequence())
        const dup = el('button', 'tl-button', { type: 'button' })
        dup.append(icon('content_copy'), document.createTextNode('Duplicate'))
        dup.addEventListener('click', () => this.actions.duplicateSequence())
        buttons.append(add, dup)
        const rows = el('div', 'tl-rows')
        for (const id of project.sequenceOrder) {
            const s = project.sequences[id]
            const tint = s.tracks.flatMap(t => t.clips).find(c => c.tint)?.tint
            const row = this._row({
                title: s.name,
                sub: `${formatTimecode(s.duration, s.fps)}  ${s.width}×${s.height}${id === project.mainSequenceId ? '  main' : ''}`,
                swatch: tint || null,
                current: id === this.store.activeSeqId,
                iconName: 'layers',
                payload: { kind: 'sequence', id },
                onActivate: () => this.store.setActiveSequence(id),
            })
            rows.append(row)
        }
        this.body.append(
            buttons,
            el('p', 'tl-hint', { text: 'Click to open a sequence. Drag one onto a video track to nest it.' }),
            rows,
        )
    }

    _renderMedia() {
        const project = this.store.project
        const buttons = el('div', 'tl-button-row')
        const imp = el('button', 'tl-button', { type: 'button' })
        imp.append(icon('upload'), document.createTextNode('Import'))
        imp.addEventListener('click', () => this.actions.importMedia())
        const text = el('button', 'tl-button', { type: 'button' })
        text.append(icon('title'), document.createTextNode('Add text'))
        text.addEventListener('click', () => this.actions.addText())
        buttons.append(imp, text)
        const rows = el('div', 'tl-rows')
        const media = Object.values(project.media || {})
        const kinds = {
            audio: { swatch: 'var(--hf-green)', iconName: 'graphic_eq' },
            image: { swatch: 'var(--hf-blue)', iconName: 'image' },
            video: { swatch: 'var(--hf-yellow)', iconName: 'movie' },
        }
        for (const m of media) {
            const look = kinds[m.kind] || kinds.audio
            const size = m.width ? `${m.width}×${m.height}` : ''
            const length = m.kind !== 'image' ? formatTimecode(m.duration || 0, 30) : ''
            const payload = m.kind === 'audio' ? { kind: 'audio', id: m.id } : { kind: 'media', id: m.id }
            rows.append(this._row({
                title: m.name,
                sub: [m.kind, size, length].filter(Boolean).join('  '),
                swatch: look.swatch,
                iconName: look.iconName,
                payload,
                onActivate: () => (m.kind === 'audio' ? this.actions.addPayloadAtPlayhead(payload) : this.actions.placeVisualMedia(m)),
            }))
        }
        if (!media.length) rows.append(el('p', 'tl-empty', { text: 'Import audio, images or video, or drop files anywhere on the window.' }))
        const where = this.store.source?.kind === 'folder' ? `copied into ${this.store.source.name}` : 'kept in this browser'
        this.body.append(
            buttons,
            el('p', 'tl-hint', { text: `Imported files are ${where} and never uploaded. Drag images and video onto a video track and audio onto an audio track; programs read each audio track with audio(..., channel: N).` }),
            rows,
        )
    }
}
