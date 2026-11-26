import { test, expect } from '@playwright/test'
import { spawnSync } from 'node:child_process'

// The e2e entrypoint maps changed paths to specs. `--list` proves the
// selection without launching a browser: a changed spec selects itself, a
// changed entrypoint selects this spec, and a changed path no spec maps to
// selects the whole suite. A list run carries no suite summary, so the
// strict reporter does not pass it; these tests read the listing itself.

const ENTRY = 'scripts/e2e-tests.mjs'
const TOTAL = /Total: \d+ tests in \d+ files/

function listSelection(changed) {
    const env = { ...process.env }
    if (changed === null) delete env.NM_CHANGED_FILES
    else env.NM_CHANGED_FILES = changed
    const run = spawnSync('node', [ENTRY, '--list'], { env, encoding: 'utf8' })
    expect(run.error, run.stderr).toBeUndefined()
    return run.stdout
}

test('a changed spec selects itself', () => {
    const out = listSelection('tests/e2e/audio.spec.js')
    expect(out).toContain('Total: 5 tests in 1 file')
})

test('the entrypoint selects this spec', () => {
    const out = listSelection(ENTRY)
    expect(out).toContain('entrypoint.spec.js')
    expect(out).not.toContain('audio.spec.js')
})

test('a changed path no spec maps to selects the whole suite', () => {
    const whole = listSelection(null).match(TOTAL)[0]
    const out = listSelection('js/app.js')
    expect(out).toContain('audio.spec.js')
    expect(out).toContain('smoke.spec.js')
    expect(out.match(TOTAL)[0]).toBe(whole)
})
