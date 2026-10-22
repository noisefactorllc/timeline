import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const CLI = fileURLToPath(new URL('../../cli/timeline.mjs', import.meta.url))

for (const [command, option, value] of [
    ['check', '--sequence', 'alternate'],
    ['check', '--at', '2'],
    ['snapshot', '--from', '1'],
    ['render', '--at', '2'],
]) {
    test(`${command} rejects an unused ${option} option`, () => {
        const args = [CLI, command, '/no-such-timeline-project', option, value]
        if (command === 'snapshot') args.push('--at', '2')
        const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
        assert.equal(result.status, 2, result.stderr)
        assert.match(result.stderr, new RegExp(option))
    })
}

test('with --json, a failure prints JSON', () => {
    const missing = spawnSync(process.execPath, [CLI, 'check', '/no-such-timeline-project', '--json'], { encoding: 'utf8' })
    assert.equal(missing.status, 1, missing.stderr)
    const failure = JSON.parse(missing.stdout)
    assert.equal(failure.ok, false)
    assert.match(failure.error.message, /project\.json does not exist/)

    const usage = spawnSync(process.execPath, [CLI, 'check', '/no-such-timeline-project', '--at', '2', '--json'], { encoding: 'utf8' })
    assert.equal(usage.status, 2, usage.stderr)
    assert.match(JSON.parse(usage.stdout).error.message, /--at/)
})
