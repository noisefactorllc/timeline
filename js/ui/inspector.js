/**
 * The inspector edits whatever is selected: a program clip's DSL, timing,
 * loop and compositing; a nested sequence clip; a text, image or video
 * clip's look, placement and motion; an audio clip; a transition's DSL;
 * the post chain; a marker; or, with nothing selected, the sequence itself.
 *
 * DSL edits apply live, debounced, as undoable edits that coalesce while
 * typing. The monitor shows the result as soon as the program compiles, and
 * the line under the editor reports the compile result.
 */

import { dslTokenizer } from 'handfish'
import { findClip, findTransition, BLEND_MODES, FIT_MODES, MOTION_PRESETS, TEXT_ALIGN } from '../model/project.js'
import { EASE_NAMES, EASE_DIRECTIONS } from '../model/ease.js'
import { keyValue, keyAt, setKey, removeKey, keyTimes, DUCK_DEFAULTS, DEFAULT_KEY_EASE, gainToDb, dbToGain } from '../model/automation.js'
import { loadFontCatalog, fontCatalog } from '../render/fonts.js'
import { formatTimecode, parseTime, barSeconds, beatSeconds } from '../model/time.js'
import { transitionSpan, maxTransitionDuration } from '../model/evaluate.js'
import { TRANSITIONS, POST_PRESETS, transitionPreset, postPreset, audioSnippets } from '../data/presets.js'
import { transitionDsl } from '../render/sequenceRenderer.js'

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

const RESOLUTIONS = [
    ['1920x1080', '1920 × 1080 (HD)'],
    ['1280x720', '1280 × 720'],
    ['3840x2160', '3840 × 2160 (4K)'],
    ['1080x1080', '1080 × 1080 (square)'],
    ['1080x1920', '1080 × 1920 (vertical)'],
    ['1080x1350', '1080 × 1350 (portrait)'],
]

export const SHORTCUTS = [
    ['Space', 'Play or pause'],
    ['J K L', 'Back a bar, stop, play'],
    ['Left / Right', 'Step one frame'],
    ['Shift Left / Right', 'Step one beat'],
    ['Up / Down', 'Previous or next edit'],
    ['Home / End', 'Start or end'],
    ['I / O', 'Set in and out'],
    ['Alt X', 'Clear in and out'],
    ['M', 'Add marker'],
    ['T', 'Add text'],
    ['Cmd K', 'Cut at playhead'],
    ['Cmd D', 'Add transition at nearest cut'],
    ['Cmd C / V', 'Copy and paste at playhead'],
    ['Shift Cmd D', 'Duplicate after the selection'],
    ['Delete', 'Delete selection'],
    ['Cmd Z / Shift Cmd Z', 'Undo and redo'],
    ['= / - / \\', 'Zoom in, out, fit'],
    ['S / G', 'Snapping, beat grid'],
    ['F', 'Full screen monitor'],
    ['Cmd E', 'Export video'],
]

export class InspectorView {
    constructor(root, { store, pool, actions }) {
        this.root = root
        this.store = store
        this.pool = pool
        this.actions = actions
        this.targetKey = null
        this.editor = null
        this.editorStatus = null
        this.fields = []
        this._dslTimer = null
        store.on('selection', () => this.update())
        store.on('project', () => this.update())
        // Keyed values follow the playhead.
        store.on('playhead', () => {
            const target = this._target()
            if (target.clip?.keys && target.key === this.targetKey) this._refresh(target)
        })
        pool.compiledListeners.add((entry, result) => this._onCompiled(entry, result))
        this.update()
    }

    _target() {
        const seq = this.store.seq
        const sel = this.store.selection
        if (!seq) return { key: 'none' }
        if (sel.post) return { key: `post:${seq.id}`, kind: 'post' }
        if (sel.transition) {
            const found = findTransition(seq, sel.transition)
            if (found) return { ...found, key: `transition:${sel.transition}`, kind: 'transition' }
        }
        if (sel.marker) {
            const marker = seq.markers.find(m => m.id === sel.marker)
            if (marker) return { key: `marker:${marker.id}`, kind: 'marker', marker }
        }
        if (sel.clips.size > 1) return { key: `multi:${[...sel.clips].sort().join(',')}`, kind: 'multi', ids: [...sel.clips] }
        if (sel.clips.size === 1) {
            const found = findClip(seq, [...sel.clips][0])
            if (found) {
                // Gaining keys or ducking changes the panel, so it is part of the key.
                const extras = `${found.clip.keys ? ':keys' : ''}${found.kind === 'audio' && found.track.duck ? ':duck' : ''}`
                return { ...found, key: `clip:${found.clip.id}${extras}`, kind: found.kind === 'audio' ? 'audio' : found.clip.type }
            }
        }
        return { key: `sequence:${seq.id}`, kind: 'sequence', seq }
    }

    update() {
        const target = this._target()
        if (target.key === this.targetKey) {
            this._refresh(target)
            return
        }
        this.targetKey = target.key
        this._build(target)
    }

    // --- builders ---------------------------------------------------------------

    _head(kindIcon, title, { tint = null, editable = null } = {}) {
        const head = el('div', 'tl-insp-head')
        const kind = el('div', 'tl-insp-kind')
        if (tint) kind.style.setProperty('--tint', tint)
        kind.append(icon(kindIcon))
        head.append(kind)
        if (editable) {
            const input = el('input', 'tl-insp-title', { type: 'text', 'aria-label': 'Name', spellcheck: 'false' })
            input.value = title
            input.addEventListener('change', () => editable(input.value.trim() || title))
            input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur() })
            head.append(input)
            this.titleInput = input
        } else {
            head.append(el('div', 'tl-insp-title', { text: title }))
        }
        return head
    }

    _section(title, ...children) {
        const s = el('section')
        if (title) s.append(el('h3', 'tl-section-title', { text: title }))
        s.append(...children)
        return s
    }

    _grid(...fields) {
        const g = el('div', 'tl-field-grid')
        g.append(...fields)
        return g
    }

    _field(label, input) {
        const f = el('label', 'tl-field')
        f.append(el('span', '', { text: label }), input)
        return f
    }

    /** A time field showing timecode; typing accepts timecode, seconds or frames. */
    _timeField(label, get, set) {
        const seq = this.store.seq
        const input = el('input', 'is-time', { type: 'text', spellcheck: 'false', inputmode: 'text' })
        const show = () => { input.value = formatTimecode(get(), seq.fps) }
        show()
        input.addEventListener('change', () => {
            const t = parseTime(input.value, this.store.seq.fps)
            if (t === null || !Number.isFinite(t)) show()
            else set(t)
        })
        input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur() })
        this.fields.push({ input, refresh: show })
        return this._field(label, input)
    }

    _numberField(label, get, set, { step = 1, min = null, max = null, digits = 2 } = {}) {
        const input = el('input', '', { type: 'number', step: String(step), min: min ?? undefined, max: max ?? undefined })
        const show = () => { input.value = String(Number(get().toFixed(digits))) }
        show()
        input.addEventListener('change', () => {
            let v = Number(input.value)
            if (!Number.isFinite(v)) return show()
            if (min !== null) v = Math.max(min, v)
            if (max !== null) v = Math.min(max, v)
            set(v)
        })
        this.fields.push({ input, refresh: show })
        return this._field(label, input)
    }

    _selectField(label, options, get, set) {
        const select = el('select')
        for (const [value, text] of options) {
            const o = el('option', '', { value, text })
            select.append(o)
        }
        const show = () => { select.value = String(get()) }
        show()
        select.addEventListener('change', () => set(select.value))
        this.fields.push({ input: select, refresh: show })
        return this._field(label, select)
    }

    _rangeField(label, get, set, { min = 0, max = 100, step = 1, coalesce } = {}) {
        const input = el('input', '', { type: 'range', min: String(min), max: String(max), step: String(step) })
        const show = () => { input.value = String(get()) }
        show()
        input.addEventListener('input', () => set(Number(input.value), coalesce))
        this.fields.push({ input, refresh: show })
        return this._field(label, input)
    }

    _checkField(label, get, set) {
        const input = el('input', '', { type: 'checkbox' })
        const show = () => { input.checked = !!get() }
        show()
        input.addEventListener('change', () => set(input.checked))
        this.fields.push({ input, refresh: show })
        const f = this._field(label, input)
        return f
    }

    _loopField(clip) {
        const seq = this.store.seq
        const bar = barSeconds(seq.bpm, seq.beatsPerBar)
        const beat = beatSeconds(seq.bpm)
        const options = [
            [String(beat), '1 beat'], [String(beat * 2), '2 beats'], [String(bar), '1 bar'], [String(bar * 2), '2 bars'],
            [String(bar * 4), '4 bars'], [String(bar * 8), '8 bars'], [String(bar * 16), '16 bars'], ['custom', 'Seconds'],
        ]
        const select = el('select')
        for (const [value, text] of options) select.append(el('option', '', { value, text }))
        const seconds = el('input', '', { type: 'number', step: '0.1', min: '0.1' })
        const show = () => {
            const c = findClip(this.store.seq, clip.id)?.clip
            if (!c) return
            const match = options.find(([v]) => v !== 'custom' && Math.abs(Number(v) - c.loop) < 1e-6)
            select.value = match ? match[0] : 'custom'
            seconds.value = String(Number(c.loop.toFixed(3)))
        }
        show()
        const apply = v => this._editClip(clip.id, 'Change loop length', c => { c.loop = v })
        select.addEventListener('change', () => {
            if (select.value !== 'custom') apply(Number(select.value))
        })
        seconds.addEventListener('change', () => {
            const v = Number(seconds.value)
            if (v > 0) apply(v)
        })
        this.fields.push({ input: select, refresh: show }, { input: seconds, refresh: show })
        return [this._field('Loop', select), this._field('Loop seconds', seconds)]
    }

    _editor(dsl, { label, onChange, snippets = true }) {
        const wrap = el('div', 'tl-editor-wrap')
        const editor = document.createElement('code-editor')
        editor.className = 'tl-editor'
        editor.setAttribute('line-numbers', '')
        editor.setAttribute('spellcheck', 'false')
        editor.setAttribute('aria-label', label)
        wrap.append(editor)
        const status = el('div', 'tl-editor-status', { role: 'status', 'aria-live': 'polite' })
        wrap.append(status)
        customElements.whenDefined('code-editor').then(() => {
            editor.setTokenizer?.(dslTokenizer)
            editor.value = dsl
        })
        editor.value = dsl
        const commit = () => {
            clearTimeout(this._dslTimer)
            this._dslTimer = setTimeout(() => {
                const value = editor.value
                if (value === this._editorDsl) return
                this._editorDsl = value
                status.dataset.state = ''
                status.textContent = 'Compiling'
                onChange(value)
            }, 350)
        }
        editor.addEventListener('input', commit)
        editor.addEventListener('forcerecompile', commit)
        this.editor = editor
        this.editorStatus = status
        this._editorDsl = dsl
        this._showCompileState(dsl)
        const parts = [wrap]
        if (snippets) {
            const chips = el('div', 'tl-chips')
            for (const s of audioSnippets(this.store.seq)) {
                const chip = el('button', 'tl-chip', { type: 'button', title: `Insert ${s.code}` })
                chip.append(document.createTextNode(`${s.label} `), el('code', '', { text: 'audio()' }))
                chip.addEventListener('click', () => {
                    const start = editor.selectionStart ?? editor.value.length
                    const end = editor.selectionEnd ?? start
                    if (editor.replaceRange) editor.replaceRange(start, end, s.code)
                    else editor.value = editor.value.slice(0, start) + s.code + editor.value.slice(end)
                    editor.focus()
                    commit()
                })
                chips.append(chip)
            }
            parts.push(this._section('Wire audio', chips))
        }
        return parts
    }

    _showCompileState(dsl) {
        if (!this.editorStatus) return
        const err = this.pool.errorFor(dsl)
        if (err) {
            this.editorStatus.dataset.state = 'error'
            this.editorStatus.textContent = err
            return
        }
        const compiled = [...this.pool.entries.values()].some(e => e.compiled === dsl)
        this.editorStatus.dataset.state = compiled ? 'ok' : ''
        this.editorStatus.textContent = compiled ? 'Running' : 'Compiles when the playhead reaches it'
    }

    _onCompiled(entry, result) {
        if (!this.editorStatus || entry.wanted !== this._editorDsl) return
        if (result.success) {
            this.editorStatus.dataset.state = 'ok'
            this.editorStatus.textContent = 'Running'
        } else {
            this.editorStatus.dataset.state = 'error'
            this.editorStatus.textContent = result.error
        }
    }

    _editClip(id, label, fn, coalesce = null) {
        this.store.edit(label, seq => {
            const found = findClip(seq, id)
            if (!found) return false
            return fn(found.clip, found, seq)
        }, { coalesce })
    }

    _build(target) {
        this.fields = []
        this.editor = null
        this.editorStatus = null
        this.titleInput = null
        clearTimeout(this._dslTimer)
        const body = el('div', 'tl-insp-body')
        let head
        const seq = this.store.seq
        if (!seq) {
            this.root.replaceChildren()
            return
        }
        switch (target.kind) {
            case 'program': head = this._buildProgram(target, body); break
            case 'sequence': head = target.clip ? this._buildSequenceClip(target, body) : this._buildSequence(seq, body); break
            case 'audio': head = this._buildAudio(target, body); break
            case 'text': head = this._buildText(target, body); break
            case 'image': case 'video': head = this._buildMedia(target, body); break
            case 'transition': head = this._buildTransition(target, body); break
            case 'post': head = this._buildPost(seq, body); break
            case 'marker': head = this._buildMarker(target, body); break
            case 'multi': head = this._buildMulti(target, body); break
            default: head = this._buildSequence(seq, body)
        }
        this.root.replaceChildren(head, body)
    }

    _refresh(target) {
        for (const f of this.fields) {
            if (document.activeElement === f.input) continue
            f.refresh?.()
        }
        if (this.titleInput && document.activeElement !== this.titleInput) {
            const name = target.clip?.name ?? target.seq?.name ?? target.marker?.name
            if (name !== undefined) this.titleInput.value = name
        }
        if (this.editor && !this.editor.contains(document.activeElement)) {
            const dsl = target.clip?.dsl ?? (target.transition ? transitionDsl(target.transition) : null) ??
                (target.kind === 'post' ? this.store.seq.post.dsl : null)
            if (dsl !== null && dsl !== undefined && dsl !== this.editor.value) {
                this.editor.value = dsl
                this._editorDsl = dsl
                this._showCompileState(dsl)
            }
        }
    }

    _buildProgram(target, body) {
        const { clip } = target
        const id = clip.id
        const rename = name => this._editClip(id, 'Rename clip', c => { c.name = name })
        const head = this._head('code', clip.name, { tint: clip.tint, editable: rename })
        const get = key => () => findClip(this.store.seq, id)?.clip[key] ?? 0
        body.append(
            ...this._editor(clip.dsl, {
                label: 'Program DSL',
                onChange: dsl => {
                    this._editClip(id, 'Edit program', c => { c.dsl = dsl }, `dsl:${id}`)
                    this.actions.revealClip(id)
                },
            }),
            this._section('Timing', this._grid(
                this._timeField('Start', get('start'), t => this._editClip(id, 'Move clip', c => { c.start = Math.max(0, t) })),
                this._timeField('Duration', get('duration'), t => this.actions.setClipDuration(id, t)),
                this._timeField('Program time at start', get('offset'), t => this._editClip(id, 'Change clip offset', c => { c.offset = t })),
                ...this._loopField(clip),
            )),
            this._compositeSection(id),
            this._placementSection(id),
            this._keysSection(id),
        )
        return head
    }

    // --- graphics: text, image and video -----------------------------------------

    _colorField(label, get, set) {
        const input = el('input', '', { type: 'color' })
        const show = () => { input.value = /^#[0-9a-f]{6}$/i.test(get() || '') ? get() : '#000000' }
        show()
        input.addEventListener('input', () => set(input.value))
        this.fields.push({ input, refresh: show })
        return this._field(label, input)
    }

    _fontField(id) {
        const select = el('select')
        const current = () => findClip(this.store.seq, id)?.clip.font || 'Inter'
        const fill = () => {
            const fonts = fontCatalog() || []
            const groups = new Map()
            for (const f of fonts) {
                if (!groups.has(f.category)) groups.set(f.category, [])
                groups.get(f.category).push(f.name)
            }
            select.replaceChildren()
            if (!fonts.some(f => f.name === current())) select.append(el('option', '', { value: current(), text: current() }))
            for (const [category, names] of groups) {
                const group = el('optgroup', '', { label: category })
                for (const name of names) group.append(el('option', '', { value: name, text: name }))
                select.append(group)
            }
            select.value = current()
        }
        fill()
        if (!fontCatalog()) loadFontCatalog().then(fill).catch(() => {})
        select.addEventListener('change', () => this._editClip(id, 'Change font', c => { c.font = select.value }))
        this.fields.push({ input: select, refresh: () => { select.value = current() } })
        return this._field('Font', select)
    }

    // --- keys -------------------------------------------------------------------------------

    _easeOptions() {
        return [['none', 'none'], ...EASE_NAMES.filter(n => n !== 'none').flatMap(n => EASE_DIRECTIONS.map(d => [`${n}.${d}`, `${n}.${d}`]))]
    }

    /** Seconds into a clip at the playhead, kept inside the clip. */
    _clipTime(clip) {
        return Math.max(0, Math.min(clip.duration, this.store.playhead - clip.start))
    }

    _halfFrame() {
        return 0.5 / (this.store.seq?.fps || 30)
    }

    /**
     * A number for a property that can take keys. Without keys it edits the
     * clip's own value; with keys it shows and sets the value at the
     * playhead. Its diamond adds or removes a key at the playhead.
     */
    _keyedField(label, id, prop, { fallback = 0, toDisplay = v => v, fromDisplay = v => v, step = 1, min = null, max = null, digits = 2 } = {}) {
        const clipNow = () => findClip(this.store.seq, id)?.clip
        const valueNow = c => keyValue(c.keys?.[prop], this._clipTime(c), c[prop] ?? fallback)
        const input = el('input', '', { type: 'number', step: String(step), min: min ?? undefined, max: max ?? undefined })
        const diamond = el('button', 'tl-key', { type: 'button', 'aria-label': `Key ${label.toLowerCase()} at the playhead`, title: `Add or remove a ${label.toLowerCase()} key at the playhead`, 'aria-pressed': 'false' })
        diamond.append(icon('diamond'))
        const show = () => {
            const c = clipNow()
            if (!c) return
            input.value = String(Number(toDisplay(valueNow(c)).toFixed(digits)))
            diamond.setAttribute('aria-pressed', String(!!keyAt(c, prop, this._clipTime(c), this._halfFrame())))
            diamond.classList.toggle('has-keys', !!c.keys?.[prop])
        }
        show()
        input.addEventListener('change', () => {
            let v = Number(input.value)
            if (!Number.isFinite(v)) return show()
            if (min !== null) v = Math.max(min, v)
            if (max !== null) v = Math.min(max, v)
            v = fromDisplay(v)
            this._editClip(id, `Change ${label.toLowerCase()}`, c => {
                if (c.keys?.[prop]) setKey(c, prop, this._clipTime(c), v, { tolerance: this._halfFrame() })
                else c[prop] = v
            })
        })
        diamond.addEventListener('click', () => {
            this._editClip(id, 'Key at playhead', c => {
                const t = this._clipTime(c)
                if (keyAt(c, prop, t, this._halfFrame())) removeKey(c, prop, t, this._halfFrame())
                else setKey(c, prop, t, valueNow(c))
            })
        })
        this.fields.push({ input, refresh: show }, { input: diamond, refresh: show })
        const wrap = el('div', 'tl-keyed')
        wrap.append(input, diamond)
        return this._field(label, wrap)
    }

    /** The ease into the keys at the playhead, and a way to clear every key; shown when the clip has keys. */
    _keysSection(id) {
        const clip = findClip(this.store.seq, id)?.clip
        if (!clip?.keys) return el('div', '', { hidden: '' })
        const atPlayhead = c => Object.entries(c.keys || {}).flatMap(([prop, keys]) => keys.filter(k => Math.abs(k.t - this._clipTime(c)) <= this._halfFrame()).map(k => ({ prop, k })))
        const easeField = this._selectField('Ease into keys here', this._easeOptions(), () => {
            const c = findClip(this.store.seq, id)?.clip
            return (c && atPlayhead(c)[0]?.k.ease) || DEFAULT_KEY_EASE
        }, v => this._editClip(id, 'Change key ease', c => {
            const here = atPlayhead(c)
            if (!here.length) return false
            for (const { k } of here) k.ease = v
        }))
        const clear = el('button', 'tl-button', { type: 'button' })
        clear.append(icon('backspace'), document.createTextNode('Remove all keys'))
        clear.addEventListener('click', () => this._editClip(id, 'Remove keys', c => { delete c.keys }))
        const hint = el('p', 'tl-hint')
        const showHint = () => {
            const c = findClip(this.store.seq, id)?.clip
            const times = c ? keyTimes(c).map(t => formatTimecode(t, this.store.seq.fps)).join('  ') : ''
            hint.textContent = `Keys at ${times} from the clip's start. The ease shapes the change into a key from the one before.`
        }
        showHint()
        this.fields.push({ input: hint, refresh: showHint })
        return this._section('Keys',
            hint,
            this._grid(easeField),
            el('div', 'tl-button-row').appendChild(clear).parentNode)
    }

    _motionFields(id, side) {
        const get = () => findClip(this.store.seq, id)?.clip[side] || {}
        const edit = (label, fn) => this._editClip(id, label, c => { c[side] = { ...c[side] }; fn(c[side]) })
        const eases = this._easeOptions()
        const title = side === 'enter' ? 'Enter' : 'Exit'
        return [
            this._selectField(title, MOTION_PRESETS.map(m => [m, m]), () => get().preset || 'none', v => edit(`Change ${side} motion`, m => { m.preset = v })),
            this._numberField(`${title} seconds`, () => get().duration ?? 0.5, v => edit(`Change ${side} motion`, m => { m.duration = Math.max(0, v) }), { step: 0.05, min: 0, digits: 2 }),
            this._selectField(`${title} ease`, eases, () => get().ease || 'power1.out', v => edit(`Change ${side} motion`, m => { m.ease = v })),
        ]
    }

    /** Placement, motion, timing and compositing, shared by text, image and video clips. */
    _graphicSections(id) {
        const get = key => () => findClip(this.store.seq, id)?.clip[key] ?? 0
        return [
            this._placementSection(id),
            this._section('Motion', this._grid(...this._motionFields(id, 'enter'), ...this._motionFields(id, 'exit'))),
            this._section('Timing', this._grid(
                this._timeField('Start', get('start'), t => this._editClip(id, 'Move clip', c => { c.start = Math.max(0, t) })),
                this._timeField('Duration', get('duration'), t => this.actions.setClipDuration(id, t)),
            )),
            this._compositeSection(id),
            this._keysSection(id),
        ]
    }

    /** Position, scale and rotation, each keyable. */
    _placementSection(id) {
        const pct = { toDisplay: v => v * 100, fromDisplay: v => v / 100, step: 1, digits: 1 }
        return this._section('Position', this._grid(
            this._keyedField('X %', id, 'x', { fallback: 0.5, ...pct }),
            this._keyedField('Y %', id, 'y', { fallback: 0.5, ...pct }),
            this._keyedField('Scale %', id, 'scale', { fallback: 1, ...pct, min: 0 }),
            this._keyedField('Rotation °', id, 'rotation', { fallback: 0, step: 1, digits: 1 }),
        ))
    }

    /** Opacity (keyable) and blend mode. */
    _compositeSection(id) {
        return this._section('Composite', this._grid(
            this._keyedField('Opacity %', id, 'opacity', { fallback: 1, toDisplay: v => v * 100, fromDisplay: v => v / 100, step: 1, min: 0, max: 100, digits: 0 }),
            this._selectField('Blend', BLEND_MODES.map(m => [m, m]), () => findClip(this.store.seq, id)?.clip.blend || 'normal',
                v => this._editClip(id, 'Change blend mode', c => { c.blend = v })),
        ))
    }

    _buildText(target, body) {
        const { clip } = target
        const id = clip.id
        const head = this._head('title', clip.name, { editable: name => this._editClip(id, 'Rename clip', c => { c.name = name }) })
        const get = key => () => findClip(this.store.seq, id)?.clip[key] ?? 0
        const words = el('textarea', 'tl-textarea', { rows: '3', spellcheck: 'true', 'aria-label': 'Text' })
        const showWords = () => { words.value = findClip(this.store.seq, id)?.clip.text ?? '' }
        showWords()
        words.addEventListener('input', () => this._editClip(id, 'Edit text', c => { c.text = words.value }, `text:${id}`))
        this.fields.push({ input: words, refresh: showWords })
        const hasBackground = () => !!findClip(this.store.seq, id)?.clip.background
        body.append(
            this._section('Text', words),
            this._section('Style', this._grid(
                this._fontField(id),
                this._selectField('Weight', [100, 200, 300, 400, 500, 600, 700, 800, 900].map(w => [String(w), String(w)]), get('weight'),
                    v => this._editClip(id, 'Change weight', c => { c.weight = Number(v) })),
                this._numberField('Size % of height', () => get('size')() * 100, v => this._editClip(id, 'Change text size', c => { c.size = Math.max(0.1, v) / 100 }), { step: 0.5, min: 0.1, digits: 1 }),
                this._colorField('Colour', () => findClip(this.store.seq, id)?.clip.color, v => this._editClip(id, 'Change colour', c => { c.color = v }, `color:${id}`)),
                this._selectField('Align', TEXT_ALIGN.map(a => [a, a]), () => findClip(this.store.seq, id)?.clip.align || 'center',
                    v => this._editClip(id, 'Change alignment', c => { c.align = v })),
                this._checkField('Italic', () => findClip(this.store.seq, id)?.clip.italic, v => this._editClip(id, 'Change italic', c => { c.italic = v })),
                this._numberField('Line height', get('lineHeight'), v => this._editClip(id, 'Change line height', c => { c.lineHeight = Math.max(0.1, v) }), { step: 0.05, min: 0.1, digits: 2 }),
                this._numberField('Letter spacing', get('letterSpacing'), v => this._editClip(id, 'Change letter spacing', c => { c.letterSpacing = v }), { step: 0.01, digits: 2 }),
                this._numberField('Wrap width %', () => get('maxWidth')() * 100, v => this._editClip(id, 'Change wrap width', c => { c.maxWidth = Math.max(1, v) / 100 }), { step: 1, min: 1, digits: 0 }),
                this._checkField('Background', hasBackground, v => this._editClip(id, 'Change background', c => { c.background = v ? '#000000' : null })),
                this._colorField('Background colour', () => findClip(this.store.seq, id)?.clip.background || '#000000',
                    v => this._editClip(id, 'Change background', c => { c.background = v }, `background:${id}`)),
            )),
            ...this._graphicSections(id),
        )
        return head
    }

    _buildMedia(target, body) {
        const { clip } = target
        const id = clip.id
        const media = this.store.project.media[clip.mediaId]
        const head = this._head(clip.type === 'video' ? 'movie' : 'image', clip.name, { editable: name => this._editClip(id, 'Rename clip', c => { c.name = name }) })
        const get = key => () => findClip(this.store.seq, id)?.clip[key] ?? 0
        const about = media ? [media.name, media.width ? `${media.width}×${media.height}` : '', clip.type === 'video' ? formatTimecode(media.duration || 0, this.store.seq.fps) : ''].filter(Boolean).join('  ') : 'The media for this clip is missing'
        const source = [
            this._selectField('Fit', FIT_MODES.map(f => [f, f]), () => findClip(this.store.seq, id)?.clip.fit || 'contain', v => this._editClip(id, 'Change fit', c => { c.fit = v })),
        ]
        if (clip.type === 'video') {
            source.push(
                this._timeField('Source in', get('offset'), t => this._editClip(id, 'Change source in', c => { c.offset = Math.max(0, t) })),
                this._checkField('Loop', () => findClip(this.store.seq, id)?.clip.loopVideo, v => this._editClip(id, 'Change video loop', c => { c.loopVideo = v })),
            )
        }
        body.append(
            el('p', 'tl-hint', { text: `${about}. A program clip above this one that reads media() processes it.` }),
            this._section('Source', this._grid(...source)),
            ...this._graphicSections(id),
        )
        return head
    }

    _buildSequenceClip(target, body) {
        const { clip } = target
        const id = clip.id
        const rename = name => this._editClip(id, 'Rename clip', c => { c.name = name })
        const head = this._head('layers', clip.name, { editable: rename })
        const project = this.store.project
        const options = project.sequenceOrder
            .filter(sid => sid !== this.store.seq.id)
            .map(sid => [sid, project.sequences[sid].name])
        const get = key => () => findClip(this.store.seq, id)?.clip[key] ?? 0
        const open = el('button', 'tl-button', { type: 'button' })
        open.append(icon('open_in_new'), document.createTextNode('Open sequence'))
        open.addEventListener('click', () => this.store.setActiveSequence(findClip(this.store.seq, id)?.clip.sequenceId))
        body.append(
            el('p', 'tl-hint', { text: 'A nested sequence renders its own tracks, transitions and post chain, then composites here like any clip. Programs inside it read this sequence’s audio.' }),
            el('div', 'tl-button-row').appendChild(open).parentNode,
            this._section('Source', this._grid(
                this._selectField('Sequence', options, () => findClip(this.store.seq, id)?.clip.sequenceId,
                    v => this.actions.setNestedSequence(id, v)),
                this._checkField('Loop', () => findClip(this.store.seq, id)?.clip.loopSequence !== false,
                    v => this._editClip(id, 'Change nested loop', c => { c.loopSequence = v })),
            )),
            this._section('Timing', this._grid(
                this._timeField('Start', get('start'), t => this._editClip(id, 'Move clip', c => { c.start = Math.max(0, t) })),
                this._timeField('Duration', get('duration'), t => this.actions.setClipDuration(id, t)),
                this._timeField('Sequence time at start', get('offset'), t => this._editClip(id, 'Change clip offset', c => { c.offset = t })),
            )),
            this._compositeSection(id),
            this._placementSection(id),
            this._keysSection(id),
        )
        return head
    }

    _buildAudio(target, body) {
        const { clip, track } = target
        const id = clip.id
        const rename = name => this._editClip(id, 'Rename clip', c => { c.name = name })
        const head = this._head('graphic_eq', clip.name, { tint: 'var(--hf-green)', editable: rename })
        const get = key => () => findClip(this.store.seq, id)?.clip[key] ?? 0
        const channel = this.store.seq.audioTracks.indexOf(track) + 1
        body.append(
            el('p', 'tl-hint', { text: `Programs read this track with audio(band: audioBand.low, channel: ${channel}). Muting a track silences it but keeps it driving visuals.` }),
            this._section('Timing', this._grid(
                this._timeField('Start', get('start'), t => this._editClip(id, 'Move clip', c => { c.start = Math.max(0, t) })),
                this._timeField('Duration', get('duration'), t => this.actions.setClipDuration(id, t)),
                this._timeField('Source in', get('offset'), t => this._editClip(id, 'Change source in', c => { c.offset = Math.max(0, t) })),
            )),
            this._section('Level', this._grid(
                this._keyedField('Gain dB', id, 'gain', { fallback: 1, toDisplay: gainToDb, fromDisplay: dbToGain, step: 0.5, min: -60, max: 12, digits: 1 }),
                this._numberField('Fade in s', get('fadeIn'), v => this._editClip(id, 'Change fade', c => { c.fadeIn = Math.max(0, v) }), { step: 0.1, min: 0 }),
                this._numberField('Fade out s', get('fadeOut'), v => this._editClip(id, 'Change fade', c => { c.fadeOut = Math.max(0, v) }), { step: 0.1, min: 0 }),
            )),
            this._keysSection(id),
            this._duckSection(track.id),
        )
        return head
    }

    /** Ducking for a whole audio track: it dips while another track plays. */
    _duckSection(trackId) {
        const trackNow = () => this.store.seq.audioTracks.find(t => t.id === trackId)
        const editTrack = (label, fn) => this.store.edit(label, seq => {
            const t = seq.audioTracks.find(x => x.id === trackId)
            if (!t) return false
            return fn(t, seq)
        })
        const others = this.store.seq.audioTracks.filter(t => t.id !== trackId)
        const underId = () => {
            const t = trackNow()
            const under = t?.duck?.under
            return others.find(o => o.id === under || o.name === under)?.id || ''
        }
        const setting = (label, key, unit, opts) => this._numberField(`${label} ${unit}`, () => trackNow()?.duck?.[key] ?? DUCK_DEFAULTS[key],
            v => editTrack(`Change ducking`, t => {
                if (!t.duck) return false
                t.duck = { ...t.duck, [key]: v }
            }), opts)
        return this._section(`Ducking for ${trackNow()?.name || 'this track'}`,
            el('p', 'tl-hint', { text: 'The whole track dips while the chosen track is sounding, such as music under a voice. Short pauses stay ducked.' }),
            this._grid(
                this._selectField('Duck under', [['', 'None'], ...others.map(o => [o.id, o.name])], underId, v => editTrack('Change ducking', t => {
                    if (!v) delete t.duck
                    else t.duck = { ...DUCK_DEFAULTS, ...(t.duck || {}), under: v }
                })),
                this._selectField('Duck while', [['signal', 'it is sounding'], ['clips', 'its clips play']], () => trackNow()?.duck?.detect || 'signal',
                    v => editTrack('Change ducking', t => {
                        if (!t.duck) return false
                        t.duck = { ...t.duck, detect: v }
                    })),
                setting('Depth', 'depth', 'dB', { step: 1, max: 0, min: -60, digits: 1 }),
                setting('Down over', 'attack', 's', { step: 0.05, min: 0, digits: 2 }),
                setting('Back up over', 'release', 's', { step: 0.05, min: 0, digits: 2 }),
                setting('Hold gaps under', 'hold', 's', { step: 0.1, min: 0, digits: 2 }),
                setting('Sounding above', 'threshold', 'dB', { step: 1, max: 0, min: -90, digits: 0 }),
            ))
    }

    _buildTransition(target, body) {
        const { transition, track } = target
        const id = transition.id
        const span = transitionSpan(track, transition)
        const isFade = !(transition.from && transition.to)
        const head = this._head('join', isFade ? (transition.from ? 'Fade out' : 'Fade in') : transitionPreset(transition.preset).name, {
            tint: span?.b?.tint || span?.a?.tint,
        })
        const editT = (label, fn, coalesce) => this.store.edit(label, seq => {
            const found = findTransition(seq, id)
            if (!found) return false
            return fn(found.transition, found.track)
        }, { coalesce })
        const durationField = this._numberField('Length s', () => findTransition(this.store.seq, id)?.transition.duration ?? 0,
            v => editT('Change transition length', (t, tr) => { t.duration = Math.max(1 / 120, Math.min(v, maxTransitionDuration(tr, t))) }),
            { step: 0.05, min: 0.02, digits: 3 })
        const beats = el('div', 'tl-button-row')
        const seq = this.store.seq
        for (const [label, n] of [['1 beat', 1], ['2 beats', 2], ['1 bar', seq.beatsPerBar], ['2 bars', seq.beatsPerBar * 2]]) {
            const b = el('button', 'tl-button', { type: 'button', text: label })
            b.addEventListener('click', () => editT('Change transition length', (t, tr) => {
                t.duration = Math.min(beatSeconds(seq.bpm) * n, maxTransitionDuration(tr, t))
            }))
            beats.append(b)
        }
        const remove = el('button', 'tl-button is-danger', { type: 'button' })
        remove.append(icon('delete'), document.createTextNode('Remove transition'))
        remove.addEventListener('click', () => this.actions.deleteSelection())
        if (isFade) {
            body.append(
                el('p', 'tl-hint', { text: 'Fades the clip in from, or out to, whatever is below it on the timeline.' }),
                this._section('Length', this._grid(durationField), beats),
                el('div', 'tl-button-row').appendChild(remove).parentNode,
            )
            return head
        }
        body.append(
            el('p', 'tl-hint', { text: 'The first media() is the outgoing clip and the second the incoming one. This program’s clock runs from 0 to 1 across the transition: osc(type: oscKind.saw) is its progress.' }),
            this._section('Transition', this._grid(
                this._selectField('Preset', TRANSITIONS.map(t => [t.id, t.name]), () => findTransition(this.store.seq, id)?.transition.preset,
                    v => editT('Change transition', t => { t.preset = v; t.dsl = transitionPreset(v).dsl })),
                durationField,
            ), beats),
            ...this._editor(transitionDsl(transition), {
                label: 'Transition DSL',
                snippets: true,
                onChange: dsl => {
                    editT('Edit transition', t => { t.dsl = dsl }, `tdsl:${id}`)
                    if (span) this.actions.revealTime((span.start + span.end) / 2)
                },
            }),
            el('div', 'tl-button-row').appendChild(remove).parentNode,
        )
        return head
    }

    _buildPost(seq, body) {
        const head = this._head('auto_awesome', `Post chain`, {})
        const editP = (label, fn, coalesce) => this.store.edit(label, s => fn(s.post), { coalesce })
        body.append(
            el('p', 'tl-hint', { text: `Every frame of ${seq.name} passes through this chain. media() is the composited timeline; audio() reads the same tracks as the clips.` }),
            this._section('Chain', this._grid(
                this._checkField('On', () => this.store.seq.post.enabled, v => editP('Toggle post chain', p => { p.enabled = v })),
                this._selectField('Preset', POST_PRESETS.map(p => [p.id, p.name]), () => this.store.seq.post.preset,
                    v => editP('Change post preset', p => { p.preset = v; p.dsl = postPreset(v).dsl; p.enabled = true })),
                this._numberField('Loop s', () => this.store.seq.post.loop || 8, v => editP('Change post loop', p => { p.loop = v }), { step: 0.5, min: 0.1 }),
            )),
            ...this._editor(seq.post.dsl, {
                label: 'Post chain DSL',
                onChange: dsl => editP('Edit post chain', p => { p.dsl = dsl }, `post:${seq.id}`),
            }),
        )
        return head
    }

    _buildMarker(target, body) {
        const { marker } = target
        const id = marker.id
        const editM = (label, fn) => this.store.edit(label, s => {
            const m = s.markers.find(x => x.id === id)
            if (!m) return false
            return fn(m, s)
        })
        const head = this._head('bookmark', marker.name, { tint: 'var(--hf-yellow)', editable: name => editM('Rename marker', m => { m.name = name }) })
        const remove = el('button', 'tl-button is-danger', { type: 'button' })
        remove.append(icon('delete'), document.createTextNode('Delete marker'))
        remove.addEventListener('click', () => this.actions.deleteSelection())
        body.append(
            this._section('Marker', this._grid(
                this._timeField('Time', () => this.store.seq.markers.find(m => m.id === id)?.time ?? 0,
                    t => editM('Move marker', (m, s) => { m.time = Math.max(0, Math.min(s.duration, t)); s.markers.sort((a, b) => a.time - b.time) })),
            )),
            el('div', 'tl-button-row').appendChild(remove).parentNode,
        )
        return head
    }

    _buildMulti(target, body) {
        const head = this._head('select_all', `${target.ids.length} clips`, {})
        const remove = el('button', 'tl-button is-danger', { type: 'button' })
        remove.append(icon('delete'), document.createTextNode('Delete clips'))
        remove.addEventListener('click', () => this.actions.deleteSelection())
        const blend = this._selectField('Blend', BLEND_MODES.map(m => [m, m]), () => 'normal', v => this.store.edit('Change blend mode', seq => {
            for (const cid of target.ids) {
                const f = findClip(seq, cid)
                if (f && f.kind === 'visual') f.clip.blend = v
            }
        }))
        body.append(
            el('p', 'tl-hint', { text: 'Drag any selected clip to move them together.' }),
            this._section('Composite', this._grid(blend)),
            el('div', 'tl-button-row').appendChild(remove).parentNode,
        )
        return head
    }

    _buildSequence(seq, body) {
        const editS = (label, fn) => this.store.edit(label, s => fn(s))
        const head = this._head('movie', seq.name, { editable: name => editS('Rename sequence', s => { s.name = name }) })
        const resOptions = RESOLUTIONS.slice()
        const current = `${seq.width}x${seq.height}`
        if (!resOptions.some(([v]) => v === current)) resOptions.push([current, `${seq.width} × ${seq.height}`])
        const wiring = el('div', 'tl-kbd-list')
        wiring.append(el('kbd', '', { text: 'audio(band: audioBand.low)' }), el('span', '', { text: 'The mix' }))
        seq.audioTracks.forEach((t, i) => {
            wiring.append(el('kbd', '', { text: `channel: ${i + 1}` }), el('span', '', { text: t.name }))
        })
        wiring.append(el('kbd', '', { text: 'audioBand' }), el('span', '', { text: 'low, mid, high, vol, raw' }))
        const keys = el('div', 'tl-kbd-list')
        for (const [k, v] of SHORTCUTS) keys.append(el('kbd', '', { text: k }), el('span', '', { text: v }))
        const detect = el('div', 'tl-button-row')
        detect.style.marginTop = '8px'
        const detectBtn = el('button', 'tl-button', { type: 'button', title: 'Find the tempo and first beat of this sequence\u2019s audio' })
        detectBtn.append(icon('graphic_eq'), document.createTextNode('Detect tempo from audio'))
        detectBtn.addEventListener('click', () => this.actions.detectTempo())
        detect.append(detectBtn)
        body.append(
            this._section('Format', this._grid(
                this._selectField('Resolution', resOptions, () => `${this.store.seq.width}x${this.store.seq.height}`, v => {
                    const [w, h] = v.split('x').map(Number)
                    editS('Change resolution', s => { s.width = w; s.height = h })
                }),
                this._selectField('Frame rate', [24, 25, 30, 50, 60].map(f => [String(f), `${f} fps`]), () => this.store.seq.fps,
                    v => editS('Change frame rate', s => { s.fps = Number(v) })),
                this._timeField('Duration', () => this.store.seq.duration, t => editS('Change duration', s => { s.duration = Math.max(1, t) })),
            )),
            this._section('Tempo', this._grid(
                this._numberField('BPM', () => this.store.seq.bpm, v => editS('Change tempo', s => { s.bpm = v }), { step: 1, min: 20, max: 300, digits: 2 }),
                this._numberField('Beats per bar', () => this.store.seq.beatsPerBar, v => editS('Change meter', s => { s.beatsPerBar = Math.round(v) }), { step: 1, min: 1, max: 16, digits: 0 }),
                this._numberField('First beat s', () => this.store.seq.gridOffset || 0, v => editS('Move beat grid', s => { s.gridOffset = Math.max(0, v) }), { step: 0.01, min: 0, digits: 3 }),
                this._numberField('Audio sensitivity', () => this.store.seq.audioSensitivity ?? 1, v => editS('Change sensitivity', s => { s.audioSensitivity = v }), { step: 0.1, min: 0.1, max: 8, digits: 1 }),
            ), detect),
            this._section('Audio in the DSL', wiring),
            this._section('Keyboard', keys),
        )
        return head
    }
}

