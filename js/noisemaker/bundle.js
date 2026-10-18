/**
 * ESM loader for the Noisemaker shaders core.
 *
 * Imports the engine from the shaders CDN on the rolling `/1` major
 * channel: minified in production, unminified on localhost so stack traces
 * stay readable. Mirrors the loader used across the product line.
 */

export const CDN_BASE = 'https://shaders.noisedeck.app/1'

const isLocalDev = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.protocol === 'file:'
)

const bundlePath = isLocalDev
    ? `${CDN_BASE}/noisemaker-shaders-core.esm.js`
    : `${CDN_BASE}/noisemaker-shaders-core.esm.min.js`

const bundle = await import(bundlePath)

export const {
    CanvasRenderer,
    AudioState,
    compile,
    getAllEffects,
    extractEffectNamesFromDsl,
    extractEffectsFromDsl,
} = bundle

/** Engine release on the CDN channel, read from its deployment record. */
export async function engineVersion() {
    try {
        const res = await fetch(`${CDN_BASE}/deployment-meta.json`, { cache: 'no-cache' })
        const meta = await res.json()
        return meta.version || null
    } catch {
        return null
    }
}
