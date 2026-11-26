/**
 * End-to-end test entrypoint (`npm test:e2e`).
 *
 * With NM_CHANGED_FILES set, one changed path per line, it runs only the
 * end-to-end specs that exercise those paths, per the focused-test rule: a
 * changed spec runs itself, a changed source path runs its mapped specs, and
 * an unmapped source path maps to no spec (the same convention as
 * scripts/unit-tests.mjs). With NM_CHANGED_FILES unset, or when no spec maps
 * to any changed path, it runs the whole suite. With NM_SHARD_INDEX and
 * NM_SHARD_COUNT set, it runs only this shard's slice of the selected specs
 * (a .nm-test-shards file at the repository root declares the count; without
 * that file the run stays unsharded, and a count that disagrees with the file
 * is an error).
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const CLI = 'node_modules/@playwright/test/cli.js'
const ALL = ['tests/e2e']

/** Changed source path -> the end-to-end specs that exercise it. */
const MAP = [
    // Shared boot helpers: every spec exercises them, so run the whole suite.
    ['tests/e2e/helpers.js', ALL],
    // The entrypoint itself: one short spec proves it still selects and runs.
    ['scripts/e2e-tests.mjs', ['tests/e2e/help.spec.js']],
]

const changed = (process.env.NM_CHANGED_FILES || '').split('\n').map(s => s.trim()).filter(Boolean)
const selected = new Set()
for (const path of changed) {
    if (/^tests\/e2e\/.+\.spec\.js$/.test(path)) selected.add(path)
    for (const [source, testFiles] of MAP) {
        if (path === source || path.startsWith(`${source}/`)) for (const f of testFiles) selected.add(f)
    }
}
let files = ALL
const extraArgs = process.argv.slice(2)
if (changed.length && selected.size) files = [...selected].sort()
else if (!changed.length && extraArgs.length) files = [] // the caller's own file filters select


const shardCount = Number(process.env.NM_SHARD_COUNT || '')
const shardIndex = process.env.NM_SHARD_INDEX
let shardFileCount = null
try {
    shardFileCount = Number(readFileSync('.nm-test-shards', 'utf8').trim())
} catch { /* no shard file: nothing may be omitted, so the run stays unsharded */ }
if (shardCount >= 2 && shardCount <= 8 && shardIndex !== undefined && shardFileCount === shardCount) {
    const index = Number(shardIndex)
    if (!Number.isInteger(index) || index < 0 || index >= shardCount) {
        throw new Error(`NM_SHARD_INDEX ${shardIndex} is outside the 0..${shardCount - 1} range`)
    }
    const unsharded = [...files]
    files = files.filter((_, i) => i % shardCount === index)
    if (!files.length && unsharded.length) {
        console.log('This shard runs no tests: every selected spec landed in the other shards.')
        process.exit(0)
    }
} else if (shardCount >= 2 && shardCount <= 8 && shardIndex !== undefined && shardFileCount !== null) {
    throw new Error(`NM_SHARD_COUNT ${shardCount} does not match .nm-test-shards (${shardFileCount})`)
}

const result = spawnSync('node', [CLI, 'test', ...files, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
