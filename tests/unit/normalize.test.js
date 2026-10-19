import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeProject, safeMediaPath } from '../../js/model/normalize.js'

const DSL = 'search synth\nnoise()\n  .write(o0)\nrender(o0)'

function minimal(extra = {}) {
    return {
        sequences: {
            main: {
                duration: 8,
                tracks: [{ clips: [{ start: 0, duration: 4, dsl: DSL }, { start: 4, duration: 4, dsl: DSL }] }],
            },
        },
        ...extra,
    }
}

test('a short project.json opens with every default filled in', () => {
    const { project, problems } = normalizeProject(minimal(), { name: 'my-video' })
    assert.deepEqual(problems, [])
    assert.equal(project.name, 'my-video')
    assert.equal(project.mainSequenceId, 'main')
    assert.deepEqual(project.sequenceOrder, ['main'])
    const seq = project.sequences.main
    assert.equal(seq.id, 'main')
    assert.equal(seq.name, 'main')
    assert.equal(seq.width, 1920)
    assert.equal(seq.fps, 30)
    assert.equal(seq.post.enabled, true)
    assert.equal(seq.tracks[0].name, 'V1')
    assert.equal(seq.audioTracks.length, 2)
    assert.deepEqual(seq.tracks[0].clips.map(c => [c.id, c.type, c.loop, c.opacity, c.blend]), [
        ['main/V1/1', 'program', 8, 1, 'normal'],
        ['main/V1/2', 'program', 8, 1, 'normal'],
    ])
})

test('the same file always gets the same ids', () => {
    const a = normalizeProject(minimal()).project
    const b = normalizeProject(minimal()).project
    assert.deepEqual(a.sequences.main.tracks[0].clips.map(c => c.id), b.sequences.main.tracks[0].clips.map(c => c.id))
})

test('audio clips name their media; a missing file reference is reported and the clip stays', () => {
    const raw = minimal({ media: { song: { path: 'media/song.flac' } } })
    raw.sequences.main.audioTracks = [{ name: 'Music', clips: [{ mediaId: 'song', start: 0 }] }, { name: 'Voice', clips: [{ mediaId: 'nope', start: 2, duration: 2 }] }]
    const { project, problems } = normalizeProject(raw)
    assert.deepEqual(project.media.song, { path: 'media/song.flac', id: 'song', kind: 'audio', type: 'audio/flac', name: 'song' })
    const [music, voice] = project.sequences.main.audioTracks
    assert.equal(music.clips[0].duration, 8, 'a clip without a duration plays to the end of the sequence')
    assert.equal(voice.clips.length, 1)
    assert.equal(problems.length, 1)
    assert.equal(problems[0].level, 'error')
    assert.match(problems[0].message, /mediaId "nope"/)
})

test('media paths stay inside the project folder', () => {
    assert.equal(safeMediaPath('media/a.wav'), 'media/a.wav')
    assert.equal(safeMediaPath('./a.wav'), 'a.wav')
    assert.equal(safeMediaPath('media\\a.wav'), 'media/a.wav')
    for (const bad of ['../a.wav', '/etc/passwd', 'media/../../a.wav', 'https://example.com/a.wav', 'C:/a.wav', '', null]) {
        assert.equal(safeMediaPath(bad), null, String(bad))
    }
    const { problems } = normalizeProject(minimal({ media: { x: { path: '../x.wav' } } }))
    assert.equal(problems[0].level, 'error')
})

test('transitions must name clips on their own track', () => {
    const raw = minimal()
    raw.sequences.main.tracks[0].clips[0].id = 'a'
    raw.sequences.main.tracks[0].clips[1].id = 'b'
    raw.sequences.main.tracks[0].transitions = [{ from: 'a', to: 'b', duration: 0.5 }, { from: 'a', to: 'zzz' }, {}]
    const { project, problems } = normalizeProject(raw)
    const kept = project.sequences.main.tracks[0].transitions
    assert.equal(kept.length, 1)
    assert.equal(kept[0].preset, 'dissolve')
    assert.equal(problems.filter(p => p.level === 'error').length, 2)
})

test('a nested sequence must exist and must not contain itself', () => {
    const raw = minimal()
    raw.sequences.main.tracks[0].clips.push({ start: 8, duration: 2, sequenceId: 'main' })
    raw.sequences.main.tracks[0].clips.push({ start: 10, duration: 2, sequenceId: 'missing' })
    const { project, problems } = normalizeProject(raw)
    assert.equal(project.sequences.main.tracks[0].clips.length, 2)
    assert.equal(problems.filter(p => p.level === 'error').length, 2)
})

test('overlaps and clips past the end are warnings, not errors', () => {
    const raw = minimal()
    Object.assign(raw.sequences.main.tracks[0].clips[1], { start: 3, duration: 6 })
    const { problems } = normalizeProject(raw)
    assert.deepEqual(problems.map(p => p.level), ['warning', 'warning'])
    assert.match(problems[0].message, /overlaps/)
    assert.match(problems[1].message, /past the end/)
})

test('a clip without its program or timing is reported', () => {
    const raw = minimal()
    raw.sequences.main.tracks[0].clips = [{ name: 'empty' }]
    const { project, problems } = normalizeProject(raw)
    assert.equal(project.sequences.main.tracks[0].clips[0].duration, 4)
    assert.equal(problems.filter(p => p.level === 'error').length, 3)
})

test('a post chain named by preset runs that preset', async () => {
    const { postPreset } = await import('../../js/data/presets.js')
    const raw = minimal()
    raw.sequences.main.post = { preset: 'industrial' }
    const { project, problems } = normalizeProject(raw)
    assert.deepEqual(problems, [])
    assert.equal(project.sequences.main.post.dsl, postPreset('industrial').dsl)
    raw.sequences.main.post = { preset: 'nope' }
    assert.match(normalizeProject(raw).problems[0].message, /not one of clean, cinema/)
})

test('effects are kept by folder path or inline, and bad ones are reported', () => {
    const { project, problems } = normalizeProject(minimal({
        effects: {
            flipTone: { path: 'effects/flipTone' },
            inline: { definition: { passes: [] }, shaders: { p: { glsl: 'x' } } },
            '2bad': { path: 'effects/x' },
            escape: { path: '../outside' },
            empty: {},
        },
    }))
    assert.deepEqual(Object.keys(project.effects), ['flipTone', 'inline'])
    assert.deepEqual(problems.map(p => p.where), ['effect "2bad"', 'effect "escape"', 'effect "empty"'])
    assert.equal(normalizeProject(minimal({ effects: { '': 1 } })).project.effects, undefined)
})

test('files Timeline cannot open are refused with a reason', () => {
    assert.throws(() => normalizeProject([]), /JSON object/)
    assert.throws(() => normalizeProject({ schema: 99, sequences: { a: {} } }), /schema 99/)
    assert.throws(() => normalizeProject({}), /at least one sequence/)
})
