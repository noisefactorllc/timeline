import { test } from 'node:test'
import assert from 'node:assert/strict'
import { History } from '../../js/model/history.js'

test('history isolates nested project snapshots from later edits on both sides of undo', () => {
    const history = new History()
    const current = { tracks: [{ clips: [{ name: 'Before' }] }] }
    history.push(current, 'Rename')
    current.tracks[0].clips[0].name = 'After'
    const previous = history.undo(current)
    assert.equal(previous.tracks[0].clips[0].name, 'Before')
    current.tracks[0].clips[0].name = 'Later mutation'
    assert.equal(history.redo(previous).tracks[0].clips[0].name, 'After')
})

test('editing after undo discards the abandoned redo and retains the new label', () => {
    const history = new History()
    history.push({ value: 0 }, 'First edit')
    const restored = history.undo({ value: 1 })
    assert.equal(history.redoLabel, 'First edit')
    history.push(restored, 'Replacement edit')
    assert.equal(history.canRedo, false)
    assert.equal(history.redo({ value: 2 }), null)
    assert.equal(history.undoLabel, 'Replacement edit')
    assert.deepEqual(history.undo({ value: 2 }), { value: 0 })
})

test('history evicts its oldest snapshot and clears both undo and redo', () => {
    const history = new History({ limit: 2 })
    for (let value = 0; value < 3; value++) history.push({ value }, `Edit ${value}`)
    assert.deepEqual(history.undo({ value: 3 }), { value: 2 })
    assert.deepEqual(history.undo({ value: 2 }), { value: 1 })
    assert.equal(history.undo({ value: 1 }), null)
    assert.equal(history.canUndo, false)
    assert.deepEqual(history.redo({ value: 1 }), { value: 2 })
    history.clear()
    assert.equal(history.canUndo, false)
    assert.equal(history.canRedo, false)
    assert.equal(history.undoLabel, '')
    assert.equal(history.redoLabel, '')
    assert.equal(history.undo({ value: 2 }), null)
    assert.equal(history.redo({ value: 2 }), null)
})
