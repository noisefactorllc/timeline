import test from 'node:test'
import assert from 'node:assert/strict'
import { AudioEngine } from '../../js/audio/engine.js'

class StubAudioState {}

test('stop stays working when the audio context rejects the source', () => {
    const engine = new AudioEngine({ AudioState: StubAudioState })
    engine.source = {
        stop() { throw new Error('already stopped') },
        disconnect() { throw new Error('InvalidStateError: context closed') },
    }
    engine.playing = true

    engine.stop()

    assert.equal(engine.playing, false)
    assert.equal(engine.source, null)
    assert.equal(engine._clock, null)
})
