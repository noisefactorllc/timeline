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
