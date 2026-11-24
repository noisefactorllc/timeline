import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'

// The real ProgramRenderer loads the engine from the CDN; the stub's
// render() spans an await, the way the engine renders a scene() program
// since release 1.5, so the thumbnail capture must read the settled frame.
const bundleURL = pathToFileURL(new URL('./stubs/engine-stub.js', import.meta.url).pathname).href
const dbURL = pathToFileURL(new URL('./stubs/db-stub.js', import.meta.url).pathname).href
registerHooks({
    resolve(specifier, context, next) {
        if (specifier === '../noisemaker/bundle.js' && context.parentURL?.endsWith('/js/render/programRenderer.js')) {
            return { url: bundleURL, shortCircuit: true }
        }
        if (specifier === '../storage/db.js' && context.parentURL?.endsWith('/js/render/thumbnails.js')) {
            return { url: dbURL, shortCircuit: true }
        }
        return next(specifier, context)
    },
})

// The renderer builds canvases at construct time and the capture reads one,
// so the stub document and capture globals must exist first. A captured
// bitmap carries the canvas frame's readiness at the moment it was taken.
globalThis.document = {
    createElement() {
        return { width: 0, height: 0, getContext: () => null }
    },
}
globalThis.createImageBitmap = async canvas => ({ present: canvas.present })
globalThis.requestAnimationFrame = resolve => setTimeout(resolve, 0)

const { Thumbnails } = await import('../../js/render/thumbnails.js')
const { created } = await import('./stubs/engine-stub.js')

class AudioState {
    setBands() {}
    registerDefaultChannels() {}
    getDefaultChannelState() {
        return { setBands() {} }
    }
}

test('a thumbnail captures the settled frame of an async render', async () => {
    const thumbs = new Thumbnails({ AudioState })
    const bitmap = await thumbs.request('search render\nosc().out(o0)', 0.5)
    const engine = created[created.length - 1]

    assert.ok(bitmap, 'the program rendered a thumbnail')
    assert.equal(bitmap.present, true, 'the capture read the settled frame, not the one before it')
    assert.equal(engine.phase, 0.5, 'the capture rendered the requested phase')
})
