/**
 * Timeline: cut Noisemaker DSL programs to music.
 *
 * Boot loads the engine, opens the last project (or the demo), and wires
 * the store, audio engine, renderer pool and views together. One
 * requestAnimationFrame loop drives playback: the audio clock sets the
 * playhead, the playhead's frame is rendered once, and nothing renders
 * while nothing changes.
 */

import { initEscapeHandler, initializeTooltips, showToast, AboutDialog, hasOpenEscapeables, formatShortcut } from 'handfish'
import { BootProgress, formatBytes } from './ui/bootProgress.js'
import { ENGINE_URL } from './noisemaker/cdn.js'
import { fetchBytes } from './fetchBytes.js'

const boot = new BootProgress(document.getElementById('boot'))

let engine
try {
    boot.start('engine')
    // Download the engine with progress; the import below reads it from the HTTP cache.
    let engineBytes = 0
    await fetchBytes(ENGINE_URL, (fraction, received, total) => {
        engineBytes = total
        boot.progress('engine', fraction, `${formatBytes(received)} of ${formatBytes(total)}`)
    }).catch(err => console.warn('[timeline] engine prefetch failed', err))
    engine = await import('./noisemaker/bundle.js')
    boot.done('engine', engineBytes ? formatBytes(engineBytes) : '')
} catch (err) {
    console.error(err)
    boot.fail('The Noisemaker engine did not load. Check your connection and reload the page.')
    throw err
}

boot.start('editor')

const { Store } = await import('./store.js')
const { AudioEngine } = await import('./audio/engine.js')
const { importAudioFile, getAudioBuffer, usesEarlierDemo } = await import('./audio/media.js')
const { RendererPool } = await import('./render/pool.js')
const { SequenceRenderer } = await import('./render/sequenceRenderer.js')
const { Thumbnails } = await import('./render/thumbnails.js')
const { TimelineView } = await import('./ui/timeline.js')
const { MonitorView } = await import('./ui/monitor.js')
const { InspectorView } = await import('./ui/inspector.js')
const { LibraryView } = await import('./ui/library.js')
const { ExportDialog } = await import('./ui/exportDialog.js')
const { askText, askConfirm } = await import('./ui/dialogs.js')
const { createDemoProject } = await import('./data/demoProject.js')
const { transitionPreset, postPreset, DEFAULT_TRANSITION } = await import('./data/presets.js')
const model = await import('./model/project.js')
const edits = await import('./model/edit.js')
const { frameAt, beatSeconds, barSeconds, clamp } = await import('./model/time.js')
const { loadProject, listProjects, readPrefs, writePrefs, saveProject } = await import('./storage/db.js')
const { projectToFile, projectFromFile, PROJECT_EXTENSION } = await import('./storage/projectFile.js')
const { exportSequence } = await import('./export/exporter.js')
boot.done('editor')

const store = new Store()
const audio = new AudioEngine({ AudioState: engine.AudioState })
const pool = new RendererPool({ capacity: 12, width: 960, height: 540, audioState: audio.state })
const renderer = new SequenceRenderer({ pool, audio, getProject: () => store.project })
const thumbs = new Thumbnails({ AudioState: engine.AudioState })

let dirty = true
let lastFrame = -1
let lastSeqId = null
let clipboard = null

// --- actions ---------------------------------------------------------------

const actions = {
    status(message) {
        showToast(message, { type: 'info', duration: 3200 })
    },

    redraw() {
        dirty = true
    },

    seek(t) {
        const playing = store.playing
        if (playing) audio.stop()
        store.setPlayhead(t)
        dirty = true
        if (playing) audio.play(store.seq, store.playhead)
    },

    scrubTo(t, { quiet = false } = {}) {
        if (store.playing) actions.pause()
        store.setPlayhead(t)
        dirty = true
        if (!quiet) audio.scrub(store.seq, store.playhead)
    },

    step(frames) {
        if (store.playing) actions.pause()
        const seq = store.seq
        store.setPlayhead(store.playhead + frames / seq.fps)
        dirty = true
    },

    stepBeats(n) {
        const seq = store.seq
        const beat = beatSeconds(seq.bpm)
        const off = seq.gridOffset || 0
        const cur = store.playhead - off
        const target = n > 0 ? Math.floor(cur / beat + 1e-6) * beat + n * beat : Math.ceil(cur / beat - 1e-6) * beat + n * beat
        actions.seek(target + off)
    },

    async detectTempo() {
        const seq = store.seq
        await audio.mix(store.project, seq)
        const master = audio.currentMix(seq.id)?.master
        if (!master) {
            actions.status('Add audio to this sequence first')
            return
        }
        const { detectTempo } = await import('./audio/tempo.js')
        const channels = [master.getChannelData(0), master.getChannelData(1)]
        const result = detectTempo(channels, master.sampleRate)
        if (!result) {
            actions.status('The audio is too short to find a tempo')
            return
        }
        store.edit('Detect tempo', s => {
            s.bpm = result.bpm
            s.gridOffset = Math.round(result.offset * 1000) / 1000
        })
        actions.status(`${result.bpm} BPM, first beat at ${result.offset.toFixed(3)} s`)
    },

    async play() {
        if (store.playing || actions._starting) return
        actions._starting = true
        try {
            await actions._start()
        } finally {
            actions._starting = false
        }
    },

    async _start() {
        await audio.unlock()
        const seq = store.seq
        const range = store.loopPlayback ? model.workRange(seq) : { start: 0, end: seq.duration }
        if (store.playhead >= range.end - 1 / seq.fps || store.playhead < range.start && store.loopPlayback) store.setPlayhead(range.start)
        await audio.mix(store.project, seq)
        audio.play(seq, store.playhead)
        store.setPlaying(true)
        thumbs.paused = true
    },

    pause() {
        if (!store.playing) return
        audio.stop()
        store.setPlaying(false)
        thumbs.paused = false
        dirty = true
    },

    togglePlay() {
        if (store.playing) actions.pause()
        else actions.play()
    },

    toggleLoop() {
        store.loopPlayback = !store.loopPlayback
        store.emit('transport')
        timeline.render()
    },

    cutAtPlayhead() {
        const seq = store.seq
        const t = store.playhead
        const sel = store.selection
        const trackIds = sel.clips.size
            ? [...sel.clips].map(id => model.findClip(seq, id)?.track.id).filter(Boolean)
            : null
        let made = []
        store.edit('Cut', s => {
            made = edits.splitAt(s, t, trackIds)
            return made.length ? undefined : false
        })
        if (!made.length) actions.status('No clip under the playhead to cut')
    },

    addTransitionAtPlayhead(presetId = DEFAULT_TRANSITION) {
        const seq = store.seq
        const track = seq.tracks.find(t => t.id === store.selection.track) || seq.tracks.find(t => t.clips.length) || seq.tracks[0]
        const cut = edits.cutNear(track, store.playhead)
        if (!cut) {
            actions.status('There is no cut on this track to put a transition on')
            return
        }
        let created = null
        store.edit('Add transition', s => {
            const tr = s.tracks.find(x => x.id === track.id)
            created = edits.addTransition(tr, {
                from: cut.from, to: cut.to, duration: beatSeconds(s.bpm) * 2,
                preset: presetId, dsl: transitionPreset(presetId).dsl,
            })
            return created ? undefined : false
        })
        if (created) store.selectTransition(created.id)
    },

    applyTransitionPreset(presetId) {
        const sel = store.selection
        if (sel.transition) {
            store.edit('Change transition', s => {
                const found = model.findTransition(s, sel.transition)
                if (!found || !found.transition.from || !found.transition.to) return false
                found.transition.preset = presetId
                found.transition.dsl = transitionPreset(presetId).dsl
            })
            return
        }
        actions.addTransitionAtPlayhead(presetId)
    },

    applyPostPreset(presetId) {
        store.edit('Set post chain', s => {
            s.post.preset = presetId
            s.post.dsl = postPreset(presetId).dsl
            s.post.enabled = true
        })
        store.selectPost()
    },

    addMarker() {
        let marker
        store.edit('Add marker', s => { marker = edits.addMarker(s, store.playhead) })
        if (marker) store.selectMarker(marker.id)
    },

    setIn() {
        store.edit('Set in point', s => {
            s.inPoint = store.playhead
            if (s.outPoint !== null && s.outPoint <= s.inPoint) s.outPoint = null
        })
    },

    setOut() {
        store.edit('Set out point', s => {
            s.outPoint = store.playhead
            if (s.inPoint !== null && s.inPoint >= s.outPoint) s.inPoint = null
        })
    },

    clearInOut() {
        store.edit('Clear in and out', s => {
            if (s.inPoint === null && s.outPoint === null) return false
            s.inPoint = null
            s.outPoint = null
        })
    },

    addTrack(kind) {
        let track
        store.edit(kind === 'audio' ? 'Add audio track' : 'Add video track', s => { track = edits.addTrack(s, kind) })
        if (track) store.setTargetTrack(track.id)
    },

    async renameTrack(trackId) {
        const track = model.findTrack(store.seq, trackId)
        if (!track) return
        const name = await askText({ title: 'Rename track', label: 'Track name', value: track.name, action: 'Rename' })
        if (!name) return
        store.edit('Rename track', s => {
            const t = model.findTrack(s, trackId)
            if (t) t.name = name
        })
    },

    deleteSelection() {
        const sel = store.selection
        if (sel.transition) {
            store.edit('Remove transition', s => edits.deleteTransition(s, sel.transition))
            store.clearSelection()
            return
        }
        if (sel.marker) {
            store.edit('Delete marker', s => edits.deleteMarker(s, sel.marker))
            store.clearSelection()
            return
        }
        if (sel.clips.size) {
            const ids = [...sel.clips]
            store.edit(ids.length > 1 ? 'Delete clips' : 'Delete clip', s => edits.deleteClips(s, ids))
            store.clearSelection()
        }
    },

    copy() {
        const seq = store.seq
        const ids = [...store.selection.clips]
        if (!ids.length) return false
        const items = ids.map(id => model.findClip(seq, id)).filter(Boolean)
        const origin = Math.min(...items.map(i => i.clip.start))
        clipboard = items.map(i => ({
            clip: structuredClone(i.clip),
            kind: i.kind,
            trackIndex: (i.kind === 'visual' ? seq.tracks : seq.audioTracks).indexOf(i.track),
            at: i.clip.start - origin,
        }))
        actions.status(`Copied ${items.length} clip${items.length > 1 ? 's' : ''}`)
        return true
    },

    paste() {
        if (!clipboard?.length) return
        const t = store.playhead
        const created = []
        store.edit('Paste', s => {
            for (const item of clipboard) {
                const list = item.kind === 'visual' ? s.tracks : s.audioTracks
                const track = list[Math.min(item.trackIndex, list.length - 1)]
                if (!track || track.locked) continue
                const clip = edits.cloneClip(item.clip, { start: t + item.at })
                edits.insertClip(track, clip)
                created.push(clip.id)
            }
            return created.length ? undefined : false
        })
        if (created.length) store.selectClips(created)
    },

    hasClipboard() {
        return !!clipboard?.length
    },

    pasteAt(t) {
        const prev = store.playhead
        store.playheads.set(store.activeSeqId, t)
        actions.paste()
        store.playheads.set(store.activeSeqId, prev)
        store.emit('playhead')
    },

    cutClips() {
        if (actions.copy()) actions.deleteSelection()
    },

    duplicate() {
        if (actions.copy()) {
            const seq = store.seq
            const items = [...store.selection.clips].map(id => model.findClip(seq, id)).filter(Boolean)
            const end = Math.max(...items.map(i => model.clipEnd(i.clip)))
            const prev = store.playhead
            store.playheads.set(store.activeSeqId, end)
            actions.paste()
            store.playheads.set(store.activeSeqId, prev)
        }
    },

    selectAll() {
        const seq = store.seq
        store.selectClips([...seq.tracks, ...seq.audioTracks].flatMap(t => t.clips.map(c => c.id)))
    },

    jumpEdit(dir) {
        const points = edits.editPoints(store.seq)
        const t = store.playhead
        const next = dir > 0 ? points.find(p => p > t + 1e-4) : [...points].reverse().find(p => p < t - 1e-4)
        if (next !== undefined) actions.seek(next)
    },

    focusEditor() {
        document.querySelector('#inspector code-editor')?.focus?.()
    },

    revealClip(id) {
        const found = model.findClip(store.seq, id)
        if (!found) return
        const t = store.playhead
        if (t < found.clip.start || t >= model.clipEnd(found.clip)) actions.seek(found.clip.start + Math.min(found.clip.duration / 2, 1))
        dirty = true
    },

    revealTime(t) {
        const seq = store.seq
        if (Math.abs(store.playhead - t) > 1 / seq.fps) actions.seek(t)
        dirty = true
    },

    setClipDuration(id, duration) {
        const found = model.findClip(store.seq, id)
        if (!found) return
        store.edit('Change duration', s => edits.trimClip(s, id, 'end', found.clip.start + Math.max(1 / s.fps, duration)))
    },

    setNestedSequence(clipId, seqId) {
        if (model.wouldCreateCycle(store.project, store.seq.id, seqId)) {
            actions.status('A sequence cannot contain itself')
            timeline.render()
            return
        }
        store.edit('Change nested sequence', (s, p) => {
            const found = model.findClip(s, clipId)
            if (!found) return false
            found.clip.sequenceId = seqId
            found.clip.name = p.sequences[seqId]?.name || found.clip.name
        })
    },

    addPayloadAtPlayhead(payload) {
        const seq = store.seq
        const kind = payload.kind === 'audio' ? 'audio' : 'video'
        const list = kind === 'audio' ? seq.audioTracks : seq.tracks
        if (!list.length) actions.addTrack(kind === 'audio' ? 'audio' : 'visual')
        const fresh = store.seq
        const lanes = kind === 'audio' ? fresh.audioTracks : fresh.tracks
        const track = lanes.find(t => t.id === store.selection.track) || lanes.find(t => !t.locked) || lanes[0]
        timeline.dropPayload(payload, kind, track.id, store.playhead)
    },

    newSequence() {
        const cur = store.seq
        let seq
        store.edit('New sequence', (s, p) => {
            seq = model.createSequence({
                name: `Sequence ${p.sequenceOrder.length + 1}`,
                width: cur.width, height: cur.height, fps: cur.fps, bpm: cur.bpm,
                duration: barSeconds(cur.bpm, cur.beatsPerBar) * 8, tracks: 2, audioTracks: 0,
            })
            p.sequences[seq.id] = seq
            p.sequenceOrder.push(seq.id)
        })
        if (seq) store.setActiveSequence(seq.id)
    },

    duplicateSequence() {
        const src = store.seq
        let copy
        store.edit('Duplicate sequence', (s, p) => {
            copy = structuredClone(src)
            copy.id = model.uid('seq')
            copy.name = `${src.name} copy`
            const ids = new Map()
            for (const t of [...copy.tracks, ...copy.audioTracks]) {
                t.id = model.uid(t.id.split('_')[0])
                for (const c of t.clips) {
                    const nid = model.uid(c.id.split('_')[0])
                    ids.set(c.id, nid)
                    c.id = nid
                }
            }
            for (const t of copy.tracks) {
                for (const tr of t.transitions) {
                    tr.id = model.uid('trn')
                    if (tr.from) tr.from = ids.get(tr.from)
                    if (tr.to) tr.to = ids.get(tr.to)
                }
            }
            for (const m of copy.markers) m.id = model.uid('mrk')
            p.sequences[copy.id] = copy
            p.sequenceOrder.push(copy.id)
        })
        if (copy) store.setActiveSequence(copy.id)
    },

    async deleteSequence() {
        const seq = store.seq
        const project = store.project
        if (seq.id === project.mainSequenceId) {
            actions.status('The main sequence cannot be deleted')
            return
        }
        const ok = await askConfirm({ title: `Delete ${seq.name}?`, message: 'Clips that nest this sequence are removed too. You can undo this.', action: 'Delete', danger: true })
        if (!ok) return
        const id = seq.id
        store.setActiveSequence(project.mainSequenceId)
        store.edit('Delete sequence', (s, p) => {
            delete p.sequences[id]
            p.sequenceOrder = p.sequenceOrder.filter(x => x !== id)
            for (const other of Object.values(p.sequences)) {
                const nested = other.tracks.flatMap(t => t.clips.filter(c => c.type === 'sequence' && c.sequenceId === id).map(c => c.id))
                if (nested.length) edits.deleteClips(other, nested)
            }
        })
    },

    importAudio() {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = 'audio/*'
        input.multiple = true
        input.addEventListener('change', () => actions.handleFiles([...input.files]))
        input.click()
    },

    async handleFiles(files) {
        for (const file of files) {
            if (file.name.endsWith(`.${PROJECT_EXTENSION}`) || file.type === 'application/zip') {
                await actions.openProjectFromFile(file)
                continue
            }
            if (!file.type.startsWith('audio/') && !/\.(wav|mp3|m4a|aac|ogg|oga|flac|opus|webm)$/i.test(file.name)) {
                actions.status(`${file.name} is not an audio file`)
                continue
            }
            try {
                actions.status(`Importing ${file.name}`)
                const media = await importAudioFile(file)
                const seq = store.seq
                const firstAudio = !seq.audioTracks.some(t => t.clips.length)
                let extended = false
                store.edit('Import audio', (s, p) => {
                    p.media[media.id] = media
                    let track = s.audioTracks.find(t => t.id === store.selection.track) || s.audioTracks.find(t => !t.clips.length)
                    if (!track) track = edits.addTrack(s, 'audio')
                    // A song longer than the sequence extends the sequence to fit it.
                    const end = store.playhead + media.duration
                    if (end > s.duration) {
                        s.duration = Math.ceil(end * s.fps) / s.fps
                        extended = true
                    }
                    edits.insertClip(track, model.createAudioClip({
                        mediaId: media.id, name: media.name, start: store.playhead,
                        duration: Math.min(media.duration, Math.max(1 / seq.fps, s.duration - store.playhead)),
                    }))
                })
                actions.status(extended ? `${media.name} is on the timeline; the sequence now runs to its end` : `${media.name} is on the timeline`)
                // The first song in a sequence sets its tempo and beat grid (one undo puts them back).
                if (firstAudio) await actions.detectTempo()
            } catch (err) {
                console.error(err)
                actions.status(`Could not import ${file.name}: ${err?.message || 'unsupported audio'}`)
            }
        }
    },

    async openProject(project) {
        actions.pause()
        await store.saveNow()
        store.openProject(project)
        await store.saveNow()
        await prepareAudio()
        dirty = true
    },

    async newProject() {
        await actions.openProject(model.createProject({ name: 'Untitled project' }))
    },

    async openDemo() {
        await actions.openProject(createDemoProject())
    },

    async openProjectFromFile(file) {
        try {
            const project = await projectFromFile(file)
            await actions.openProject(project)
            actions.status(`Opened ${project.name}`)
        } catch (err) {
            actions.status(err?.message || 'Could not open the project')
        }
    },

    openProjectFile() {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = `.${PROJECT_EXTENSION},application/zip`
        input.addEventListener('change', () => input.files[0] && actions.openProjectFromFile(input.files[0]))
        input.click()
    },

    async saveProjectFile() {
        await store.saveNow()
        const file = await projectToFile(store.project)
        const url = URL.createObjectURL(file)
        const a = document.createElement('a')
        a.href = url
        a.download = file.name
        document.body.append(a)
        a.click()
        a.remove()
        setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },

    async openRecent() {
        const projects = await listProjects()
        showRecent(projects)
    },

    async renameProject(name) {
        store.edit('Rename project', (s, p) => { p.name = name })
    },

    exportVideo() {
        exportDialog.open()
    },

    toggleFullscreen() {
        const stage = document.querySelector('.tl-stage')
        if (document.fullscreenElement) document.exitFullscreen()
        else stage.requestFullscreen?.()
    },

    setPreviewScale(scale) {
        store.setView({ previewScale: scale })
        resizePreview()
    },
}

// --- views -------------------------------------------------------------------

const timeline = new TimelineView(document.getElementById('timeline'), { store, thumbs, pool, actions, audio })
const monitor = new MonitorView(document.getElementById('monitor'), {
    store,
    onScale: scale => actions.setPreviewScale(scale),
    onFullscreen: () => actions.toggleFullscreen(),
})
new InspectorView(document.getElementById('inspector'), { store, pool, actions })
new LibraryView(document.getElementById('library'), { store, thumbs, actions })
const exportDialog = new ExportDialog({ store, renderer, pool, audio, actions })

const about = new AboutDialog({
    name: 'Timeline',
    tagline: 'Cut Noisemaker programs to music',
})
about.setNoisemakerFromUrl?.('https://shaders.noisedeck.app/1/deployment-meta.json')
fetch('deployment-meta.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : null).then(meta => {
    if (meta?.git_hash) about.setBuild?.({ hash: meta.git_hash, deployed: meta.date })
}).catch(() => {})

function showRecent(projects) {
    const dialog = document.createElement('dialog')
    dialog.className = 'hf-dialog tl-dialog'
    const title = document.createElement('h2')
    title.className = 'hf-dialog-title'
    title.textContent = 'Open a project'
    const body = document.createElement('div')
    body.className = 'hf-dialog-body'
    const rows = document.createElement('div')
    rows.className = 'tl-rows'
    for (const p of projects) {
        const row = document.createElement('button')
        row.type = 'button'
        row.className = 'tl-row'
        if (p.id === store.project.id) row.setAttribute('aria-current', 'true')
        const main = document.createElement('span')
        main.className = 'tl-row-main'
        const t = document.createElement('span')
        t.className = 'tl-row-title'
        t.textContent = p.name
        const sub = document.createElement('span')
        sub.className = 'tl-row-sub'
        sub.textContent = `Edited ${new Date(p.updatedAt).toLocaleString()}`
        main.append(t, sub)
        row.append(main)
        row.addEventListener('click', async () => {
            close()
            const project = await loadProject(p.id)
            if (project) await actions.openProject(project)
        })
        rows.append(row)
    }
    body.append(rows)
    const footer = document.createElement('div')
    footer.className = 'tl-dialog-actions'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'tl-button'
    cancel.textContent = 'Cancel'
    footer.append(cancel)
    dialog.append(title, body, footer)
    document.body.append(dialog)
    const close = () => {
        dialog.close()
        dialog.remove()
    }
    cancel.addEventListener('click', close)
    dialog.addEventListener('close', () => dialog.remove())
    dialog.showModal()
}

// --- menu bar ------------------------------------------------------------------

const mod = formatShortcut ? (k => formatShortcut(`Mod+${k}`)) : (k => `Cmd ${k}`)
const menu = document.getElementById('menu')
const LOGO = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="currentColor"><rect x="2" y="5" width="9" height="4" rx="1"/><rect x="8" y="10.5" width="14" height="4" rx="1"/><rect x="4" y="16" width="11" height="4" rx="1"/><rect x="13" y="2" width="1.6" height="20" rx="0.8"/></svg>'

menu.config = {
    ariaLabel: 'Timeline menu',
    regions: {
        left: [
            { type: 'custom', id: 'tl-wordmark' },
            {
                type: 'menu', id: 'fileMenu', trigger: { label: 'file' },
                items: [
                    { id: 'newProject', label: 'New project', onSelect: () => actions.newProject() },
                    { id: 'openRecent', label: 'Open project', onSelect: () => actions.openRecent() },
                    { id: 'openDemo', label: 'Open the demo', onSelect: () => actions.openDemo() },
                    { type: 'separator' },
                    { id: 'openFile', label: 'Open project file', onSelect: () => actions.openProjectFile() },
                    { id: 'saveFile', label: 'Save project file', shortcut: mod('S'), onSelect: () => actions.saveProjectFile() },
                    { type: 'separator' },
                    { id: 'importAudio', label: 'Import audio', onSelect: () => actions.importAudio() },
                    { id: 'exportVideo', label: 'Export video', shortcut: mod('E'), onSelect: () => actions.exportVideo() },
                ],
            },
            {
                type: 'menu', id: 'editMenu', trigger: { label: 'edit' },
                items: [
                    { id: 'undo', label: 'Undo', shortcut: mod('Z'), disabled: () => !store.history.canUndo, onSelect: () => store.undo() },
                    { id: 'redo', label: 'Redo', shortcut: mod('Shift+Z'), disabled: () => !store.history.canRedo, onSelect: () => store.redo() },
                    { type: 'separator' },
                    { id: 'copy', label: 'Copy', shortcut: mod('C'), onSelect: () => actions.copy() },
                    { id: 'paste', label: 'Paste at playhead', shortcut: mod('V'), onSelect: () => actions.paste() },
                    { id: 'duplicate', label: 'Duplicate', shortcut: mod('Shift+D'), onSelect: () => actions.duplicate() },
                    { id: 'delete', label: 'Delete', shortcut: 'Del', onSelect: () => actions.deleteSelection() },
                    { id: 'selectAll', label: 'Select all clips', shortcut: mod('A'), onSelect: () => actions.selectAll() },
                    { type: 'separator' },
                    { id: 'cut', label: 'Cut at playhead', shortcut: mod('K'), onSelect: () => actions.cutAtPlayhead() },
                    { id: 'transition', label: 'Add transition', shortcut: mod('D'), onSelect: () => actions.addTransitionAtPlayhead() },
                    { id: 'marker', label: 'Add marker', shortcut: 'M', onSelect: () => actions.addMarker() },
                ],
            },
            {
                type: 'menu', id: 'sequenceMenu', trigger: { label: 'sequence' },
                items: [
                    { id: 'newSeq', label: 'New sequence', onSelect: () => actions.newSequence() },
                    { id: 'dupSeq', label: 'Duplicate sequence', onSelect: () => actions.duplicateSequence() },
                    { id: 'delSeq', label: 'Delete sequence', disabled: () => store.seq?.id === store.project?.mainSequenceId, onSelect: () => actions.deleteSequence() },
                    { type: 'separator' },
                    { id: 'addV', label: 'Add video track', onSelect: () => actions.addTrack('visual') },
                    { id: 'addA', label: 'Add audio track', onSelect: () => actions.addTrack('audio') },
                    { type: 'separator' },
                    { id: 'setIn', label: 'Set in point', shortcut: 'I', onSelect: () => actions.setIn() },
                    { id: 'setOut', label: 'Set out point', shortcut: 'O', onSelect: () => actions.setOut() },
                    { id: 'clearIO', label: 'Clear in and out', onSelect: () => actions.clearInOut() },
                    { id: 'loop', label: 'Loop in and out', checked: () => store.loopPlayback, onSelect: () => actions.toggleLoop() },
                ],
            },
            {
                type: 'menu', id: 'viewMenu', trigger: { label: 'view' },
                items: [
                    { id: 'snap', label: 'Snapping', shortcut: 'S', checked: () => store.view.snapping, onSelect: () => store.setView({ snapping: !store.view.snapping }) },
                    { id: 'grid', label: 'Beat grid', shortcut: 'G', checked: () => store.view.beatGrid, onSelect: () => store.setView({ beatGrid: !store.view.beatGrid }) },
                    { type: 'separator' },
                    { id: 'zoomIn', label: 'Zoom in', shortcut: '=', onSelect: () => timeline.zoomBy(1.5) },
                    { id: 'zoomOut', label: 'Zoom out', shortcut: '-', onSelect: () => timeline.zoomBy(1 / 1.5) },
                    { id: 'zoomFit', label: 'Fit sequence', shortcut: '\\', onSelect: () => timeline.zoomToFit() },
                    { type: 'separator' },
                    { id: 'full', label: 'Full screen monitor', shortcut: 'F', onSelect: () => actions.toggleFullscreen() },
                ],
            },
            {
                type: 'menu', id: 'helpMenu', trigger: { label: 'help' },
                items: [
                    { id: 'about', label: 'About Timeline', onSelect: () => about.show() },
                ],
            },
        ],
        center: [{ type: 'custom', id: 'tl-project' }],
        right: [
            { type: 'button', id: 'undoBtn', icon: 'undo', tooltip: 'Undo', ariaLabel: 'Undo', disabled: () => !store.history.canUndo, onSelect: () => store.undo() },
            { type: 'button', id: 'redoBtn', icon: 'redo', tooltip: 'Redo', ariaLabel: 'Redo', disabled: () => !store.history.canRedo, onSelect: () => store.redo() },
            { type: 'custom', id: 'tl-export' },
        ],
    },
}

const wordmark = document.getElementById('tl-wordmark')
if (wordmark) {
    wordmark.className += ' tl-wordmark'
    wordmark.innerHTML = `${LOGO}<span>TIMELINE</span>`
}
const projectSlot = document.getElementById('tl-project')
const projectInput = document.createElement('input')
projectInput.type = 'text'
projectInput.setAttribute('aria-label', 'Project name')
projectInput.spellcheck = false
projectInput.addEventListener('change', () => {
    const name = projectInput.value.trim()
    if (name) actions.renameProject(name)
    else projectInput.value = store.project.name
})
projectInput.addEventListener('keydown', e => { if (e.key === 'Enter') projectInput.blur() })
const saveState = document.createElement('span')
saveState.className = 'tl-save-state'
if (projectSlot) {
    projectSlot.className += ' tl-project-name'
    projectSlot.append(projectInput, saveState)
}
const exportSlot = document.getElementById('tl-export')
if (exportSlot) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'tl-export-btn'
    btn.innerHTML = '<span class="hf-icon" aria-hidden="true">movie</span><span>Export</span>'
    btn.addEventListener('click', () => actions.exportVideo())
    exportSlot.append(btn)
}

function refreshChrome() {
    if (document.activeElement !== projectInput) projectInput.value = store.project?.name || ''
    const states = { saved: 'Saved', pending: 'Saving', error: 'Not saved' }
    saveState.textContent = states[store.saveState] || ''
    saveState.dataset.state = store.saveState
    menu.refresh?.()
}
store.on('project', refreshChrome)
store.on('status', refreshChrome)
store.on('transport', () => menu.refresh?.())

// --- layout: timeline splitter ---------------------------------------------------

const app = document.getElementById('app')
const splitter = document.getElementById('splitter')
const prefs = readPrefs()
if (prefs.timelineHeight) app.style.setProperty('--tl-timeline-h', `${prefs.timelineHeight}px`)
splitter.addEventListener('pointerdown', e => {
    e.preventDefault()
    const move = ev => {
        const h = clamp(window.innerHeight - ev.clientY - 3, 160, window.innerHeight - 220)
        app.style.setProperty('--tl-timeline-h', `${h}px`)
    }
    const up = ev => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        writePrefs({ timelineHeight: clamp(window.innerHeight - ev.clientY - 3, 160, window.innerHeight - 220) })
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
})
splitter.addEventListener('keydown', e => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return
    e.preventDefault()
    const cur = document.getElementById('timeline').getBoundingClientRect().height
    const h = clamp(cur + (e.key === 'ArrowUp' ? 24 : -24), 160, window.innerHeight - 220)
    app.style.setProperty('--tl-timeline-h', `${h}px`)
    writePrefs({ timelineHeight: h })
})

// --- files dropped on the window -----------------------------------------------

const dropzone = document.createElement('div')
dropzone.className = 'tl-dropzone'
dropzone.hidden = true
dropzone.textContent = 'Drop audio or a project file'
document.body.append(dropzone)
let dragDepth = 0
window.addEventListener('dragenter', e => {
    if (!e.dataTransfer?.types.includes('Files')) return
    dragDepth++
    dropzone.hidden = false
})
window.addEventListener('dragleave', e => {
    if (!e.dataTransfer?.types.includes('Files')) return
    dragDepth = Math.max(0, dragDepth - 1)
    if (!dragDepth) dropzone.hidden = true
})
window.addEventListener('dragover', e => {
    if (e.dataTransfer?.types.includes('Files')) e.preventDefault()
})
window.addEventListener('drop', e => {
    if (!e.dataTransfer?.files?.length) return
    e.preventDefault()
    dragDepth = 0
    dropzone.hidden = true
    actions.handleFiles([...e.dataTransfer.files])
})

// --- keyboard ----------------------------------------------------------------------

function isTyping(target) {
    if (!target) return false
    const tag = target.tagName
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable || !!target.closest?.('code-editor')
}

window.addEventListener('keydown', e => {
    if (e.defaultPrevented || isTyping(e.target)) return
    if (document.querySelector('dialog[open]')) return
    const modKey = e.metaKey || e.ctrlKey
    const key = e.key
    const handled = () => e.preventDefault()
    if (modKey) {
        const k = key.toLowerCase()
        if (k === 'z' && e.shiftKey) { handled(); store.redo(); return }
        if (k === 'z') { handled(); store.undo(); return }
        if (k === 'y') { handled(); store.redo(); return }
        if (k === 'k') { handled(); actions.cutAtPlayhead(); return }
        if (k === 'd' && e.shiftKey) { handled(); actions.duplicate(); return }
        if (k === 'd') { handled(); actions.addTransitionAtPlayhead(); return }
        if (k === 'c') { if (actions.copy()) handled(); return }
        if (k === 'x') { handled(); actions.cutClips(); return }
        if (k === 'v') { handled(); actions.paste(); return }
        if (k === 'a') { handled(); actions.selectAll(); return }
        if (k === 'e') { handled(); actions.exportVideo(); return }
        if (k === 's') { handled(); actions.saveProjectFile(); return }
        return
    }
    if (e.altKey && e.code === 'KeyX') { handled(); actions.clearInOut(); return }
    if (e.altKey) return
    switch (key) {
        case ' ': handled(); actions.togglePlay(); return
        case 'k': case 'K': handled(); actions.pause(); return
        case 'l': case 'L': handled(); if (!store.playing) actions.play(); return
        case 'j': case 'J': handled(); actions.seek(store.playhead - barSeconds(store.seq.bpm, store.seq.beatsPerBar)); return
        case 'ArrowLeft': handled(); if (e.shiftKey) actions.stepBeats(-1); else actions.step(-1); return
        case 'ArrowRight': handled(); if (e.shiftKey) actions.stepBeats(1); else actions.step(1); return
        case 'ArrowUp': handled(); actions.jumpEdit(-1); return
        case 'ArrowDown': handled(); actions.jumpEdit(1); return
        case 'Home': handled(); actions.seek(0); return
        case 'End': handled(); actions.seek(store.seq.duration); return
        case 'i': case 'I': handled(); actions.setIn(); return
        case 'o': case 'O': handled(); actions.setOut(); return
        case 'm': case 'M': handled(); actions.addMarker(); return
        case 'Delete': case 'Backspace': handled(); actions.deleteSelection(); return
        case '=': case '+': handled(); timeline.zoomBy(1.5); return
        case '-': case '_': handled(); timeline.zoomBy(1 / 1.5); return
        case '\\': handled(); timeline.zoomToFit(); return
        case 's': case 'S': handled(); store.setView({ snapping: !store.view.snapping }); return
        case 'g': case 'G': handled(); store.setView({ beatGrid: !store.view.beatGrid }); return
        case 'f': case 'F': handled(); actions.toggleFullscreen(); return
        case 'Escape':
            if (!hasOpenEscapeables?.()) { handled(); store.clearSelection() }
            return
    }
})

// Unlock audio on the first gesture so playback can start at once.
const unlock = () => audio.unlock()
window.addEventListener('pointerdown', unlock, { once: true, capture: true })
window.addEventListener('keydown', unlock, { once: true, capture: true })

// --- rendering ----------------------------------------------------------------------

function previewSize(seq) {
    const scale = store.view.previewScale || 0.5
    return { width: Math.max(2, Math.round(seq.width * scale / 2) * 2), height: Math.max(2, Math.round(seq.height * scale / 2) * 2) }
}

function resizePreview() {
    const seq = store.seq
    if (!seq) return
    const { width, height } = previewSize(seq)
    if (pool.width !== width || pool.height !== height) pool.resizeAll(width, height)
    dirty = true
}

/**
 * Load and decode the sequence's audio, then mix it. `onProgress` receives
 * { fraction, received, total, files, mixing } while it works.
 */
async function prepareAudio({ onProgress } = {}) {
    const seq = store.seq
    if (!seq) return
    const project = store.project
    const ids = [...new Set(seq.audioTracks.flatMap(t => t.clips.map(c => c.mediaId)))].filter(id => project.media[id])
    const parts = new Map(ids.map(id => [id, { fraction: 0, received: 0, total: 0 }]))
    const report = extra => {
        let fraction = 0
        let received = 0
        let total = 0
        for (const part of parts.values()) {
            fraction += part.fraction / Math.max(1, parts.size)
            received += part.received || 0
            total += part.total || 0
        }
        onProgress?.({ fraction: 0.95 * (ids.length ? fraction : 1), received, total, files: ids.length, ...extra })
    }
    report()
    // Decode media first so waveforms can draw while the mix renders.
    const failed = []
    await Promise.all(ids.map(id => getAudioBuffer(project.media[id], {
        onProgress: p => {
            Object.assign(parts.get(id), p)
            report()
        },
    }).catch(err => {
        failed.push(err)
        return null
    })))
    if (failed.length) actions.status(failed[0]?.message || 'Some audio could not be loaded')
    timeline.render()
    report({ mixing: true })
    await audio.mix(project, seq)
    onProgress?.({ fraction: 1, received: 0, total: 0, files: ids.length, done: true })
    dirty = true
}

let audioTimer = 0
store.on('project', ({ reason } = {}) => {
    resizePreview()
    dirty = true
    if (store.seq?.id !== lastSeqId) {
        lastSeqId = store.seq?.id
        lastFrame = -1
    }
    clearTimeout(audioTimer)
    audioTimer = setTimeout(async () => {
        const before = audio.currentMix(store.seq?.id)
        await prepareAudio()
        // Restart playback only when the edit changed what is heard.
        if (store.playing && audio.currentMix(store.seq?.id) !== before) audio.play(store.seq, store.playhead)
    }, reason === 'open' || reason === 'sequence' ? 0 : 250)
})
store.on('playhead', () => { dirty = true })
pool.compiledListeners.add(() => { dirty = true })
audio.onMixChanged = () => { dirty = true }

let lastPrefetch = 0
function frame(now) {
    requestAnimationFrame(frame)
    const seq = store.seq
    // An export owns the renderers until it finishes.
    if (!seq || renderer.exporting) return
    if (store.playing) {
        let t = audio.time()
        const range = store.loopPlayback ? model.workRange(seq) : { start: 0, end: seq.duration }
        if (t >= range.end) {
            if (store.loopPlayback) {
                store.setPlayhead(range.start)
                audio.play(seq, range.start)
                t = range.start
            } else {
                actions.pause()
                store.setPlayhead(range.end)
                t = range.end
            }
        } else {
            store.setPlayhead(t)
        }
    }
    const f = Math.min(frameAt(store.playhead, seq.fps), Math.max(0, Math.round(seq.duration * seq.fps) - 1))
    if (f !== lastFrame || dirty) {
        const seek = !store.playing || f !== lastFrame + 1
        dirty = false
        const result = renderer.renderFrame(seq, f / seq.fps, { seek })
        monitor.draw(result.canvas)
        lastFrame = f
        monitor.setCompiling(result.missing > 0)
    }
    monitor.updateMeters(audio.state)
    if (now - lastPrefetch > 300) {
        lastPrefetch = now
        renderer.prefetch(seq, store.playhead, store.playhead + 4)
    }
}

// --- boot ------------------------------------------------------------------------------

initEscapeHandler()
boot.start('project')
let project = null
try {
    const last = prefs.lastProjectId ? await loadProject(prefs.lastProjectId) : null
    // An earlier demo stays saved under Open project; the current demo opens instead.
    project = last && !usesEarlierDemo(last) ? last : null
} catch (err) {
    console.warn('[timeline] could not read saved projects', err)
}
let firstVisit = false
if (!project) {
    project = createDemoProject()
    firstVisit = true
    try { await saveProject(project) } catch { /* storage unavailable; the project still works */ }
}
store.openProject(project)
boot.done('project', project.name)
if (firstVisit) {
    // Open the demo on its drop rather than on the fade from black.
    const drop = store.seq.markers.find(m => m.name === 'Drop')
    if (drop) store.setPlayhead(drop.time + 1)
}
resizePreview()
timeline.zoomToFit()
refreshChrome()
// The soundtrack and the programs at the playhead load at the same time.
boot.start('audio')
boot.start('programs')
let audioBytes = 0
const audioReady = prepareAudio({
    onProgress: ({ fraction, received, total, files, mixing, done }) => {
        if (total) audioBytes = total
        if (done) return boot.done('audio', !files ? 'none' : audioBytes ? formatBytes(audioBytes) : `${files} ${files === 1 ? 'file' : 'files'}`)
        const detail = !files ? '' : mixing ? 'mixing' : total && received < total ? `${formatBytes(received)} of ${formatBytes(total)}` : 'decoding'
        boot.progress('audio', fraction, detail)
    },
})
const PROGRAMS_WAIT_MS = 30000
const programsReady = Promise.race([
    renderer.prepareFrame(store.seq, store.playhead, (done, total) => {
        boot.progress('programs', total ? done / total : 1, `${done} of ${total}`)
    }).then(({ total }) => boot.done('programs', `${total} compiled`)),
    // Never hold the editor back on a slow compile; the monitor shows what is still compiling.
    new Promise(resolve => setTimeout(resolve, PROGRAMS_WAIT_MS)).then(() => boot.done('programs', 'still compiling')),
])
await Promise.all([audioReady, programsReady])
initializeTooltips?.()
app.dataset.state = 'ready'
boot.finish()
requestAnimationFrame(frame)

// Automation surface for the end-to-end suite and for scripting from the console.
window.__timeline = {
    ready: true,
    store,
    actions,
    audio,
    pool,
    renderer,
    thumbs,
    model,
    edits,
    exportSequence: (settings) => exportSequence({
        seq: store.seq, project: store.project, renderer, pool, audio, settings,
    }),
}
window.dispatchEvent(new CustomEvent('timeline:ready'))
