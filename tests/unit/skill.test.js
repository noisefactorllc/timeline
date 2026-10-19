import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { normalizeProject } from '../../js/model/normalize.js'

const skill = readFileSync(new URL('../../skills/timeline/SKILL.md', import.meta.url), 'utf8')
const blocks = [...skill.matchAll(/```json\n([\s\S]*?)```/g)].map(m => m[1])

test('the skill names itself and when to use it', () => {
    const front = skill.match(/^---\n([\s\S]*?)\n---/)?.[1] || ''
    assert.match(front, /^name: timeline$/m)
    assert.match(front, /^description: Use when /m)
    assert.ok(!/[—]/.test(skill), 'no em dashes')
})

test('the example project in the skill opens with no problems', () => {
    const { project, problems } = normalizeProject(JSON.parse(blocks[0]))
    assert.deepEqual(problems, [])
    const seq = project.sequences.main
    assert.deepEqual(seq.tracks.map(t => t.clips.map(c => c.type)), [['program', 'program'], ['text', 'image']])
    assert.equal(seq.tracks[0].transitions.length, 1)
})

test('the example effect definition is a portable effect with a pass per program', () => {
    const definition = JSON.parse(blocks[1])
    assert.ok(Array.isArray(definition.passes) && definition.passes.length)
    for (const pass of definition.passes) assert.equal(typeof pass.program, 'string')
    assert.equal(definition.globals.amount.uniform, 'amount')
})
