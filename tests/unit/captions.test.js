import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseCaptions, groupWords, captionClips, isCaptionFile } from '../../js/model/captions.js'

test('SRT cues keep their times and lines', () => {
    const srt = `1
00:00:01,000 --> 00:00:03,500
Cut programs
to music

2
00:00:04,250 --> 00:00:06,000
<i>with Timeline</i>
`
    assert.deepEqual(parseCaptions(srt, 'a.srt'), [
        { start: 1, end: 3.5, text: 'Cut programs\nto music' },
        { start: 4.25, end: 6, text: 'with Timeline' },
    ])
})

test('WebVTT cues drop their ids, settings and tags, and inline timestamps time each word', () => {
    const vtt = `WEBVTT

NOTE made by a speech tool

intro
00:01.000 --> 00:02.500 align:center line:90%
<v Narrator>Hello &amp; welcome</v>

00:00:03.000 --> 00:00:05.000
<00:00:03.000>Meet <00:00:03.400>Timeline
`
    const cues = parseCaptions(vtt, 'a.vtt')
    assert.deepEqual(cues[0], { start: 1, end: 2.5, text: 'Hello & welcome' })
    assert.equal(cues[1].text, 'Meet Timeline')
    assert.deepEqual(cues[1].words, [{ start: 3, end: 3.4, text: 'Meet' }, { start: 3.4, end: 5, text: 'Timeline' }])
})

test('JSON word lists are grouped into lines at pauses, sentence ends and line length', () => {
    const words = [
        { text: 'Meet', start: 0.2, end: 0.5 }, { text: 'Noisedeck.', start: 0.55, end: 1.1 },
        { text: 'Programs', start: 1.3, end: 1.8 }, { text: 'move', start: 1.85, end: 2.1 }, { text: 'to', start: 2.15, end: 2.25 },
        { text: 'music', start: 2.3, end: 2.7 }, { text: 'now', start: 4, end: 4.3 },
    ]
    const cues = parseCaptions(JSON.stringify(words), 'words.json')
    assert.deepEqual(cues.map(c => [c.text, c.start, c.end]), [
        ['Meet Noisedeck.', 0.2, 1.1],
        ['Programs move to music', 1.3, 2.7],
        ['now', 4, 4.3],
    ])
    const long = Array.from({ length: 12 }, (_, i) => ({ text: 'word', start: i * 0.3, end: i * 0.3 + 0.25 }))
    assert.ok(groupWords(long).every(c => c.text.length <= 42))
})

test('JSON from speech tools: Whisper segments, chunks with timestamps, and word objects', () => {
    const whisper = { segments: [{ start: 0, end: 2, text: ' Hello there', words: [{ word: 'Hello', start: 0, end: 0.5 }, { word: 'there', start: 0.6, end: 1 }] }] }
    const [cue] = parseCaptions(JSON.stringify(whisper))
    assert.equal(cue.text, 'Hello there')
    assert.equal(cue.words.length, 2)
    const chunks = { chunks: [{ text: ' one', timestamp: [0, 0.4] }, { text: ' two', timestamp: [0.5, 0.9] }] }
    assert.deepEqual(parseCaptions(JSON.stringify(chunks)).map(c => c.text), ['one two'])
    assert.throws(() => parseCaptions('{"name":"x"}', 'x.json'), /no list of words or segments/)
    assert.throws(() => parseCaptions('WEBVTT\n\nnothing timed here', 'x.vtt'), /no timed captions/)
})

test('captions become text clips placed from an origin', () => {
    const clips = captionClips([{ start: 1, end: 2.5, text: 'Hello\nworld' }], 10)
    assert.equal(clips.length, 1)
    assert.equal(clips[0].type, 'text')
    assert.equal(clips[0].start, 11)
    assert.equal(clips[0].duration, 1.5)
    assert.equal(clips[0].name, 'Hello')
    assert.equal(clips[0].y, 0.86)
    assert.ok(isCaptionFile('a.VTT') && isCaptionFile('b.srt') && !isCaptionFile('c.wav'))
})
