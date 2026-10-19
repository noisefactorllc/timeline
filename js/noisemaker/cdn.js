/**
 * Where the Noisemaker engine loads from: the shaders CDN on the rolling
 * `/1` major channel, minified in production and unminified on localhost
 * so stack traces stay readable.
 */

export const CDN_BASE = 'https://shaders.noisedeck.app/1'

const isLocalDev = typeof window !== 'undefined' && (
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    window.location.protocol === 'file:'
)

export const ENGINE_URL = isLocalDev
    ? `${CDN_BASE}/noisemaker-shaders-core.esm.js`
    : `${CDN_BASE}/noisemaker-shaders-core.esm.min.js`
