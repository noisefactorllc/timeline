/**
 * Editing operations on a sequence. They mutate the sequence in place; the
 * caller wraps each user action in one history step.
 *
 * Placing a clip overwrites whatever it lands on, like an overwrite edit in
 * a video editor: clips underneath are trimmed, split or removed. Trimming
 * stops at the neighbouring clip instead. Transitions that no longer sit on
 * a valid cut are dropped, and their durations are clamped to what the
 * clips allow.
 */

import {
    uid, clipEnd, findClip, findTransition, createTransition, createMarker,
    createTrack, createAudioTrack,
} from './project.js'
import { transitionSpan, maxTransitionDuration, ADJACENT_EPS } from './evaluate.js'

const MIN_CLIP = 1 / 120

function sortClips(track) {
    track.clips.sort((a, b) => a.start - b.start)
}

export function cloneClip(clip, patch = {}) {
    return { ...structuredClone(clip), id: uid(clip.id.split('_')[0] || 'clp'), ...patch }
}

/** Keep only transitions on valid cuts, one per cut, within allowed length. */
export function normalizeTransitions(track) {
    if (!track.transitions) return
    const seen = new Set()
    track.transitions = track.transitions.filter(tr => {
        const key = `${tr.from}|${tr.to}`
        if (seen.has(key)) return false
        if (!transitionSpan(track, tr)) return false
        seen.add(key)
        const max = maxTransitionDuration(track, tr)
        if (tr.duration > max) tr.duration = max
        return tr.duration > 0
    })
}

/**
 * Clear [start, end) on a track for an overwrite edit. Clips in `keep`
 * are left alone.
 */
export function carve(track, start, end, keep = new Set()) {
    const added = []
    track.clips = track.clips.filter(clip => {
        if (keep.has(clip.id)) return true
        const cEnd = clipEnd(clip)
        if (cEnd <= start + ADJACENT_EPS || clip.start >= end - ADJACENT_EPS) return true
        if (clip.start >= start - ADJACENT_EPS && cEnd <= end + ADJACENT_EPS) return false
        if (clip.start < start && cEnd > end) {
            const right = cloneClip(clip, {
                start: end,
                duration: cEnd - end,
                offset: clip.offset + (end - clip.start),
            })
            clip.duration = start - clip.start
            for (const tr of track.transitions || []) {
                if (tr.from === clip.id) tr.from = right.id
            }
            added.push(right)
            return true
        }
        if (clip.start < start) {
            clip.duration = start - clip.start
            return true
        }
        const cut = end - clip.start
        clip.start = end
        clip.offset += cut
        clip.duration = cEnd - end
        return true
    })
    track.clips.push(...added)
    sortClips(track)
    normalizeTransitions(track)
}

/** Overwrite-insert a clip onto a track. */
export function insertClip(track, clip) {
    carve(track, clip.start, clipEnd(clip))
    track.clips.push(clip)
    sortClips(track)
    normalizeTransitions(track)
    return clip
}

function detach(seq, clipId) {
    const found = findClip(seq, clipId)
    if (!found) return null
    found.track.clips = found.track.clips.filter(c => c.id !== clipId)
    return found
}

/**
 * Move clips by a time delta and a track-index delta (visual and audio
 * tracks shift within their own kind). Moved clips overwrite what they land on.
 */
export function moveClips(seq, clipIds, delta, trackDelta = 0) {
    const moving = []
    for (const id of clipIds) {
        const found = findClip(seq, id)
        if (!found || found.track.locked) continue
        const list = found.kind === 'visual' ? seq.tracks : seq.audioTracks
        const index = list.indexOf(found.track)
        const targetIndex = Math.max(0, Math.min(list.length - 1, index + trackDelta))
        moving.push({ ...found, list, targetIndex })
    }
    if (!moving.length) return
    const minStart = Math.min(...moving.map(m => m.clip.start))
    const shift = Math.max(delta, -minStart)
    const sameTrack = moving.every(m => m.list[m.targetIndex] === m.track)
    for (const m of moving) {
        m.track.clips = m.track.clips.filter(c => c.id !== m.clip.id)
        if (!sameTrack && m.track.transitions) {
            m.track.transitions = m.track.transitions.filter(tr => tr.from !== m.clip.id && tr.to !== m.clip.id)
        }
    }
    const movingIds = new Set(moving.map(m => m.clip.id))
    for (const m of moving) {
        const target = m.list[m.targetIndex]
        if (target.locked) {
            m.track.clips.push(m.clip)
            sortClips(m.track)
            continue
        }
        m.clip.start += shift
        carve(target, m.clip.start, clipEnd(m.clip), movingIds)
        target.clips.push(m.clip)
        sortClips(target)
    }
    for (const track of [...seq.tracks]) normalizeTransitions(track)
}

/** Neighbouring clip edges that a trim may not cross. */
function neighbours(track, clip) {
    let prevEnd = 0
    let nextStart = Infinity
    for (const other of track.clips) {
        if (other.id === clip.id) continue
        if (clipEnd(other) <= clip.start + ADJACENT_EPS) prevEnd = Math.max(prevEnd, clipEnd(other))
        if (other.start >= clipEnd(clip) - ADJACENT_EPS) nextStart = Math.min(nextStart, other.start)
    }
    return { prevEnd, nextStart }
}

/**
 * Trim a clip edge to `time`. `limits.sourceDuration` bounds a clip whose
 * source has an end (audio media, a non-looping nested sequence).
 */
export function trimClip(seq, clipId, edge, time, limits = {}) {
    const found = findClip(seq, clipId)
    if (!found || found.track.locked) return
    const { track, clip } = found
    const { prevEnd, nextStart } = neighbours(track, clip)
    const end = clipEnd(clip)
    const sourceDuration = limits.sourceDuration
    if (edge === 'start') {
        let start = Math.min(time, end - MIN_CLIP)
        start = Math.max(start, prevEnd)
        if (Number.isFinite(sourceDuration) || clip.type === 'audio' || clip.mediaId) {
            start = Math.max(start, clip.start - clip.offset)
        }
        clip.offset += start - clip.start
        clip.duration = end - start
        clip.start = start
    } else {
        let newEnd = Math.max(time, clip.start + MIN_CLIP)
        newEnd = Math.min(newEnd, nextStart)
        if (Number.isFinite(sourceDuration)) newEnd = Math.min(newEnd, clip.start + (sourceDuration - clip.offset))
        clip.duration = newEnd - clip.start
    }
    if (track.transitions) normalizeTransitions(track)
}

/** Split one clip at `t`. Returns the new right-hand clip, or null. */
export function splitClip(seq, clipId, t) {
    const found = findClip(seq, clipId)
    if (!found || found.track.locked) return null
    const { track, clip } = found
    if (t <= clip.start + MIN_CLIP || t >= clipEnd(clip) - MIN_CLIP) return null
    const right = cloneClip(clip, {
        start: t,
        duration: clipEnd(clip) - t,
        offset: clip.offset + (t - clip.start),
    })
    clip.duration = t - clip.start
    for (const tr of track.transitions || []) {
        if (tr.from === clip.id) tr.from = right.id
    }
    track.clips.push(right)
    sortClips(track)
    if (track.transitions) normalizeTransitions(track)
    return right
}

/** Split every clip under `t` on the given tracks (all unlocked tracks by default). */
export function splitAt(seq, t, trackIds = null) {
    const created = []
    for (const track of [...seq.tracks, ...seq.audioTracks]) {
        if (track.locked || (trackIds && !trackIds.includes(track.id))) continue
        const clip = track.clips.find(c => t > c.start && t < clipEnd(c))
        if (!clip) continue
        const right = splitClip(seq, clip.id, t)
        if (right) created.push(right)
    }
    return created
}

export function deleteClips(seq, clipIds) {
    const ids = new Set(clipIds)
    for (const track of [...seq.tracks, ...seq.audioTracks]) {
        if (track.locked) continue
        track.clips = track.clips.filter(c => !ids.has(c.id))
        if (track.transitions) {
            track.transitions = track.transitions.filter(tr => !ids.has(tr.from) && !ids.has(tr.to))
        }
    }
}

export function deleteTransition(seq, transitionId) {
    const found = findTransition(seq, transitionId)
    if (!found) return
    found.track.transitions = found.track.transitions.filter(t => t.id !== transitionId)
}

/**
 * The cut nearest `t` on a track: two adjacent clips, or a clip edge with
 * nothing next to it (for a fade). Returns {from, to, time} or null.
 */
export function cutNear(track, t, tolerance = Infinity) {
    let best = null
    const consider = (from, to, time) => {
        const d = Math.abs(time - t)
        if (d <= tolerance && (!best || d < best.distance)) best = { from, to, time, distance: d }
    }
    const clips = [...track.clips].sort((a, b) => a.start - b.start)
    clips.forEach((clip, i) => {
        const prev = clips[i - 1]
        const next = clips[i + 1]
        const prevAdjacent = prev && Math.abs(clipEnd(prev) - clip.start) <= ADJACENT_EPS
        const nextAdjacent = next && Math.abs(clipEnd(clip) - next.start) <= ADJACENT_EPS
        if (!prevAdjacent) consider(null, clip.id, clip.start)
        if (nextAdjacent) consider(clip.id, next.id, clipEnd(clip))
        else consider(clip.id, null, clipEnd(clip))
    })
    return best
}

/** Put a transition on a cut (replacing any already there). */
export function addTransition(track, { from = null, to = null, duration = 1, preset, dsl }) {
    track.transitions = track.transitions.filter(tr => !(tr.from === from && tr.to === to))
    const transition = createTransition({ from, to, duration, preset, dsl })
    const max = maxTransitionDuration(track, transition)
    transition.duration = Math.min(duration, max)
    if (!(transition.duration > 0)) return null
    track.transitions.push(transition)
    normalizeTransitions(track)
    return track.transitions.includes(transition) ? transition : null
}

export function setTransitionDuration(seq, transitionId, duration) {
    const found = findTransition(seq, transitionId)
    if (!found) return
    const max = maxTransitionDuration(found.track, found.transition)
    found.transition.duration = Math.max(1 / 120, Math.min(duration, max))
}

export function addMarker(seq, time, name) {
    const marker = createMarker({ time, name: name || `Marker ${seq.markers.length + 1}` })
    seq.markers.push(marker)
    seq.markers.sort((a, b) => a.time - b.time)
    return marker
}

export function deleteMarker(seq, markerId) {
    seq.markers = seq.markers.filter(m => m.id !== markerId)
}

export function addTrack(seq, kind = 'visual') {
    if (kind === 'audio') {
        const track = createAudioTrack(`A${seq.audioTracks.length + 1}`)
        seq.audioTracks.push(track)
        return track
    }
    const track = createTrack(`V${seq.tracks.length + 1}`)
    seq.tracks.push(track)
    return track
}

export function removeTrack(seq, trackId) {
    if (seq.tracks.length > 1) seq.tracks = seq.tracks.filter(t => t.id !== trackId)
    if (seq.audioTracks.some(t => t.id === trackId)) seq.audioTracks = seq.audioTracks.filter(t => t.id !== trackId)
}

/** Edit points (clip starts and ends) across tracks, sorted. */
export function editPoints(seq) {
    const points = new Set([0, seq.duration])
    for (const track of [...seq.tracks, ...seq.audioTracks]) {
        for (const clip of track.clips) {
            points.add(Number(clip.start.toFixed(6)))
            points.add(Number(clipEnd(clip).toFixed(6)))
        }
    }
    return [...points].sort((a, b) => a - b)
}
