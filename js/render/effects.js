/**
 * Custom effects a project brings: Noisemaker portable effects, a
 * definition.json and its GLSL (or WGSL) shaders, the form Noisedeck shares
 * effects in. They register with the engine once per page under the user
 * namespace, so a program reaches one with `search user` and then
 * `.effectName()`. A definition is data: no code from a project runs.
 *
 * A project keeps an effect inline, { definition, shaders }, or, in a
 * project folder, as files: { path: 'effects/name' } holding
 * definition.json, glsl/<program>.glsl and optionally wgsl/<program>.wgsl.
 */

import { unzipSync, strFromU8 } from 'fflate'
import { CanvasRenderer } from '../noisemaker/bundle.js'

// func -> the exact definition registered, so a repeat is skipped and a change is noticed.
const registered = new Map()

function programsOf(definition) {
    return [...new Set((definition.passes || []).map(p => p?.program).filter(p => typeof p === 'string' && p))]
}

/** An effect's definition and shaders, read from the project or its folder. */
export async function resolveEffect(entry, source) {
    if (entry.definition) return { definition: entry.definition, shaders: entry.shaders || {} }
    if (!source) throw new Error('its files are in a project folder, and no folder is open')
    const read = async path => new TextDecoder().decode(await source.readBytes(path))
    let definition
    try {
        definition = JSON.parse(await read(`${entry.path}/definition.json`))
    } catch (err) {
        throw new Error(`${entry.path}/definition.json ${/JSON/.test(err?.message) ? 'is not valid JSON' : 'could not be read'}`)
    }
    const shaders = {}
    for (const program of programsOf(definition)) {
        shaders[program] = {}
        for (const language of ['glsl', 'wgsl']) {
            try {
                shaders[program][language] = await read(`${entry.path}/${language}/${program}.${language}`)
            } catch { /* this language is optional; registration says when one is missing */ }
        }
    }
    return { definition, shaders }
}

/**
 * Register every effect in a project with the engine. Returns problems in
 * the project-problem form ({ level, where, message }).
 */
export async function registerProjectEffects(project, source) {
    const problems = []
    for (const [func, entry] of Object.entries(project.effects || {})) {
        const where = `effect "${func}"`
        try {
            const { definition, shaders } = await resolveEffect(entry, source)
            const raw = { ...definition, func, namespace: 'user', shaders }
            const signature = JSON.stringify(raw)
            if (registered.get(func) === signature) continue
            if (registered.has(func)) {
                problems.push({ level: 'warning', where, message: 'changed since this page registered it; reload the page to use the new version' })
                continue
            }
            const receiver = Object.create(CanvasRenderer.prototype)
            receiver._loadedEffects = new Map()
            await receiver.registerPortableEffect(raw)
            registered.set(func, signature)
        } catch (err) {
            problems.push({ level: 'error', where, message: String(err?.message || err).replace(/^Portable effect: /, '') })
        }
    }
    return problems
}

/**
 * The effect in a Noisedeck effect zip: its func name, definition and
 * shaders. A zip with only a definition.js runs code of its own, which
 * Timeline does not do.
 */
export function readEffectZip(bytes, filename = 'effect.zip') {
    let files
    try {
        files = unzipSync(new Uint8Array(bytes))
    } catch {
        throw new Error(`${filename} is not a zip file`)
    }
    const names = Object.keys(files).filter(n => !n.endsWith('/') && !n.split('/').some(part => part.startsWith('__MACOSX') || part.startsWith('.')))
    const defPath = names.find(n => n.split('/').pop() === 'definition.json')
    if (!defPath) {
        if (names.some(n => n.split('/').pop() === 'definition.js')) {
            throw new Error(`${filename} holds a definition.js, an effect that runs its own code. Timeline takes portable effects (a definition.json with its shaders), the form Noisedeck shares effects in`)
        }
        throw new Error(`${filename} has no definition.json`)
    }
    const base = defPath.slice(0, -'definition.json'.length)
    let definition
    try {
        definition = JSON.parse(strFromU8(files[defPath]))
    } catch {
        throw new Error(`${filename}: definition.json is not valid JSON`)
    }
    const shaders = {}
    for (const name of names) {
        if (!name.startsWith(base)) continue
        const m = /^(glsl|wgsl)\/(.+)\.(glsl|wgsl)$/.exec(name.slice(base.length))
        if (!m || m[1] !== m[3]) continue
        if (!shaders[m[2]]) shaders[m[2]] = {}
        shaders[m[2]][m[1]] = strFromU8(files[name])
    }
    const fallback = filename.replace(/\.zip$/i, '').replace(/[^A-Za-z0-9_]/g, '') || 'effect'
    let func = definition.func || definition.name || fallback
    func = String(func).replace(/[^A-Za-z0-9_]/g, '')
    if (!/^[A-Za-z_]/.test(func)) func = `fx${func}`
    return { func, definition, shaders }
}

/** A copy of a project with every effect inline, for a project file that travels on its own. */
export async function inlineEffects(project, source) {
    if (!Object.values(project.effects || {}).some(e => e.path)) return project
    const copy = structuredClone(project)
    for (const [func, entry] of Object.entries(copy.effects)) {
        if (!entry.path) continue
        try {
            copy.effects[func] = await resolveEffect(entry, source)
        } catch { /* left as a path; the project reports it when opened */ }
    }
    return copy
}

/** Whether a zip holds an effect rather than a project. */
export function zipHoldsEffect(bytes) {
    try {
        const names = Object.keys(unzipSync(new Uint8Array(bytes), { filter: f => /(^|\/)(definition\.json|definition\.js|project\.json)$/.test(f.name) }))
        return !names.some(n => n === 'project.json') && names.length > 0
    } catch {
        return false
    }
}
