/**
 * Application state: the open project, the active sequence, selection,
 * playhead and view settings, with undo history and debounced autosave.
 *
 * A project saves to this browser's storage, or, when it was opened from a
 * folder (`source`), back to that folder, and only after an edit here.
 *
 * Components subscribe to topics:
 *   project    the document changed (re-render the timeline, inspector)
 *   selection  what is selected changed
 *   playhead   the playhead moved (cheap; fires every frame during playback)
 *   view       zoom, scroll, snapping, preview scale
 *   status     transient status text
 */

import { History } from './model/history.js'
import { getSequence } from './model/project.js'
import { saveProject, writePrefs, readPrefs } from './storage/db.js'
import { clamp } from './model/time.js'

export class Store {
    constructor() {
        this.project = null
        this.source = null
        this.problems = []
        this._unsaved = false
        this.activeSeqId = null
        this.selection = { clips: new Set(), transition: null, marker: null, post: false, track: null }
        this.playheads = new Map()
        this.playing = false
        this.loopPlayback = false
        const prefs = readPrefs()
        this.view = {
            pxPerSecond: prefs.pxPerSecond || 24,
            scrollX: 0,
            snapping: prefs.snapping !== false,
            beatGrid: prefs.beatGrid !== false,
            previewScale: prefs.previewScale || 0.5,
        }
        this.history = new History()
        this.listeners = new Map()
        this._saveTimer = null
        this.saveState = 'saved'
    }

    on(topic, fn) {
        if (!this.listeners.has(topic)) this.listeners.set(topic, new Set())
        this.listeners.get(topic).add(fn)
        return () => this.listeners.get(topic).delete(fn)
    }

    emit(topic, detail) {
        for (const fn of this.listeners.get(topic) || []) {
            try {
                fn(detail)
            } catch (err) {
                console.error(`[timeline] ${topic} listener failed`, err)
            }
        }
    }

    get seq() {
        return getSequence(this.project, this.activeSeqId)
    }

    get playhead() {
        return this.playheads.get(this.activeSeqId) || 0
    }

    // --- project ---------------------------------------------------------

    openProject(project, { source = null, problems = [] } = {}) {
        this.source?.stop()
        this.project = project
        this.source = source
        this.problems = problems
        this._unsaved = false
        this.activeSeqId = project.mainSequenceId
        this.playheads = new Map()
        this.history.clear()
        this.clearSelection(false)
        if (!source) writePrefs({ lastProjectId: project.id })
        this.emit('project', { reason: 'open' })
        this.emit('selection')
        this.emit('playhead')
    }

    /**
     * Take a new version of the open project that changed outside this page
     * (its folder was edited). The version it replaces stays in the undo
     * history, so an unwanted change is one undo away.
     */
    replaceProject(project, { problems = [], label = 'Changes from disk' } = {}) {
        this.history.push(this.project, label)
        this.project = project
        this.problems = problems
        // The disk now holds this version; an edit not yet written is the undo step.
        clearTimeout(this._saveTimer)
        this._unsaved = false
        this.saveState = 'saved'
        if (!this.project.sequences[this.activeSeqId]) this.activeSeqId = this.project.mainSequenceId
        this._pruneSelection()
        this.emit('project', { reason: 'external' })
        this.emit('selection')
        this.emit('playhead')
    }

    setActiveSequence(id) {
        if (!this.project.sequences[id] || id === this.activeSeqId) return
        this.activeSeqId = id
        this.clearSelection(false)
        this.emit('project', { reason: 'sequence' })
        this.emit('selection')
        this.emit('playhead')
    }

    /**
     * Run one undoable edit. `fn(seq, project)` mutates in place; return
     * false to cancel (nothing is recorded).
     */
    edit(label, fn, { coalesce = null } = {}) {
        const before = structuredClone(this.project)
        const result = fn(this.seq, this.project)
        if (result === false) return result
        const now = performance.now()
        const canCoalesce = coalesce && this._lastCoalesce?.key === coalesce && now - this._lastCoalesce.at < 1200
        if (!canCoalesce) this.history.push(before, label)
        this._lastCoalesce = coalesce ? { key: coalesce, at: now } : null
        this._changed()
        return result
    }

    _changed(reason = 'edit') {
        this.project.updatedAt = Date.now()
        this._unsaved = true
        this._pruneSelection()
        this.emit('project', { reason })
        this.scheduleSave()
    }

    undo() {
        const prev = this.history.undo(this.project)
        if (!prev) return
        this.project = prev
        if (!this.project.sequences[this.activeSeqId]) this.activeSeqId = this.project.mainSequenceId
        this._changed('undo')
        this.emit('selection')
    }

    redo() {
        const next = this.history.redo(this.project)
        if (!next) return
        this.project = next
        if (!this.project.sequences[this.activeSeqId]) this.activeSeqId = this.project.mainSequenceId
        this._changed('redo')
        this.emit('selection')
    }

    scheduleSave() {
        this.saveState = 'pending'
        this.emit('status')
        clearTimeout(this._saveTimer)
        this._saveTimer = setTimeout(() => this.saveNow(), 600)
    }

    async saveNow() {
        clearTimeout(this._saveTimer)
        if (!this.project) return
        // A folder is written only when the project changed here, never just for opening it.
        if (this.source && !this._unsaved) return
        const order = (this._saveOrder || 0) + 1
        this._saveOrder = order
        this._unsaved = false
        try {
            // A folder that changed on disk is not overwritten; its watcher reloads it.
            if (this.source) await this.source.save(this.project)
            else await saveProject(this.project)
            if (this._saveOrder === order) this.saveState = 'saved'
        } catch (err) {
            console.warn('[timeline] save failed', err)
            this._unsaved = true
            this.saveState = 'error'
        }
        this.emit('status')
    }

    // --- selection -------------------------------------------------------

    clearSelection(emit = true) {
        this.selection = { clips: new Set(), transition: null, marker: null, post: false, track: this.selection?.track || null }
        if (emit) this.emit('selection')
    }

    selectClip(id, { additive = false } = {}) {
        const clips = additive ? new Set(this.selection.clips) : new Set()
        if (additive && clips.has(id)) clips.delete(id)
        else clips.add(id)
        this.selection = { clips, transition: null, marker: null, post: false, track: this.selection.track }
        this.emit('selection')
    }

    selectClips(ids) {
        this.selection = { clips: new Set(ids), transition: null, marker: null, post: false, track: this.selection.track }
        this.emit('selection')
    }

    selectTransition(id) {
        this.selection = { clips: new Set(), transition: id, marker: null, post: false, track: this.selection.track }
        this.emit('selection')
    }

    selectPost() {
        this.selection = { clips: new Set(), transition: null, marker: null, post: true, track: this.selection.track }
        this.emit('selection')
    }

    selectMarker(id) {
        this.selection = { clips: new Set(), transition: null, marker: id, post: false, track: this.selection.track }
        this.emit('selection')
    }

    setTargetTrack(trackId) {
        this.selection.track = trackId
        this.emit('selection')
    }

    _pruneSelection() {
        const seq = this.seq
        if (!seq) return
        const ids = new Set()
        for (const t of [...seq.tracks, ...seq.audioTracks]) for (const c of t.clips) ids.add(c.id)
        for (const id of [...this.selection.clips]) if (!ids.has(id)) this.selection.clips.delete(id)
        if (this.selection.transition && !seq.tracks.some(t => t.transitions.some(x => x.id === this.selection.transition))) {
            this.selection.transition = null
        }
    }

    // --- playhead and view -------------------------------------------------

    setPlayhead(t, { snap = true } = {}) {
        const seq = this.seq
        if (!seq) return
        let time = clamp(t, 0, seq.duration)
        if (snap) time = Math.floor(time * seq.fps + 1e-6) / seq.fps
        this.playheads.set(this.activeSeqId, time)
        this.emit('playhead')
    }

    setView(patch) {
        Object.assign(this.view, patch)
        const { pxPerSecond, snapping, beatGrid, previewScale } = this.view
        writePrefs({ pxPerSecond, snapping, beatGrid, previewScale })
        this.emit('view')
    }

    setPlaying(playing) {
        this.playing = playing
        this.emit('transport')
    }
}
