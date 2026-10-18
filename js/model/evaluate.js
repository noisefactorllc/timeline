/**
 * What is on screen at a time: the visual layers of a sequence, bottom to
 * top, each a clip at its local time or a transition between two clips.
 *
 * A transition on a cut is centered on it, so the outgoing program runs on
 * for half the transition past its out point and the incoming one starts
 * half a transition early. Programs are generative, so both always have
 * frames to give. A fade from black sits at the start of its clip and a
 * fade to black at the end.
 */

import { clipEnd } from './project.js'

/** Two clips closer than this share a cut. */
export const ADJACENT_EPS = 1e-4

/** Local time of a clip at sequence time `t`. Runs past both ends. */
export function clipLocalTime(clip, t) {
    return clip.offset + (t - clip.start)
}

/** The span a transition covers on its track, or null when it is invalid. */
export function transitionSpan(track, transition) {
    const a = transition.from ? track.clips.find(c => c.id === transition.from) : null
    const b = transition.to ? track.clips.find(c => c.id === transition.to) : null
    const d = transition.duration
    if (!(d > 0)) return null
    if (a && b) {
        if (Math.abs(clipEnd(a) - b.start) > ADJACENT_EPS) return null
        const cut = b.start
        return { start: cut - d / 2, end: cut + d / 2, a, b, cut }
    }
    if (b && !transition.from) return { start: b.start, end: b.start + d, a: null, b, cut: b.start }
    if (a && !transition.to) return { start: clipEnd(a) - d, end: clipEnd(a), a, b: null, cut: clipEnd(a) }
    return null
}

/** Longest a transition may run between two clips (or at one clip's edge). */
export function maxTransitionDuration(track, transition) {
    const a = transition.from ? track.clips.find(c => c.id === transition.from) : null
    const b = transition.to ? track.clips.find(c => c.id === transition.to) : null
    if (a && b) return 2 * Math.min(a.duration, b.duration)
    if (a) return a.duration
    if (b) return b.duration
    return 0
}

/**
 * Visual layers at time `t`, bottom (V1) to top. Hidden tracks are skipped.
 * @returns {Array<object>} layers
 */
export function activeLayers(seq, t) {
    const layers = []
    seq.tracks.forEach((track, trackIndex) => {
        if (track.hidden) return
        for (const transition of track.transitions) {
            const span = transitionSpan(track, transition)
            if (!span || t < span.start || t >= span.end) continue
            const progress = (t - span.start) / (span.end - span.start)
            layers.push({
                kind: 'transition',
                track,
                trackIndex,
                transition,
                progress,
                span,
                a: span.a ? { clip: span.a, localTime: clipLocalTime(span.a, t) } : null,
                b: span.b ? { clip: span.b, localTime: clipLocalTime(span.b, t) } : null,
            })
            return
        }
        for (const clip of track.clips) {
            if (t >= clip.start && t < clipEnd(clip)) {
                layers.push({ kind: 'clip', track, trackIndex, clip, localTime: clipLocalTime(clip, t) })
                return
            }
        }
    })
    return layers
}

/**
 * Clips (and transitions) that will be on screen between `t0` and `t1`,
 * so their renderers can compile before they are needed.
 */
export function upcoming(seq, t0, t1) {
    const clips = new Set()
    const transitions = new Set()
    for (const track of seq.tracks) {
        if (track.hidden) continue
        for (const clip of track.clips) {
            if (clip.start < t1 && clipEnd(clip) > t0) clips.add(clip)
        }
        for (const transition of track.transitions) {
            const span = transitionSpan(track, transition)
            if (span && span.start < t1 && span.end > t0) {
                transitions.add(transition)
                if (span.a) clips.add(span.a)
                if (span.b) clips.add(span.b)
            }
        }
    }
    return { clips: [...clips], transitions: [...transitions] }
}
