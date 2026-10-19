/**
 * Project schema and factories.
 *
 * A project holds sequences and media. A sequence is a stack of visual
 * tracks (V1 at the bottom), audio tracks, markers and one post chain that
 * every composited frame passes through. Visual clips are DSL programs or
 * nested sequences; transitions sit on the cut between two adjacent clips
 * on one track, or fade a clip in from black or out to black.
 *
 * Everything here is plain JSON so a project saves, diffs and undoes as data.
 */

export const SCHEMA_VERSION = 1

export function uid(prefix = 'id') {
    const rand = globalThis.crypto?.randomUUID
        ? globalThis.crypto.randomUUID().replace(/-/g, '').slice(0, 12)
        : Math.random().toString(36).slice(2, 14)
    return `${prefix}_${rand}`
}

export const DEFAULT_PROGRAM_DSL = `search synth, filter
noise(octaves: 3, ridges: true, colorMode: rgb)
  .write(o0)
render(o0)`

export const DEFAULT_POST_DSL = `search synth, filter
media()
  .bloom(intensity: audio(band: audioBand.low, min: 0.2, max: 0.6))
  .grain(alpha: 0.18)
  .vignette(alpha: 0.55)
  .write(o0)
render(o0)`

export const BLEND_MODES = [
    'normal', 'add', 'screen', 'multiply', 'overlay', 'lighten', 'darken',
    'difference', 'exclusion', 'color-dodge', 'color-burn', 'hard-light',
    'soft-light', 'hue', 'saturation', 'color', 'luminosity',
]

export function createProject({ name = 'Untitled project' } = {}) {
    const main = createSequence({ name: 'Main' })
    const now = Date.now()
    return {
        schema: SCHEMA_VERSION,
        id: uid('prj'),
        name,
        createdAt: now,
        updatedAt: now,
        media: {},
        sequences: { [main.id]: main },
        sequenceOrder: [main.id],
        mainSequenceId: main.id,
    }
}

export function createSequence({
    name = 'Sequence',
    width = 1920,
    height = 1080,
    fps = 30,
    duration = 60,
    bpm = 120,
    beatsPerBar = 4,
    tracks = 3,
    audioTracks = 2,
} = {}) {
    const seq = {
        id: uid('seq'),
        name,
        width,
        height,
        fps,
        duration,
        bpm,
        beatsPerBar,
        gridOffset: 0,
        inPoint: null,
        outPoint: null,
        audioSensitivity: 1,
        tracks: [],
        audioTracks: [],
        markers: [],
        post: { enabled: true, preset: 'cinema', dsl: DEFAULT_POST_DSL, loop: 8 },
    }
    for (let i = 0; i < tracks; i++) seq.tracks.push(createTrack(`V${i + 1}`))
    for (let i = 0; i < audioTracks; i++) seq.audioTracks.push(createAudioTrack(`A${i + 1}`))
    return seq
}

export function createTrack(name = 'V1') {
    return { id: uid('trk'), name, hidden: false, locked: false, clips: [], transitions: [] }
}

export function createAudioTrack(name = 'A1') {
    return { id: uid('atk'), name, muted: false, solo: false, gain: 1, clips: [] }
}

export function createProgramClip({
    name = 'Program',
    start = 0,
    duration = 8,
    dsl = DEFAULT_PROGRAM_DSL,
    loop = 8,
    offset = 0,
    tint = null,
    opacity = 1,
    blend = 'normal',
} = {}) {
    return {
        id: uid('clp'),
        type: 'program',
        name,
        start,
        duration,
        offset,
        loop,
        dsl,
        tint,
        opacity,
        blend,
    }
}

export function createSequenceClip({
    sequenceId, name = 'Sequence', start = 0, duration = 8, offset = 0, opacity = 1, blend = 'normal',
} = {}) {
    return {
        id: uid('clp'),
        type: 'sequence',
        name,
        start,
        duration,
        offset,
        sequenceId,
        loopSequence: true,
        tint: null,
        opacity,
        blend,
    }
}

export function createAudioClip({ mediaId, name = 'Audio', start = 0, duration = 10, offset = 0 } = {}) {
    return {
        id: uid('aud'),
        mediaId,
        name,
        start,
        duration,
        offset,
        gain: 1,
        fadeIn: 0,
        fadeOut: 0,
    }
}

/**
 * A transition. `from` is the outgoing clip and `to` the incoming one; a
 * null `from` fades `to` in from black and a null `to` fades `from` out.
 */
export function createTransition({ from = null, to = null, duration = 1, preset = 'dissolve', dsl = '' } = {}) {
    return { id: uid('trn'), from, to, duration, preset, dsl }
}

export function createMarker({ time = 0, name = 'Marker' } = {}) {
    return { id: uid('mrk'), time, name }
}

// --- queries -------------------------------------------------------------

export function clipEnd(clip) {
    return clip.start + clip.duration
}

export function getSequence(project, id) {
    return project?.sequences?.[id] || null
}

export function findClip(seq, clipId) {
    for (const track of seq.tracks) {
        const clip = track.clips.find(c => c.id === clipId)
        if (clip) return { track, clip, kind: 'visual' }
    }
    for (const track of seq.audioTracks) {
        const clip = track.clips.find(c => c.id === clipId)
        if (clip) return { track, clip, kind: 'audio' }
    }
    return null
}

export function findTransition(seq, transitionId) {
    for (const track of seq.tracks) {
        const transition = track.transitions.find(t => t.id === transitionId)
        if (transition) return { track, transition }
    }
    return null
}

export function findTrack(seq, trackId) {
    return seq.tracks.find(t => t.id === trackId) || seq.audioTracks.find(t => t.id === trackId) || null
}

/** Sequences that `seqId` contains directly or through nesting. */
export function nestedSequenceIds(project, seqId, seen = new Set()) {
    const seq = getSequence(project, seqId)
    if (!seq) return seen
    for (const track of seq.tracks) {
        for (const clip of track.clips) {
            if (clip.type !== 'sequence' || seen.has(clip.sequenceId)) continue
            seen.add(clip.sequenceId)
            nestedSequenceIds(project, clip.sequenceId, seen)
        }
    }
    return seen
}

/** True when placing `childId` inside `parentId` would make a cycle. */
export function wouldCreateCycle(project, parentId, childId) {
    if (parentId === childId) return true
    return nestedSequenceIds(project, childId).has(parentId)
}

/** The end of the last clip on any track, visual or audio. */
export function contentEnd(seq) {
    let end = 0
    for (const track of [...seq.tracks, ...seq.audioTracks]) {
        for (const clip of track.clips) end = Math.max(end, clipEnd(clip))
    }
    return end
}

/** The export/playback range: in/out when set, otherwise the whole sequence. */
export function workRange(seq) {
    const start = Number.isFinite(seq.inPoint) ? seq.inPoint : 0
    const end = Number.isFinite(seq.outPoint) ? seq.outPoint : seq.duration
    return end > start ? { start, end } : { start: 0, end: seq.duration }
}
