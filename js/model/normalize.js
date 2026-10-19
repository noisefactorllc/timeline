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

import {
    SCHEMA_VERSION, BLEND_MODES, DEFAULT_POST_DSL, DEFAULT_PROGRAM_DSL, nestedSequenceIds,
    FIT_MODES, MOTION_PRESETS, TEXT_ALIGN, TEXT_DEFAULTS, GRAPHIC_TYPES,
} from './project.js'
import { POST_PRESETS } from '../data/presets.js'
import { isEaseName } from './ease.js'
import { KEYABLE, DUCK_DEFAULTS, DUCK_DETECT } from './automation.js'

/** File extensions Timeline reads, with their kind and MIME type. A .webm is taken as video; its sound still plays from an audio clip. */
export const MEDIA_TYPES = {
    wav: ['audio', 'audio/wav'], mp3: ['audio', 'audio/mpeg'], m4a: ['audio', 'audio/mp4'], aac: ['audio', 'audio/aac'],
    ogg: ['audio', 'audio/ogg'], oga: ['audio', 'audio/ogg'], opus: ['audio', 'audio/ogg'], flac: ['audio', 'audio/flac'],
    png: ['image', 'image/png'], jpg: ['image', 'image/jpeg'], jpeg: ['image', 'image/jpeg'], webp: ['image', 'image/webp'],
    gif: ['image', 'image/gif'], svg: ['image', 'image/svg+xml'], avif: ['image', 'image/avif'],
    mp4: ['video', 'video/mp4'], m4v: ['video', 'video/mp4'], mov: ['video', 'video/quicktime'], webm: ['video', 'video/webm'],
    mkv: ['video', 'video/x-matroska'],
}

export const MEDIA_KINDS = ['audio', 'image', 'video']

/** The kind of a file from its MIME type or name: audio, image, video, or null. */
export function mediaKindOf(type = '', name = '') {
    const major = String(type).split('/')[0]
    if (MEDIA_KINDS.includes(major)) return major
    return MEDIA_TYPES[extensionOf(name)]?.[0] || null
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
    return (String(path).match(/\.([^./]+)$/)?.[1] || '').toLowerCase()
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
        const known = MEDIA_TYPES[extensionOf(source)]
        record.kind = m.kind || known?.[0] || mediaKindOf(m.type) || 'audio'
        if (!MEDIA_KINDS.includes(record.kind)) report('error', `media "${id}"`, `kind "${record.kind}" is not one of ${MEDIA_KINDS.join(', ')}`)
        else if (source && !known && !m.type) report('warning', `media "${id}"`, `"${source}" is not a file type Timeline knows; it is read as ${record.kind}`)
        record.type = m.type || known?.[1] || `${record.kind}/*`
        record.name = m.name || source.split('/').pop()?.replace(/\.[^.]+$/, '') || id
        media[id] = record
    }

    // Custom effects: inline { definition, shaders } or a folder path holding them.
    const effects = {}
    for (const [func, e] of Object.entries(isObject(raw.effects) ? raw.effects : {})) {
        const where = `effect "${func}"`
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(func)) {
            report('error', where, 'its name must be a DSL identifier (letters, digits and _, not starting with a digit)')
            continue
        }
        if (!isObject(e)) {
            report('error', where, 'must be an object with a "path" or a "definition"')
            continue
        }
        if (e.path !== undefined) {
            const path = safeMediaPath(e.path)
            if (!path) {
                report('error', where, `path "${e.path}" must be relative to the project folder, without ".."`)
                continue
            }
            effects[func] = { ...e, path }
        } else if (isObject(e.definition)) {
            effects[func] = { ...e, shaders: isObject(e.shaders) ? e.shaders : {} }
        } else {
            report('error', where, 'needs a "path" to a folder with definition.json and its shaders, or an inline "definition" with "shaders"')
        }
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
        effects: Object.keys(effects).length ? effects : undefined,
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
        const clips = (Array.isArray(track.clips) ? track.clips : []).map((c, j) => normalizeVisualClip(c, `${id}/${j + 1}`, `${name} › ${trackName}`, media, report)).filter(Boolean)
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
            else if (m.kind === 'image') report('error', clipWhere, `mediaId "${c.mediaId}" is an image; an audio clip plays audio or the sound of a video`)
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
                ...normalizeKeys(c.keys, KEYABLE.audio, clipWhere, report),
            }
        }).filter(Boolean)
        const normalized = {
            ...track,
            id,
            name: trackName,
            muted: !!track.muted,
            solo: !!track.solo,
            gain: isNumber(track.gain) && track.gain >= 0 ? track.gain : 1,
            clips: clips.sort((a, b) => a.start - b.start),
        }
        if (track.duck !== undefined && track.duck !== null) normalized.duck = normalizeDuck(track.duck, where, report)
        if (!normalized.duck) delete normalized.duck
        return normalized
    })
    // A duck must name another audio track of this sequence.
    for (const track of seq.audioTracks) {
        if (!track.duck) continue
        const under = track.duck.under
        const trigger = seq.audioTracks.find(t => t !== track && (t.id === under || t.name === under))
        if (!trigger) {
            report('error', `${name} › ${track.name}`, `duck.under "${under}" names no other audio track; it does not duck`)
            delete track.duck
        }
    }

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

const VISUAL_TYPES = ['program', 'sequence', ...GRAPHIC_TYPES]

function normalizeVisualClip(c, defaultId, where, media, report) {
    if (!isObject(c)) return null
    const type = c.type || (c.sequenceId ? 'sequence' : c.text !== undefined ? 'text' : c.mediaId ? (media[c.mediaId]?.kind === 'video' ? 'video' : 'image') : 'program')
    const label = `${where} › "${c.name || defaultId}"`
    if (!VISUAL_TYPES.includes(type)) {
        report('error', label, `type "${type}" is not one of ${VISUAL_TYPES.join(', ')}; the clip was left out`)
        return null
    }
    if (!isNumber(c.start) || c.start < 0) report('error', label, 'needs a "start" in seconds, 0 or more; it starts at 0')
    if (!isNumber(c.duration) || c.duration <= 0) report('error', label, 'needs a "duration" in seconds, more than 0; it runs 4 seconds')
    const blend = BLEND_MODES.includes(c.blend) ? c.blend : 'normal'
    if (c.blend !== undefined && blend !== c.blend) report('warning', label, `blend "${c.blend}" is not a blend mode; it blends normally`)
    const clip = {
        ...c,
        ...normalizeKeys(c.keys, KEYABLE.visual, label, report),
        id: c.id || defaultId,
        type,
        name: c.name || (type === 'sequence' ? c.sequenceId : type === 'program' ? 'Program' : type === 'text' ? String(c.text ?? 'Text').split('\n')[0].slice(0, 40) : media[c.mediaId]?.name || type),
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
    } else if (type === 'sequence') {
        clip.loopSequence = c.loopSequence !== false
    } else {
        normalizeGraphic(clip, c, label, media, report)
    }
    return clip
}

/** Placement, motion and type-specific settings for text, image and video clips. */
function normalizeGraphic(clip, c, label, media, report) {
    const num = (key, fallback, min = -Infinity, max = Infinity) => {
        const v = c[key]
        if (v === undefined) return fallback
        if (!isNumber(v) || v < min || v > max) {
            report('warning', label, `"${key}" must be a number${Number.isFinite(min) ? ` from ${min}` : ''}${Number.isFinite(max) ? ` to ${max}` : ''}; it uses ${fallback}`)
            return fallback
        }
        return v
    }
    clip.x = num('x', 0.5)
    clip.y = num('y', 0.5)
    clip.scale = num('scale', 1, 0)
    clip.rotation = num('rotation', 0)
    const isText = clip.type === 'text'
    for (const side of ['enter', 'exit']) {
        const m = isObject(c[side]) ? c[side] : typeof c[side] === 'string' ? { preset: c[side] } : {}
        let preset = m.preset ?? (isText ? 'fade' : 'none')
        if (!MOTION_PRESETS.includes(preset)) {
            report('warning', label, `${side} preset "${preset}" is not one of ${MOTION_PRESETS.join(', ')}; it uses none`)
            preset = 'none'
        }
        let easeName = m.ease ?? (side === 'enter' ? 'power3.out' : 'power2.in')
        if (!isEaseName(easeName)) {
            report('warning', label, `${side} ease "${easeName}" is not an ease such as power2.out or expo.inOut; it uses power1.out`)
            easeName = 'power1.out'
        }
        clip[side] = { ...m, preset, duration: isNumber(m.duration) && m.duration >= 0 ? m.duration : side === 'enter' ? 0.5 : 0.4, ease: easeName }
    }
    if (isText) {
        for (const [key, fallback] of Object.entries(TEXT_DEFAULTS)) if (clip[key] === undefined) clip[key] = fallback
        clip.text = String(clip.text)
        clip.size = num('size', TEXT_DEFAULTS.size, 0.001, 2)
        clip.weight = num('weight', TEXT_DEFAULTS.weight, 1, 1000)
        clip.lineHeight = num('lineHeight', TEXT_DEFAULTS.lineHeight, 0.1, 10)
        clip.letterSpacing = num('letterSpacing', TEXT_DEFAULTS.letterSpacing, -1, 5)
        clip.maxWidth = num('maxWidth', TEXT_DEFAULTS.maxWidth, 0.01, 10)
        if (!TEXT_ALIGN.includes(clip.align)) {
            report('warning', label, `align "${clip.align}" is not one of ${TEXT_ALIGN.join(', ')}; it is centered`)
            clip.align = 'center'
        }
        return
    }
    const m = media[c.mediaId]
    if (!m) report('error', label, `mediaId "${c.mediaId}" names nothing under "media"; the clip shows nothing`)
    else if (m.kind !== clip.type) report('error', label, `mediaId "${c.mediaId}" is ${m.kind === 'audio' ? 'audio' : `an ${m.kind}`}; a${clip.type === 'image' ? 'n image' : ' video'} clip needs ${clip.type === 'image' ? 'an image' : 'a video'}`)
    if (!FIT_MODES.includes(clip.fit ?? 'contain')) report('warning', label, `fit "${clip.fit}" is not one of ${FIT_MODES.join(', ')}; it uses contain`)
    clip.fit = FIT_MODES.includes(clip.fit) ? clip.fit : 'contain'
    if (clip.type === 'video') clip.loopVideo = !!c.loopVideo
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

/** Keys on a clip: known properties only, each a time-ordered list of { t, v, ease }. */
function normalizeKeys(raw, allowed, where, report) {
    if (raw === undefined || raw === null) return { keys: undefined }
    if (!isObject(raw)) {
        report('warning', where, '"keys" must be an object of properties, each a list of { t, v }; they were left out')
        return { keys: undefined }
    }
    const keys = {}
    for (const [prop, list] of Object.entries(raw)) {
        if (!allowed.includes(prop)) {
            report('warning', where, `"${prop}" cannot take keys; keyable here: ${allowed.join(', ')}`)
            continue
        }
        if (!Array.isArray(list)) {
            report('warning', where, `keys.${prop} must be a list of { t, v }`)
            continue
        }
        const good = []
        for (const k of list) {
            if (!isObject(k) || !isNumber(k.t) || !isNumber(k.v)) {
                report('warning', where, `a key in keys.${prop} needs a number "t" (seconds from the clip's start) and a number "v"; it was left out`)
                continue
            }
            const key = { t: k.t, v: k.v }
            if (k.ease !== undefined) {
                if (isEaseName(k.ease)) key.ease = k.ease
                else report('warning', where, `keys.${prop} at ${k.t} s: ease "${k.ease}" is not an ease such as power2.inOut; it uses power2.inOut`)
            }
            good.push(key)
        }
        if (good.length) keys[prop] = good.sort((a, b) => a.t - b.t)
    }
    return { keys: Object.keys(keys).length ? keys : undefined }
}

function normalizeDuck(raw, where, report) {
    if (!isObject(raw) || typeof raw.under !== 'string' || !raw.under) {
        report('error', where, '"duck" needs "under", the name or id of the audio track to duck under; it does not duck')
        return null
    }
    const duck = { under: raw.under }
    for (const [key, fallback] of Object.entries(DUCK_DEFAULTS)) {
        const v = raw[key]
        const decibels = key === 'depth' || key === 'threshold'
        const valid = isNumber(v) && (decibels ? v <= 0 : v >= 0)
        if (v !== undefined && !valid) report('warning', where, `duck.${key} must be ${decibels ? 'a number of dB, 0 or less' : 'seconds, 0 or more'}; it uses ${fallback}`)
        duck[key] = valid ? v : fallback
    }
    duck.detect = DUCK_DETECT.includes(raw.detect) ? raw.detect : 'signal'
    if (raw.detect !== undefined && raw.detect !== duck.detect) report('warning', where, `duck.detect must be ${DUCK_DETECT.join(' or ')}; it uses signal`)
    return duck
}

function positiveInt(v, fallback) {
    return Number.isInteger(v) && v > 0 ? v : fallback
}
