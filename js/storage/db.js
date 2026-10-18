/**
 * IndexedDB persistence: projects as JSON documents and imported media as
 * binary records. Media bytes are stored as ArrayBuffers (Safari private
 * windows reject Blobs) and never as text. Small preferences live in
 * localStorage; nothing large ever does.
 */

const DB_NAME = 'timeline'
const DB_VERSION = 2

let dbPromise = null

function openDb() {
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB is not available'))
            return
        }
        const req = indexedDB.open(DB_NAME, DB_VERSION)
        req.onupgradeneeded = () => {
            const db = req.result
            if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' })
            if (!db.objectStoreNames.contains('media')) db.createObjectStore('media', { keyPath: 'id' })
            if (!db.objectStoreNames.contains('thumbs')) db.createObjectStore('thumbs', { keyPath: 'key' })
        }
        req.onsuccess = () => {
            const db = req.result
            db.onversionchange = () => {
                db.close()
                dbPromise = null
            }
            db.onclose = () => { dbPromise = null }
            resolve(db)
        }
        req.onerror = () => {
            dbPromise = null
            reject(req.error)
        }
        req.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'))
    })
    return dbPromise
}

async function run(store, mode, fn) {
    const db = await openDb()
    return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode, mode === 'readwrite' ? { durability: 'strict' } : undefined)
        const os = tx.objectStore(store)
        let result
        const req = fn(os)
        if (req) req.onsuccess = () => { result = req.result }
        tx.oncomplete = () => resolve(result)
        tx.onerror = () => reject(tx.error)
        tx.onabort = () => reject(tx.error || new Error('transaction aborted'))
    })
}

export function saveProject(project) {
    return run('projects', 'readwrite', os => os.put(structuredClone(project)))
}

export function loadProject(id) {
    return run('projects', 'readonly', os => os.get(id))
}

export async function listProjects() {
    const all = await run('projects', 'readonly', os => os.getAll())
    return (all || [])
        .map(p => ({ id: p.id, name: p.name, updatedAt: p.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt)
}

export function deleteProject(id) {
    return run('projects', 'readwrite', os => os.delete(id))
}

/** Store media bytes. `bytes` is an ArrayBuffer. */
export function saveMedia({ id, name, type, bytes }) {
    return run('media', 'readwrite', os => os.put({ id, name, type, bytes, storedAt: Date.now() }))
}

export function loadMedia(id) {
    return run('media', 'readonly', os => os.get(id))
}

// --- thumbnail cache --------------------------------------------------------

const THUMB_TTL_MS = 7 * 24 * 3600 * 1000

/** A cached thumbnail's image bytes, or null when missing or expired. */
export async function loadThumb(key) {
    const record = await run('thumbs', 'readonly', os => os.get(key))
    if (!record || Date.now() - record.storedAt > THUMB_TTL_MS) return null
    return record
}

export function saveThumb(key, bytes, type) {
    return run('thumbs', 'readwrite', os => os.put({ key, bytes, type, storedAt: Date.now() }))
}

// --- small preferences ----------------------------------------------------

const PREFS_KEY = 'timeline.prefs.v1'

export function readPrefs() {
    try {
        return JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') || {}
    } catch {
        return {}
    }
}

export function writePrefs(patch) {
    try {
        const next = { ...readPrefs(), ...patch }
        localStorage.setItem(PREFS_KEY, JSON.stringify(next))
        return next
    } catch {
        return null
    }
}
