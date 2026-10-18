import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
    frameAt, frameTime, frameCount, formatTimecode, parseTime, loopPhase, barSeconds,
} from '../../js/model/time.js'
import {
    createSequence, createProgramClip, createSequenceClip, createProject, wouldCreateCycle, workRange,
} from '../../js/model/project.js'
import { activeLayers, transitionSpan, upcoming } from '../../js/model/evaluate.js'
import {
    insertClip, moveClips, trimClip, splitClip, splitAt, deleteClips, addTransition, cutNear,
    setTransitionDuration, editPoints,
} from '../../js/model/edit.js'
import { History } from '../../js/model/history.js'

function seqWith(...clips) {
    const seq = createSequence({ tracks: 2, audioTracks: 1 })
    for (const c of clips) insertClip(seq.tracks[0], c)
    return seq
}

test('frame math lands on the frame grid', () => {
    assert.equal(frameAt(1, 30), 30)
    assert.equal(frameAt(29 / 30, 30), 29)
    assert.equal(frameAt(frameTime(7, 24), 24), 7)
    assert.equal(frameCount(2, 30), 60)
    assert.equal(frameCount(61 / 30, 30), 61)
    assert.equal(frameCount(4.0001, 30), 121)
})

test('timecode formats and parses', () => {
    assert.equal(formatTimecode(0, 30), '00:00:00:00')
    assert.equal(formatTimecode(61 + 15 / 30, 30), '00:01:01:15')
    assert.equal(formatTimecode(3600, 24), '01:00:00:00')
    assert.equal(parseTime('00:01:01:15', 30), 61.5)
    assert.equal(parseTime('1:30', 30), 90)
    assert.equal(parseTime('12.5', 30), 12.5)
    assert.equal(parseTime('90f', 30), 3)
    assert.equal(parseTime('nope', 30), null)
})

test('loop phase is seam safe', () => {
    assert.equal(loopPhase(0, 4), 0)
    assert.equal(loopPhase(4, 4), 0)
    assert.equal(loopPhase(4 - 1e-12, 4), 0)
    assert.equal(loopPhase(1, 4), 0.25)
    assert.equal(loopPhase(-1, 4), 0.75)
    assert.equal(barSeconds(120, 4), 2)
})

test('inserting a clip overwrites what it lands on', () => {
    const a = createProgramClip({ start: 0, duration: 10 })
    const seq = seqWith(a)
    const b = createProgramClip({ start: 4, duration: 2 })
    insertClip(seq.tracks[0], b)
    const clips = seq.tracks[0].clips
    assert.equal(clips.length, 3)
    assert.deepEqual(clips.map(c => [c.start, c.duration]), [[0, 4], [4, 2], [6, 4]])
    assert.equal(clips[2].offset, 6, 'the split-off tail keeps its place in the program')
})

test('moving a clip carves the destination and keeps offsets', () => {
    const a = createProgramClip({ start: 0, duration: 4 })
    const b = createProgramClip({ start: 4, duration: 4 })
    const seq = seqWith(a, b)
    moveClips(seq, [b.id], -2, 0)
    assert.deepEqual(seq.tracks[0].clips.map(c => [c.id, c.start, c.duration]), [[a.id, 0, 2], [b.id, 2, 4]])
    moveClips(seq, [b.id], 0, 1)
    assert.equal(seq.tracks[1].clips[0].id, b.id)
    assert.equal(seq.tracks[0].clips.length, 1)
})

test('trims stop at neighbours and move the offset with the in point', () => {
    const a = createProgramClip({ start: 0, duration: 4 })
    const b = createProgramClip({ start: 5, duration: 4 })
    const seq = seqWith(a, b)
    trimClip(seq, b.id, 'start', 2)
    assert.equal(b.start, 4)
    assert.equal(b.offset, -1)
    assert.equal(b.duration, 5)
    trimClip(seq, a.id, 'end', 9)
    assert.equal(a.duration, 4)
})

test('splitting hands the outgoing transition to the right half', () => {
    const a = createProgramClip({ start: 0, duration: 4 })
    const b = createProgramClip({ start: 4, duration: 4 })
    const seq = seqWith(a, b)
    const tr = addTransition(seq.tracks[0], { from: a.id, to: b.id, duration: 1, preset: 'dissolve', dsl: '' })
    assert.ok(tr)
    const right = splitClip(seq, a.id, 2)
    assert.equal(tr.from, right.id)
    assert.equal(right.offset, 2)
    assert.equal(splitAt(seq, 6).length, 1)
})

test('transitions centre on the cut and clamp to the clips', () => {
    const a = createProgramClip({ start: 0, duration: 4 })
    const b = createProgramClip({ start: 4, duration: 1 })
    const seq = seqWith(a, b)
    const track = seq.tracks[0]
    const tr = addTransition(track, { from: a.id, to: b.id, duration: 5, preset: 'dissolve', dsl: '' })
    assert.equal(tr.duration, 2, 'at most twice the shorter clip')
    const span = transitionSpan(track, tr)
    assert.equal(span.start, 3)
    assert.equal(span.end, 5)
    setTransitionDuration(seq, tr.id, 1)
    const layers = activeLayers(seq, 3.75)
    assert.equal(layers.length, 1)
    assert.equal(layers[0].kind, 'transition')
    assert.equal(layers[0].progress, 0.25)
    assert.equal(layers[0].a.localTime, 3.75)
    assert.equal(layers[0].b.localTime, -0.25)
})

test('fades sit inside their clip', () => {
    const a = createProgramClip({ start: 2, duration: 4 })
    const seq = seqWith(a)
    const track = seq.tracks[0]
    const cutIn = cutNear(track, 2.1)
    assert.deepEqual([cutIn.from, cutIn.to, cutIn.time], [null, a.id, 2])
    const fadeIn = addTransition(track, { from: null, to: a.id, duration: 1 })
    const fadeOut = addTransition(track, { from: a.id, to: null, duration: 1 })
    assert.deepEqual([transitionSpan(track, fadeIn).start, transitionSpan(track, fadeIn).end], [2, 3])
    assert.deepEqual([transitionSpan(track, fadeOut).start, transitionSpan(track, fadeOut).end], [5, 6])
    assert.equal(activeLayers(seq, 1).length, 0)
    assert.equal(activeLayers(seq, 2.5)[0].a, null)
})

test('moving a clip away drops the transition on its cut', () => {
    const a = createProgramClip({ start: 0, duration: 4 })
    const b = createProgramClip({ start: 4, duration: 4 })
    const seq = seqWith(a, b)
    addTransition(seq.tracks[0], { from: a.id, to: b.id, duration: 1 })
    moveClips(seq, [b.id], 1, 0)
    assert.equal(seq.tracks[0].transitions.length, 0)
})

test('layers stack bottom to top and skip hidden tracks', () => {
    const seq = createSequence({ tracks: 3, audioTracks: 0 })
    insertClip(seq.tracks[0], createProgramClip({ start: 0, duration: 5 }))
    insertClip(seq.tracks[2], createProgramClip({ start: 1, duration: 2 }))
    assert.deepEqual(activeLayers(seq, 1.5).map(l => l.trackIndex), [0, 2])
    seq.tracks[2].hidden = true
    assert.deepEqual(activeLayers(seq, 1.5).map(l => l.trackIndex), [0])
    const next = upcoming(seq, 4, 6)
    assert.equal(next.clips.length, 1)
})

test('delete removes clips and their transitions', () => {
    const a = createProgramClip({ start: 0, duration: 4 })
    const b = createProgramClip({ start: 4, duration: 4 })
    const seq = seqWith(a, b)
    addTransition(seq.tracks[0], { from: a.id, to: b.id, duration: 1 })
    deleteClips(seq, [a.id])
    assert.equal(seq.tracks[0].clips.length, 1)
    assert.equal(seq.tracks[0].transitions.length, 0)
    assert.ok(editPoints(seq).includes(8))
})

test('nesting refuses cycles', () => {
    const project = createProject()
    const main = project.sequences[project.mainSequenceId]
    const child = createSequence({ name: 'Child' })
    project.sequences[child.id] = child
    insertClip(main.tracks[0], createSequenceClip({ sequenceId: child.id }))
    assert.equal(wouldCreateCycle(project, child.id, main.id), true)
    assert.equal(wouldCreateCycle(project, main.id, child.id), false)
    assert.equal(wouldCreateCycle(project, main.id, main.id), true)
})

test('work range follows in and out points', () => {
    const seq = createSequence({ duration: 30 })
    assert.deepEqual(workRange(seq), { start: 0, end: 30 })
    seq.inPoint = 5
    seq.outPoint = 12
    assert.deepEqual(workRange(seq), { start: 5, end: 12 })
})

test('history undoes and redoes snapshots', () => {
    const h = new History()
    const state = { n: 1 }
    h.push(state, 'set 2')
    state.n = 2
    const back = h.undo(state)
    assert.equal(back.n, 1)
    const forward = h.redo(back)
    assert.equal(forward.n, 2)
    assert.equal(h.canRedo, false)
})
