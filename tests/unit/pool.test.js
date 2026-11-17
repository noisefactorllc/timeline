import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

// The real ProgramRenderer loads the engine from the CDN and needs a DOM.
// The pool only needs its load/ready/reset surface, so a stub stands in.
const STUB = `export class ProgramRenderer {
    constructor() { this.status = 'idle'; this.dsl = null }
    get ready() { return this.status === 'ready' }
    async load(dsl) { await new Promise(r => setTimeout(r, 1)); this.dsl = dsl; this.status = 'ready'; return { success: true } }
    resetState() {}
    resize() {}
    async dispose() { this.status = 'disposed' }
}`
registerHooks({
    resolve(specifier, context, next) {
        if (specifier === './programRenderer.js' && context.parentURL?.endsWith('/js/render/pool.js')) {
            return { url: `data:text/javascript,${encodeURIComponent(STUB)}`, shortCircuit: true }
        }
        return next(specifier, context)
    },
})
const { RendererPool } = await import('../../js/render/pool.js')

async function idle(pool) {
    while ([...pool.entries.values()].some(e => e.job)) {
        await Promise.all([...pool.entries.values()].map(e => e.job).filter(Boolean))
    }
}

/** One preview frame: acquire each key, touch the ready ones, like SequenceRenderer. */
function frame(pool, keys) {
    pool.beginFrame()
    const ready = []
    for (const key of keys) {
        const entry = pool.acquire(key, `dsl ${key}`)
        if (entry && pool.isReady(entry)) {
            pool.touch(entry)
            ready.push(key)
        }
    }
    return ready
}

test('a full pool compiles two programs that come on screen in the same frame', async () => {
    const pool = new RendererPool({ capacity: 4, width: 16, height: 9 })
    // Fill the pool with programs that played earlier.
    for (const key of ['old1', 'old2', 'old3', 'old4']) {
        frame(pool, [key])
        await idle(pool)
        frame(pool, [key])
    }
    assert.equal(pool.entries.size, 4)

    // Two new programs at once, as when a cut lands on a clip with an overlay.
    let ready = []
    for (let i = 0; i < 8 && ready.length < 2; i++) {
        ready = frame(pool, ['incoming', 'overlay'])
        await idle(pool)
    }
    assert.deepEqual(ready.sort(), ['incoming', 'overlay'])
})

test('a full pool compiles three programs that come on screen in the same frame', async () => {
    const pool = new RendererPool({ capacity: 4, width: 16, height: 9 })
    for (const key of ['old1', 'old2', 'old3', 'old4']) {
        frame(pool, [key])
        await idle(pool)
        frame(pool, [key])
    }
    // Outgoing clip, incoming clip and the transition between them.
    let ready = []
    for (let i = 0; i < 8 && ready.length < 3; i++) {
        ready = frame(pool, ['outgoing', 'incoming', 'transition'])
        await idle(pool)
    }
    assert.deepEqual(ready.sort(), ['incoming', 'outgoing', 'transition'])
})

test('programs requested earlier outrank programs that played long ago', async () => {
    const pool = new RendererPool({ capacity: 3, width: 16, height: 9 })
    for (const key of ['old1', 'old2', 'old3']) {
        frame(pool, [key])
        await idle(pool)
        frame(pool, [key])
    }
    // A prefetch asks for an upcoming program; a later frame needs another new one first.
    pool.beginFrame()
    pool.acquire('upcoming', 'dsl upcoming', { priority: 2 })
    frame(pool, ['now'])
    assert.ok(pool.entries.has('upcoming'), 'the requested program was evicted before a program that played long ago')
    assert.ok(pool.entries.has('now'))
})

test('an exact frame gets a renderer past the capacity instead of losing a layer', async () => {
    const pool = new RendererPool({ capacity: 3, width: 16, height: 9 })
    const frameNumber = pool.beginFrame()
    // Every renderer is reserved by the frame being prepared.
    for (const key of ['a', 'b', 'c']) pool.acquire(key, `dsl ${key}`).reservedFrame = frameNumber
    assert.equal(pool.acquire('post', 'dsl post'), null, 'the preview goes without a layer when every renderer is busy')
    const post = pool.acquire('post', 'dsl post', { grow: true })
    assert.ok(post, 'the exact frame got no renderer for its fourth layer')
    assert.equal(pool.entries.size, 4)
    await pool.settle(post)
    assert.ok(pool.isReady(post))
    // A later frame recycles instead of growing again.
    pool.beginFrame()
    assert.ok(pool.acquire('next', 'dsl next', { grow: true }))
    assert.equal(pool.entries.size, 4)
})
