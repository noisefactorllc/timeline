import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildInfoFromMeta } from '../../js/ui/buildInfo.js'

test('deployment-meta date is Unix seconds and becomes the matching Date', () => {
    const info = buildInfoFromMeta({ git_hash: 'a13d338f0b7af852eafbd01d20dee2e5fbf0a138', date: 1792910878 })
    assert.ok(info.deployed instanceof Date)
    assert.equal(info.deployed.getTime(), 1792910878 * 1000)
    assert.equal(info.deployed.toISOString(), '2026-10-25T06:47:58.000Z')
})

test('build hash shows its first eight characters, as in the engine line', () => {
    const info = buildInfoFromMeta({ git_hash: ' a13d338f0b7af852eafbd01d20dee2e5fbf0a138\n', date: 1792910878 })
    assert.equal(info.hash, 'a13d338f')
})

test('missing date gives no deployed time', () => {
    const info = buildInfoFromMeta({ git_hash: 'a13d338f0b7af852eafbd01d20dee2e5fbf0a138' })
    assert.equal(info.hash, 'a13d338f')
    assert.equal(info.deployed, null)
})

test('missing or empty metadata gives no build info', () => {
    assert.equal(buildInfoFromMeta(null), null)
    assert.equal(buildInfoFromMeta({}), null)
    assert.equal(buildInfoFromMeta({ git_hash: '   ' }), null)
})
