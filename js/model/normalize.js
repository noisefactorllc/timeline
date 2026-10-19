/**
 * Projects written by hand or by an agent: fill in what a project.json
 * leaves out, and report what cannot work, so a short file opens.
 *
 * Ids are optional. A track, clip, transition or marker without one gets an
 * id from its place (`main/V1/2`), so the same file always opens with the
 * same ids. Give a clip an id when a transition names it.
 *
 * Problems come back as { level, where, message }. An `error` is something
 * that cannot play as written (it is dropped or stays silent); a `warning`
 * plays but is probably not what was meant.
 */

import { SCHEMA_VERSION, BLEND_MODES, DEFAULT_POST_DSL, DEFAULT_PROGRAM_DSL, nestedSequenceIds } from './project.js'
import { POST_PRESETS } from '../data/presets.js'

export const AUDIO_TYPES = {
    wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg',
    oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', webm: 'audio/webm',
}

const isNumber = v => typeof v === 'number' && Number.isFinite(v)
const isObject = v => !!v && typeof v === 'object' && !Array.isArray(v)

/** A media path inside the project folder: relative, with no `..` and no drive or scheme. */
export function safeMediaPath(path) {
    if (typeof path !== 'string') return null
    const clean = path.replace(/\\/g, '/').replace(/^\.\//, '')
    if (!clean || clean.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(clean)) return null
    const parts = clean.split('/')
    if (parts.some(p => p === '..' || p === '')) return null
    return clean
}

function extensionOf(path) {
    return (path.match(/\.([^./]+)$/)?.[1] || '').toLowerCase()
}

export function normalizeProject(raw, { name: fallbackName = 'Untitled project' } = {}) {
    if (!isObject(raw)) throw new Error('project.json must hold a JSON object')
    const schema = raw.schema ?? SCHEMA_VERSION
    if (schema !== SCHEMA_VERSION) throw new Error(`project.json uses schema ${schema}; this version of Timeline opens schema ${SCHEMA_VERSION}`)
    if (!isObject(raw.sequences) || !Object.keys(raw.sequences).length) throw new Error('project.json needs at least one sequence under "sequences"')

    const problems = []
    const report = (level, where, message) => problems.push({ level, where, message })
    const now = Date.now()

    const media = {}
    for (const [id, m] of Object.entries(isObject(raw.media) ? raw.media : {})) {
        if (!isObject(m)) {
            report('error', `media "${id}"`, 'must be an object with a path')
            continue
        }
        const record = { ...m, id }
        if (m.path !== undefined) {
            const path = safeMediaPath(m.path)
            if (!path) report('error', `media "${id}"`, `path "${m.path}" must be relative to the project folder, without ".."`)
            record.path = path
        } else if (!m.url) {
            report('error', `media "${id}"`, 'needs a "path" to a file in the project folder')
        }
        const source = record.path || m.url || ''
        const ext = extensionOf(source)
        record.kind = m.kind || 'audio'
        if (record.kind !== 'audio') report('error', `media "${id}"`, `kind "${record.kind}" is not supported yet; Timeline plays audio files`)
        else if (source && !AUDIO_TYPES[ext] && !m.type) report('warning', `media "${id}"`, `"${source}" does not look like an audio file`)
        record.type = m.type || AUDIO_TYPES[ext] || 'audio/*'
        record.name = m.name || source.split('/').pop()?.replace(/\.[^.]+$/, '') || id
        media[id] = record
    }

    const sequences = {}
    for (const [seqId, s] of Object.entries(raw.sequences)) {
        if (!isObject(s)) {
            report('error', `sequence "${seqId}"`, 'must be an object')
            continue
        }
        sequences[seqId] = normalizeSequence(seqId, s, media, report)
    }
    if (!Object.keys(sequences).length) throw new Error('project.json has no usable sequence')

    let mainSequenceId = raw.mainSequenceId
    if (!sequences[mainSequenceId]) {
        if (mainSequenceId !== undefined) report('error', 'project', `mainSequenceId "${mainSequenceId}" names no sequence; opening "${Object.keys(sequences)[0]}"`)
        mainSequenceId = Object.keys(sequences)[0]
    }
    const order = (Array.isArray(raw.sequenceOrder) ? raw.sequenceOrder : []).filter(id => sequences[id])
    for (const id of Object.keys(sequences)) if (!order.includes(id)) order.push(id)

    const project = {
        ...raw,
        schema: SCHEMA_VERSION,
        id: typeof raw.id === 'string' && raw.id ? raw.id : 'prj_folder',
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name : fallbackName,
        createdAt: isNumber(raw.createdAt) ? raw.createdAt : now,
        updatedAt: isNumber(raw.updatedAt) ? raw.updatedAt : now,
        media,
        sequences,
        sequenceOrder: order,
        mainSequenceId,
    }

    // Nested sequences: each must exist and must not contain its parent.
    for (const seq of Object.values(sequences)) {
        for (const track of seq.tracks) {
            track.clips = track.clips.filter(clip => {
                if (clip.type !== 'sequence') return true
                const where = `${seq.name} › ${track.name} › "${clip.name}"`
                if (!sequences[clip.sequenceId]) {
                    report('error', where, `sequenceId "${clip.sequenceId}" names no sequence; the clip was left out`)
                    return false
                }
                if (clip.sequenceId === seq.id || nestedSequenceIds(project, clip.sequenceId).has(seq.id)) {
                    report('error', where, `nesting "${clip.sequenceId}" here would contain itself; the clip was left out`)
                    return false
                }
                return true
            })
        }
    }
    for (const seq of Object.values(sequences)) checkTransitions(seq, report)
    return { project, problems }
}

function normalizeSequence(seqId, s, media, report) {
    const name = typeof s.name === 'string' && s.name ? s.name : seqId
    const seq = {
        ...s,
        id: seqId,
        name,
        width: positiveInt(s.width, 1920),
        height: positiveInt(s.height, 1080),
        fps: positiveInt(s.fps, 30),
        duration: isNumber(s.duration) && s.duration > 0 ? s.duration : 60,
        bpm: isNumber(s.bpm) && s.bpm > 0 ? s.bpm : 120,
        beatsPerBar: positiveInt(s.beatsPerBar, 4),
        gridOffset: isNumber(s.gridOffset) ? s.gridOffset : 0,
        inPoint: isNumber(s.inPoint) ? s.inPoint : null,
        outPoint: isNumber(s.outPoint) ? s.outPoint : null,
        audioSensitivity: isNumber(s.audioSensitivity) ? s.audioSensitivity : 1,
        markers: [],
        post: normalizePost(s.post, name, report),
    }
    if (!isNumber(s.duration)) report('warning', name, 'has no duration; it runs 60 seconds')

    const rawTracks = Array.isArray(s.tracks) ? s.tracks : [{}, {}, {}]
    seq.tracks = rawTracks.map((t, i) => {
        const track = isObject(t) ? t : {}
        const trackName = typeof track.name === 'string' && track.name ? track.name : `V${i + 1}`
        const id = track.id || `${seqId}/${trackName}`
        const clips = (Array.isArray(track.clips) ? track.clips : []).map((c, j) => normalizeVisualClip(c, `${id}/${j + 1}`, `${name} › ${trackName}`, report)).filter(Boolean)
        return {
            ...track,
            id,
            name: trackName,
            hidden: !!track.hidden,
            locked: !!track.locked,
            clips: clips.sort((a, b) => a.start - b.start),
            transitions: (Array.isArray(track.transitions) ? track.transitions : []).map((x, j) => ({
                duration: 1,
                preset: 'dissolve',
                dsl: '',
                ...(isObject(x) ? x : {}),
                id: x?.id || `${id}/transition-${j + 1}`,
                from: x?.from ?? null,
                to: x?.to ?? null,
            })),
        }
    })

    const rawAudio = Array.isArray(s.audioTracks) ? s.audioTracks : [{}, {}]
    seq.audioTracks = rawAudio.map((t, i) => {
        const track = isObject(t) ? t : {}
        const trackName = typeof track.name === 'string' && track.name ? track.name : `A${i + 1}`
        const id = track.id || `${seqId}/${trackName}`
        const where = `${name} › ${trackName}`
        const clips = (Array.isArray(track.clips) ? track.clips : []).map((c, j) => {
            if (!isObject(c)) return null
            const clipWhere = `${where} › "${c.name || c.mediaId || `clip ${j + 1}`}"`
            const m = media[c.mediaId]
            if (!m) report('error', clipWhere, `mediaId "${c.mediaId}" names nothing under "media"; the clip is silent`)
            const start = isNumber(c.start) && c.start >= 0 ? c.start : 0
            const fallback = isNumber(m?.duration) ? m.duration - (c.offset || 0) : seq.duration - start
            return {
                ...c,
                id: c.id || `${id}/${j + 1}`,
                mediaId: c.mediaId,
                name: c.name || m?.name || 'Audio',
                start,
                duration: isNumber(c.duration) && c.duration > 0 ? c.duration : Math.max(1 / seq.fps, fallback),
                offset: isNumber(c.offset) && c.offset >= 0 ? c.offset : 0,
                gain: isNumber(c.gain) && c.gain >= 0 ? c.gain : 1,
                fadeIn: isNumber(c.fadeIn) && c.fadeIn >= 0 ? c.fadeIn : 0,
                fadeOut: isNumber(c.fadeOut) && c.fadeOut >= 0 ? c.fadeOut : 0,
            }
        }).filter(Boolean)
        return {
            ...track,
            id,
            name: trackName,
            muted: !!track.muted,
            solo: !!track.solo,
            gain: isNumber(track.gain) && track.gain >= 0 ? track.gain : 1,
            clips: clips.sort((a, b) => a.start - b.start),
        }
    })

    seq.markers = (Array.isArray(s.markers) ? s.markers : []).filter(m => isObject(m) && isNumber(m.time)).map((m, i) => ({
        ...m, id: m.id || `${seqId}/marker-${i + 1}`, name: m.name || `Marker ${i + 1}`,
    }))

    for (const track of [...seq.tracks, ...seq.audioTracks]) checkPlacement(seq, track, report)
    return seq
}

/** The post chain: its own program, or a named preset's when it gives none. */
function normalizePost(raw, seqName, report) {
    const post = isObject(raw) ? raw : {}
    const preset = post.preset === undefined ? null : POST_PRESETS.find(p => p.id === post.preset)
    if (post.preset !== undefined && !preset) {
        report('warning', `${seqName} › post chain`, `preset "${post.preset}" is not one of ${POST_PRESETS.map(p => p.id).join(', ')}`)
    }
    const dsl = typeof post.dsl === 'string' && post.dsl.trim() ? post.dsl : preset?.dsl || DEFAULT_POST_DSL
    return {
        ...post,
        enabled: post.enabled !== false,
        preset: post.preset ?? 'cinema',
        dsl,
        loop: isNumber(post.loop) && post.loop > 0 ? post.loop : 8,
    }
}

function normalizeVisualClip(c, defaultId, where, report) {
    if (!isObject(c)) return null
    const type = c.type || (c.sequenceId ? 'sequence' : 'program')
    const label = `${where} › "${c.name || defaultId}"`
    if (type !== 'program' && type !== 'sequence') {
        report('error', label, `type "${type}" is not a clip type Timeline knows; the clip was left out`)
        return null
    }
    if (!isNumber(c.start) || c.start < 0) report('error', label, 'needs a "start" in seconds, 0 or more; it starts at 0')
    if (!isNumber(c.duration) || c.duration <= 0) report('error', label, 'needs a "duration" in seconds, more than 0; it runs 4 seconds')
    const blend = BLEND_MODES.includes(c.blend) ? c.blend : 'normal'
    if (c.blend !== undefined && blend !== c.blend) report('warning', label, `blend "${c.blend}" is not a blend mode; it blends normally`)
    const clip = {
        ...c,
        id: c.id || defaultId,
        type,
        name: c.name || (type === 'sequence' ? c.sequenceId : 'Program'),
        start: isNumber(c.start) && c.start >= 0 ? c.start : 0,
        duration: isNumber(c.duration) && c.duration > 0 ? c.duration : 4,
        offset: isNumber(c.offset) ? c.offset : 0,
        tint: c.tint ?? null,
        opacity: isNumber(c.opacity) ? Math.max(0, Math.min(1, c.opacity)) : 1,
        blend,
    }
    if (type === 'program') {
        if (typeof c.dsl !== 'string' || !c.dsl.trim()) {
            report('error', label, 'needs its program in "dsl"; it shows the default noise program')
            clip.dsl = DEFAULT_PROGRAM_DSL
        }
        clip.loop = isNumber(c.loop) && c.loop > 0 ? c.loop : 8
    } else {
        clip.loopSequence = c.loopSequence !== false
    }
    return clip
}

function checkPlacement(seq, track, report) {
    let previous = null
    for (const clip of track.clips) {
        const where = `${seq.name} › ${track.name} › "${clip.name}"`
        if (previous && clip.start < previous.start + previous.duration - 1e-6) {
            report('warning', where, `overlaps "${previous.name}" on the same track`)
        }
        if (clip.start >= seq.duration) report('warning', where, `starts after the sequence ends (${seq.duration} s)`)
        else if (clip.start + clip.duration > seq.duration + 1e-6) report('warning', where, `runs past the end of the sequence (${seq.duration} s)`)
        previous = clip
    }
}

function checkTransitions(seq, report) {
    for (const track of seq.tracks) {
        const ids = new Set(track.clips.map(c => c.id))
        track.transitions = track.transitions.filter(x => {
            const where = `${seq.name} › ${track.name} › transition "${x.id}"`
            if (!x.from && !x.to) {
                report('error', where, 'needs "from", "to" or both, naming clips on its track; it was left out')
                return false
            }
            for (const end of ['from', 'to']) {
                if (x[end] && !ids.has(x[end])) {
                    report('error', where, `"${end}" names clip "${x[end]}", which is not on ${track.name}; it was left out`)
                    return false
                }
            }
            if (!isNumber(x.duration) || x.duration <= 0) {
                report('warning', where, 'needs a "duration" in seconds; it lasts 1 second')
                x.duration = 1
            }
            return true
        })
    }
}

function positiveInt(v, fallback) {
    return Number.isInteger(v) && v > 0 ? v : fallback
}
