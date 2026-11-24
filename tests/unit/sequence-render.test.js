import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

// The real ProgramRenderer loads the engine from the CDN; the stub's
// render() spans an await, the way the engine renders a scene() program
// since release 1.5. Every canvas in this file is a plain object with a
// 2d context stub, so no DOM and no WebGL are needed.
const STUB = pathToFileURL(new URL('./stubs/engine-stub.js', import.meta.url).pathname).href
registerHooks({
    resolve(specifier, context, next) {
        if (specifier === '../noisemaker/bundle.js' && context.parentURL?.endsWith('/js/render/programRenderer.js')) {
            return { url: STUB, shortCircuit: true }
        }
        return next(specifier, context)
    },
})

// ProgramRenderer and the sequence renderer build canvases at construct
// time, so the stub document must exist before they are imported.
const draws = []
function fake2d(canvas) {
    return {
        globalAlpha: 1,
        globalCompositeOperation: 'source-over',
        fillStyle: '',
        fillRect() {},
        drawImage(src) {
            draws.push({ src, settled: typeof src?.present === 'boolean' ? src.present : undefined })
        },
        save() {},
        restore() {},
        translate() {},
        rotate() {},
        scale() {},
    }
}
globalThis.document = {
    createElement() {
        return {
            width: 0,
            height: 0,
            getContext(kind) {
                return kind === '2d' ? fake2d(this) : null
            },
        }
    },
}

const { ProgramRenderer } = await import('../../js/render/programRenderer.js')
const { SequenceRenderer, presentPreviewFrame } = await import('../../js/render/sequenceRenderer.js')
const { RendererPool } = await import('../../js/render/pool.js')
const { created } = await import('./stubs/engine-stub.js')

function sequence() {
    return {
        name: 'main',
        fps: 30,
        width: 320,
        height: 180,
        duration: 1,
        tracks: [{
            hidden: false,
            transitions: [],
            clips: [{ id: 'p1', type: 'program', dsl: 'osc().out(o0)', start: 0, duration: 1, offset: 0, loop: 1 }],
        }],
    }
}

test('renderAt returns the engine render promise, present only after it settles', async () => {
    const before = created.length
    const pr = new ProgramRenderer({ width: 64, height: 36 })
    assert.equal(pr.renderAt(0), null, 'nothing compiled, nothing renders')

    const loaded = await pr.load('osc().out(o0)')
    assert.equal(loaded.success, true)
    const engine = created[created.length - 1]
    assert.equal(created.length, before + 1)

    const done = pr.renderAt(0.25)
    assert.equal(typeof done?.then, 'function', 'renderAt hands back the engine render promise')
    assert.equal(engine.canvas.present, false, 'the frame is not on the canvas yet')
    await done
    assert.equal(engine.canvas.present, true, 'awaiting the promise lands on the rendered frame')
})

test('an exact frame composites a program canvas only after its render settles', async () => {
    draws.length = 0
    const pool = new RendererPool({ capacity: 4, width: 320, height: 180 })
    const seq = sequence()
    const seqRenderer = new SequenceRenderer({
        pool,
        audio: { feed() {} },
        getProject: () => ({ sequences: {} }),
        graphics: null,
    })

    const { canvas, missing } = await seqRenderer.renderFrameExact(seq, 0.5)
    assert.equal(missing, 0)
    assert.ok(canvas)

    const engine = created[created.length - 1]
    assert.equal(engine.phase, 0.5, 'the program rendered at the exact phase')
    const programDraws = draws.filter(d => typeof d.settled === 'boolean')
    assert.ok(programDraws.length > 0, 'the composite drew the program canvas')
    assert.equal(engine.canvas.present, true)
    for (const d of programDraws) {
        assert.equal(d.settled, true, 'every composite read of a program canvas saw the settled frame')
    }
})

test('the preview tick draws a settled scene frame and marks a dropped frame dirty', async () => {
    // The request settles after the frame becomes presentable, the way an
    // engine render of a scene() program does.
    let present = null
    const canvas = { present: false }
    const request = new Promise(resolve => {
        present = () => {
            canvas.present = true
            resolve({ canvas, missing: 0 })
        }
    })
    const calls = []
    const presented = presentPreviewFrame(request, {
        draw: c => calls.push(['draw', c.present]),
        onDrawn: () => calls.push(['drawn']),
        setCompiling: compiling => calls.push(['compiling', compiling]),
        onDropped: () => calls.push(['dropped']),
    })
    assert.equal(calls.length, 0, 'nothing draws before the render settles')
    present()
    await presented
    assert.deepEqual(calls, [['draw', true], ['drawn'], ['compiling', false]])

    const droppedCalls = []
    await presentPreviewFrame(Promise.resolve(null), {
        draw: () => droppedCalls.push('draw'),
        onDrawn: () => droppedCalls.push('drawn'),
        setCompiling: () => droppedCalls.push('compiling'),
        onDropped: () => droppedCalls.push('dropped'),
    })
    assert.deepEqual(droppedCalls, ['dropped'], 'a dropped frame redraws on the next tick and draws nothing')
})

test('preview drops a frame while another preview frame is in flight', async () => {
    draws.length = 0
    const pool = new RendererPool({ capacity: 4, width: 320, height: 180 })
    const seq = sequence()
    const seqRenderer = new SequenceRenderer({
        pool,
        audio: { feed() {} },
        getProject: () => ({ sequences: {} }),
        graphics: null,
    })

    // Compile the program first, the way a settled preview frame has.
    await seqRenderer.renderFrame(seq, 0)
    assert.equal(await pool.settle(pool.entries.get('root/p1')), true)

    const first = seqRenderer.renderFrame(seq, 0.1)
    assert.equal(await seqRenderer.renderFrame(seq, 0.4), null, 'a frame in flight drops the second preview frame')
    const result = await first
    assert.equal(result.missing, 0)

    // Once the frame settles, the next one renders again.
    const next = await seqRenderer.renderFrame(seq, 0.7)
    assert.equal(next.missing, 0)
})
