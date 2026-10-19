/**
 * Fonts for text clips, from the Noise Factor font service. The catalog
 * lists each family and its files; a face loads the first time a text clip
 * asks for that family, weight and style, and is registered as
 * `TL <family>` so it never collides with the editor's own fonts.
 */

const FONT_HOST = 'https://fonts.noisefactor.io'
const CATALOG_URL = `${FONT_HOST}/bundle/fonts.json`

const WEIGHT_NAMES = {
    100: 'Thin', 200: 'ExtraLight', 300: 'Light', 400: 'Regular', 500: 'Medium',
    600: 'SemiBold', 700: 'Bold', 800: 'ExtraBold', 900: 'Black',
}

let catalog = null
let catalogPromise = null
const faces = new Map()
const listeners = new Set()

/** The font families on offer: [{ name, category, slug, files }], sorted by name. */
export function loadFontCatalog() {
    if (!catalogPromise) {
        catalogPromise = fetch(CATALOG_URL)
            .then(res => {
                if (!res.ok) throw new Error(`The font catalog answered ${res.status}`)
                return res.json()
            })
            .then(data => {
                catalog = (data.fonts || [])
                    .map(f => ({
                        name: f.name,
                        category: f.category,
                        slug: String(f.dir_name || '').replace(/^\d+-/, ''),
                        files: (f.files || []).map(x => x.filename).filter(name => name.endsWith('.woff2')),
                    }))
                    .filter(f => f.slug && f.files.length)
                    .sort((a, b) => a.name.localeCompare(b.name))
                return catalog
            })
            .catch(err => {
                catalogPromise = null
                throw err
            })
    }
    return catalogPromise
}

export function fontCatalog() {
    return catalog
}

export function cssFamily(name) {
    return `"TL ${name}", sans-serif`
}

/** Call `fn` whenever a face finishes loading, so text can redraw with it. */
export function onFontLoaded(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
}

/**
 * The file that draws `weight` and `italic` best: a variable font covering
 * the weight axis if the family has one, else the nearest static weight.
 */
export function pickFontFile(font, weight = 400, italic = false) {
    const files = font.files
    const variable = files.filter(f => /\[[^\]]*wght[^\]]*\]/.test(f))
    if (variable.length) {
        const file = variable.find(f => /Italic/i.test(f) === italic) || variable.find(f => !/Italic/i.test(f)) || variable[0]
        return { file, variable: true, weight, italic: italic && /Italic/i.test(file) }
    }
    const target = Math.round(Math.max(100, Math.min(900, weight)) / 100) * 100
    const byDistance = Object.keys(WEIGHT_NAMES).map(Number).sort((a, b) => Math.abs(a - target) - Math.abs(b - target) || b - a)
    for (const slant of italic ? [true, false] : [false]) {
        for (const w of byDistance) {
            const suffix = slant ? (w === 400 ? 'Italic' : `${WEIGHT_NAMES[w]}Italic`) : WEIGHT_NAMES[w]
            const matches = files.filter(f => f.endsWith(`-${suffix}.woff2`))
            // The shortest name is the main cut: Inter-Bold rather than InterDisplay-Bold.
            if (matches.length) return { file: matches.sort((a, b) => a.length - b.length)[0], variable: false, weight: w, italic: slant }
        }
    }
    return { file: files[0], variable: false, weight: target, italic: false }
}

function faceKey(name, weight, italic) {
    return `${name}|${weight}|${italic ? 'i' : 'n'}`
}

/**
 * Load the face for a family, weight and style. Resolves true when it is
 * ready to draw, false when the family is unknown or failed to load (text
 * then draws in a fallback face).
 */
export function loadFont(name, weight = 400, italic = false) {
    const key = faceKey(name, weight, italic)
    let entry = faces.get(key)
    if (entry) return entry.promise
    entry = { status: 'loading', promise: null }
    faces.set(key, entry)
    entry.promise = (async () => {
        try {
            const fonts = await loadFontCatalog()
            const font = fonts.find(f => f.name === name)
            if (!font) throw new Error(`The font service has no family named ${name}`)
            const pick = pickFontFile(font, weight, italic)
            const url = `${FONT_HOST}/fonts/${font.slug}/${encodeURIComponent(pick.file)}`
            const face = new FontFace(`TL ${name}`, `url("${url}") format("woff2")`, {
                weight: pick.variable ? '1 1000' : String(pick.weight),
                style: pick.italic ? 'italic' : 'normal',
            })
            await face.load()
            document.fonts.add(face)
            entry.status = 'ready'
            for (const fn of listeners) fn(name)
            return true
        } catch (err) {
            entry.status = 'failed'
            entry.error = err?.message || String(err)
            return false
        }
    })()
    return entry.promise
}

/** 'ready', 'loading' or 'failed'; starts loading a face not yet asked for. */
export function fontStatus(name, weight = 400, italic = false) {
    const entry = faces.get(faceKey(name, weight, italic))
    if (entry) return entry.status
    loadFont(name, weight, italic)
    return 'loading'
}

export function fontError(name, weight = 400, italic = false) {
    return faces.get(faceKey(name, weight, italic))?.error || null
}
