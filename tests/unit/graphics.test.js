import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ease, isEaseName } from '../../js/model/ease.js'
import { motionAt } from '../../js/render/graphics.js'
import { normalizeProject, mediaKindOf } from '../../js/model/normalize.js'
import { createTextClip, createMediaClip } from '../../js/model/project.js'
import { overlayTrack, freeAudioTrack } from '../../js/model/edit.js'
import { createSequence, createProgramClip, createAudioClip } from '../../js/model/project.js'

test('eases start at 0, end at 1 and follow their direction', () => {
    for (const name of ['none', 'power1.out', 'power3.in', 'power2.inOut', 'sine.out', 'expo.out', 'circ.inOut', 'back.out']) {
        const f = ease(name)
        assert.ok(Math.abs(f(0)) < 1e-9, name)
        assert.ok(Math.abs(f(1) - 1) < 1e-9, name)
    }
    assert.ok(ease('power3.out')(0.25) > 0.25, 'out eases are ahead early')
    assert.ok(ease('power3.in')(0.25) < 0.25, 'in eases are behind early')
    assert.equal(ease('power2.inOut')(0.5), 0.5)
    assert.equal(ease('none')(0.3), 0.3)
    assert.ok(ease('back.out')(0.6) > 1, 'back overshoots')
    assert.equal(ease('power3')(0.25), ease('power3.out')(0.25), 'no direction means out')
    assert.equal(ease('nonsense')(0.5), ease('power1.out')(0.5))
    assert.ok(isEaseName('expo.inOut'))
    assert.ok(!isEaseName('expo.sideways'))
    assert.ok(!isEaseName('bounce.out'))
})

test('enter and exit motion shape a graphic over its first and last moments', () => {
    const clip = createTextClip({ duration: 4, enter: { preset: 'fade', duration: 1, ease: 'none' }, exit: { preset: 'rise', duration: 1, ease: 'none' } })
    assert.equal(motionAt(clip, 0).alpha, 0)
    assert.equal(motionAt(clip, 0.5).alpha, 0.5)
    assert.deepEqual(motionAt(clip, 2), { alpha: 1, dy: 0, scale: 1, blur: 0, wipeFrom: 0, wipeTo: 1, reveal: 1 })
    const leaving = motionAt(clip, 3.5)
    assert.equal(leaving.alpha, 0.5)
    assert.ok(leaving.dy < 0, 'a rising exit moves up')
    const typed = motionAt({ ...clip, enter: { preset: 'type', duration: 2, ease: 'none' } }, 1)
    assert.equal(typed.reveal, 0.5)
    assert.equal(typed.alpha, 1)
    const image = createMediaClip({ duration: 4 })
    const typedImage = motionAt({ ...image, enter: { preset: 'type', duration: 2, ease: 'none' } }, 1)
    assert.equal(typedImage.alpha, 0.5, 'type-on fades an image')
    const wiped = motionAt({ ...clip, enter: { preset: 'wipe', duration: 1, ease: 'none' } }, 0.25)
    assert.equal(wiped.wipeTo, 0.25)
})

test('files are sorted into audio, image and video by type or name', () => {
    assert.equal(mediaKindOf('image/png', 'x'), 'image')
    assert.equal(mediaKindOf('', 'logo.SVG'), 'image')
    assert.equal(mediaKindOf('', 'clip.mov'), 'video')
    assert.equal(mediaKindOf('audio/flac', 'a.bin'), 'audio')
    assert.equal(mediaKindOf('', 'notes.txt'), null)
})

test('text, image and video clips in project.json get their defaults and are checked', () => {
    const raw = {
        media: {
            logo: { path: 'media/logo.svg' },
            film: { path: 'media/film.mp4' },
            song: { path: 'media/song.flac' },
        },
        sequences: {
            main: {
                duration: 10,
                tracks: [
                    { clips: [{ mediaId: 'film', start: 0, duration: 4 }, { mediaId: 'logo', start: 4, duration: 2, fit: 'cover' }] },
                    { clips: [{ text: 'Hello\nworld', start: 0, duration: 3, enter: 'rise', exit: { preset: 'spin' } }] },
                    { clips: [{ type: 'image', mediaId: 'song', start: 0, duration: 1 }, { type: 'text', start: 2, duration: 1, size: 'big', align: 'middle' }] },
                ],
                audioTracks: [{ clips: [{ mediaId: 'film', start: 0, duration: 4 }, { mediaId: 'logo', start: 5, duration: 1 }] }],
            },
        },
    }
    const { project, problems } = normalizeProject(raw)
    assert.deepEqual(Object.values(project.media).map(m => [m.id, m.kind, m.type]), [
        ['logo', 'image', 'image/svg+xml'], ['film', 'video', 'video/mp4'], ['song', 'audio', 'audio/flac'],
    ])
    const [v1, v2, v3] = project.sequences.main.tracks
    assert.deepEqual(v1.clips.map(c => [c.type, c.fit, c.x, c.y, c.scale, c.enter.preset]), [['video', 'contain', 0.5, 0.5, 1, 'none'], ['image', 'cover', 0.5, 0.5, 1, 'none']])
    assert.equal(v1.clips[0].loopVideo, false)
    const text = v2.clips[0]
    assert.equal(text.type, 'text')
    assert.equal(text.name, 'Hello')
    assert.equal(text.font, 'Inter')
    assert.deepEqual(text.enter, { preset: 'rise', duration: 0.5, ease: 'power3.out' })
    assert.equal(text.exit.preset, 'none')
    assert.equal(v3.clips[1].size, 0.09)
    assert.equal(v3.clips[1].align, 'center')
    const messages = problems.map(p => `${p.level}: ${p.message}`)
    assert.ok(messages.includes('warning: exit preset "spin" is not one of none, fade, rise, drop, scale, wipe, blur, type; it uses none'))
    assert.ok(messages.includes('error: mediaId "song" is audio; an image clip needs an image'))
    assert.ok(messages.some(m => m.startsWith('warning: "size" must be a number')))
    assert.ok(messages.some(m => m.startsWith('warning: align "middle"')))
    assert.ok(messages.includes('error: mediaId "logo" is an image; an audio clip plays audio or the sound of a video'))
    assert.equal(problems.filter(p => p.level === 'error').length, 2)
})

test('a title goes on the first track above everything showing, adding one when needed', () => {
    const seq = createSequence({ tracks: 2, audioTracks: 1 })
    seq.tracks[0].clips.push(createProgramClip({ start: 0, duration: 8 }))
    assert.equal(overlayTrack(seq, 2, 4), seq.tracks[1])
    seq.tracks[1].clips.push(createProgramClip({ start: 3, duration: 2 }))
    const added = overlayTrack(seq, 2, 4)
    assert.equal(seq.tracks.length, 3)
    assert.equal(added, seq.tracks[2])
    assert.equal(overlayTrack(seq, 10, 12), seq.tracks[0], 'nothing showing then, so the bottom track')
    seq.audioTracks[0].clips.push(createAudioClip({ mediaId: 'm', start: 0, duration: 5 }))
    assert.equal(freeAudioTrack(seq, 6, 8), seq.audioTracks[0])
    assert.equal(freeAudioTrack(seq, 1, 2), seq.audioTracks[1])
})


test('text background dimensions preserve old defaults and validate subtitle styling', () => {
    const { project, problems } = normalizeProject({ sequences: { main: { tracks: [{ clips: [
        { text: 'default', start: 0, duration: 1 },
        { text: 'subtitle', start: 1, duration: 1, backgroundPaddingX: 34 / 52, backgroundPaddingY: 16 / 52, backgroundRadius: 22 / 52 },
        { text: 'invalid', start: 2, duration: 1, backgroundPaddingX: -1, backgroundPaddingY: 'wide', backgroundRadius: Infinity },
    ] }] } } })
    const [plain, styled, invalid] = project.sequences.main.tracks[0].clips
    for (const c of [plain, invalid, createTextClip()]) {
        assert.equal(c.backgroundPaddingX, 0.3)
        assert.equal(c.backgroundPaddingY, 0.3)
        assert.equal(c.backgroundRadius, 0)
    }
    assert.equal(styled.backgroundPaddingX, 34 / 52)
    assert.equal(styled.backgroundPaddingY, 16 / 52)
    assert.equal(styled.backgroundRadius, 22 / 52)
    assert.equal(problems.filter(p => /background(Padding|Radius)/.test(p.message)).length, 3)
})


test('text outline and shadow are optional, validated styles that survive a project round trip', () => {
    const raw = { sequences: { main: { tracks: [{ clips: [
        { text: 'plain', start: 0, duration: 1 },
        { text: 'styled', start: 1, duration: 1, outline: { color: '#ff0000', width: 0.08 }, shadow: { color: '#00ff00', blur: 0.1, x: -0.2, y: 0.3 } },
        { text: 'invalid', start: 2, duration: 1, outline: { width: -1 }, shadow: { blur: Infinity, x: 'left', y: 0.2 } },
    ] }] } } }
    const { project, problems } = normalizeProject(raw)
    const [plain, styled, invalid] = project.sequences.main.tracks[0].clips
    assert.equal(plain.outline, null)
    assert.equal(plain.shadow, null)
    assert.equal(createTextClip().outline, null)
    assert.equal(createTextClip().shadow, null)
    assert.deepEqual(styled.outline, { color: '#ff0000', width: 0.08 })
    assert.deepEqual(styled.shadow, { color: '#00ff00', blur: 0.1, x: -0.2, y: 0.3 })
    assert.equal(invalid.outline.width, 0.04)
    assert.equal(invalid.shadow.blur, 0.1)
    assert.equal(invalid.shadow.x, 0)
    assert.equal(invalid.shadow.y, 0.2)
    assert.equal(problems.filter(p => /outline.width|shadow.blur|shadow.x/.test(p.message)).length, 3)
    const again = normalizeProject(JSON.parse(JSON.stringify(project))).project.sequences.main.tracks[0].clips[1]
    assert.deepEqual(again.outline, styled.outline)
    assert.deepEqual(again.shadow, styled.shadow)
})
