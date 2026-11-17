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

test('an empty or broken time fails with exit 1 and names the value, for --at, --from and --to', () => {
    for (const [command, option, value] of [
        ['snapshot', '--at', 'abc'],
        ['snapshot', '--at', ',2'],
        ['snapshot', '--at', '4,,5'],
        ['snapshot', '--at', '1:'],
        ['render', '--from', 'abc'],
        ['render', '--from', ''],
        ['render', '--to', ''],
        ['render', '--to', '1:'],
    ]) {
        const args = [CLI, command, '/no-such-timeline-project', option, value]
        const result = spawnSync(process.execPath, args, { encoding: 'utf8' })
        const call = `${command} ${option} "${value}"`
        assert.equal(result.status, 1, `${call}: ${result.stderr}`)
        assert.equal(result.stderr.trim(), `"${value}" is not a time; use seconds or minutes:seconds`, call)

        const json = spawnSync(process.execPath, [...args, '--json'], { encoding: 'utf8' })
        assert.equal(json.status, 1, `${call} --json: ${json.stderr}`)
        assert.equal(JSON.parse(json.stdout).error.message, `"${value}" is not a time; use seconds or minutes:seconds`, `${call} --json`)
    }
})

test('valid times still parse: the call goes on to read the project folder', () => {
    for (const args of [['snapshot', '--at', '4,12.5,1:04'], ['render', '--from', '0:10', '--to', '0:20']]) {
        const result = spawnSync(process.execPath, [CLI, args[0], '/no-such-timeline-project', ...args.slice(1)], { encoding: 'utf8' })
        assert.equal(result.status, 1, result.stderr)
        assert.match(result.stderr, /project\.json does not exist/, args.join(' '))
    }
})
