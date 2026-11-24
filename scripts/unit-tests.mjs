/**
 * Unit test entrypoint (`npm test`).
 *
 * With NM_CHANGED_FILES set, one changed path per line, it runs only the
 * unit tests that exercise those paths, per the focused-test rule; with it
 * unset, or when no test maps to a changed path, it runs the whole suite.
 */
import { spawnSync } from 'node:child_process'

const REPORTER = './scripts/test-reporter.mjs'
const ALL = ['tests/unit/**/*.test.js']

/** Changed source path -> the unit tests that exercise it. */
const MAP = [
    ['js/app.js', 'tests/unit/sequence-render.test.js'],
    ['js/render/pool.js', 'tests/unit/pool.test.js'],
    ['js/render/programRenderer.js', 'tests/unit/sequence-render.test.js'],
    ['js/render/programRenderer.js', 'tests/unit/thumbnails.test.js'],
    ['js/render/sequenceRenderer.js', 'tests/unit/sequence-render.test.js'],
    ['js/render/thumbnails.js', 'tests/unit/thumbnails.test.js'],
    ['js/audio/engine.js', 'tests/unit/engine-stop.test.js'],
    ['js/audio/startToken.js', 'tests/unit/start-token.test.js'],
]

const changed = (process.env.NM_CHANGED_FILES || '').split('\n').map(s => s.trim()).filter(Boolean)
const selected = new Set()
for (const path of changed) {
    if (/^tests\/unit\/.+\.test\.js$/.test(path)) selected.add(path)
    for (const [source, testFile] of MAP) {
        if (path === source || path.startsWith(`${source}/`)) selected.add(testFile)
    }
}
const files = changed.length ? [...selected] : ALL

const result = spawnSync('node', ['--test', `--test-reporter=${REPORTER}`, ...files], { stdio: 'inherit' })
process.exit(result.status ?? 1)
