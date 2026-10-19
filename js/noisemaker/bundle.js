/**
 * ESM loader for the Noisemaker shaders core (see cdn.js for where it
 * comes from). Mirrors the loader used across the product line.
 */

import { CDN_BASE, ENGINE_URL } from './cdn.js'

export { CDN_BASE }

const bundle = await import(ENGINE_URL)

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
