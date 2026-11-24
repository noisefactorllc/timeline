import test from 'node:test'
import assert from 'node:assert/strict'
import { StartGate } from '../../js/audio/startToken.js'

test('a pause while playback is starting aborts that start', () => {
    const gate = new StartGate()
    const token = gate.begin()

    // The user pauses while the start is still awaiting its mix.
    gate.invalidate()

    assert.equal(gate.current(token), false)
    assert.equal(gate.current(gate.begin()), true)
})

test('an unpause leaves the running start current', () => {
    const gate = new StartGate()
    const token = gate.begin()

    assert.equal(gate.current(token), true)
})
