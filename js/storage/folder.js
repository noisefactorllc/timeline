/**
 * Projects that live outside this browser's storage, as a folder: a
 * project.json and the media files it names by relative path.
 *
 * FolderSource reads and writes a folder on the user's disk through the
 * File System Access API, and notices when another program (an editor, an
 * agent) changes it. UrlSource reads a folder from a path on this site; the
 * command-line tools answer those requests from disk. Either way the files
 * are read in the browser and nothing is uploaded.
 */

import { normalizeProject, safeMediaPath } from '../model/normalize.js'
import { uid } from '../model/project.js'
import { fetchBytes } from '../fetchBytes.js'

const PROJECT_FILE = 'project.json'
const POLL_MS = 1000
const POLL_HIDDEN_MS = 4000

function rev(file) {
    return `${file.lastModified}:${file.size}`
}

function parseProject(text, name) {
    let raw
    try {
        raw = JSON.parse(text)
    } catch (err) {
        throw new Error(`project.json is not valid JSON: ${err.message}`)
    }
    return normalizeProject(raw, { name })
}

/** Paths of the media files a project reads from its folder. */
function mediaPaths(project) {
    return [...new Set(Object.values(project.media || {}).map(m => m.path).filter(Boolean))]
}

export class FolderSource {
    constructor(dir) {
        this.kind = 'folder'
        this.dir = dir
        this.name = dir.name
        this.token = uid('src')
        this.writable = true
        // The last version of each file this page read or wrote.
        this.revs = new Map()
        this._timer = 0
    }

    async _handle(path, { create = false } = {}) {
        const parts = path.split('/')
        let dir = this.dir
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create })
        return dir.getFileHandle(parts.at(-1), { create })
    }

    async _file(path) {
        try {
            return await (await this._handle(path)).getFile()
        } catch (err) {
            if (err?.name === 'NotFoundError' || err?.name === 'TypeMismatchError') return null
            throw err
        }
    }

    revOf(path) {
        return this.revs.get(path) || ''
    }

    async hasProject() {
        return !!(await this._file(PROJECT_FILE))
    }

    async load() {
        const file = await this._file(PROJECT_FILE)
        if (!file) throw new Error(`${this.name} has no project.json`)
        this.revs.set(PROJECT_FILE, rev(file))
        const result = parseProject(await file.text(), this.name)
        for (const path of mediaPaths(result.project)) {
            const media = await this._file(path)
            if (media) this.revs.set(path, rev(media))
        }
        return result
    }

    async readBytes(path, onProgress) {
        const safe = safeMediaPath(path)
        const file = safe && await this._file(safe)
        if (!file) throw new Error(`${path} is missing from ${this.name}`)
        this.revs.set(safe, rev(file))
        const bytes = await file.arrayBuffer()
        onProgress?.(1, bytes.byteLength, bytes.byteLength)
        return bytes
    }

    /** A file in the folder as a Blob, read lazily: a long video is not loaded into memory. */
    async readBlob(path) {
        const safe = safeMediaPath(path)
        const file = safe && await this._file(safe)
        if (!file) throw new Error(`${path} is missing from ${this.name}`)
        this.revs.set(safe, rev(file))
        return file
    }

    /**
     * Write the project back, unless the file changed on disk since this
     * page last read it; then the watcher reloads it and nothing is lost,
     * because the reload keeps this page's version in the undo history.
     */
    async save(project) {
        const current = await this._file(PROJECT_FILE)
        if (current && rev(current) !== this.revOf(PROJECT_FILE)) return false
        const handle = await this._handle(PROJECT_FILE, { create: true })
        const writable = await handle.createWritable()
        await writable.write(`${JSON.stringify(project, null, 2)}\n`)
        await writable.close()
        this.revs.set(PROJECT_FILE, rev(await handle.getFile()))
        return true
    }

    /** Write a text file at a path in the folder, making its directories. */
    async writeText(path, text) {
        const safe = safeMediaPath(path)
        if (!safe) throw new Error(`${path} is not a path inside the project folder`)
        const handle = await this._handle(safe, { create: true })
        const writable = await handle.createWritable()
        await writable.write(text)
        await writable.close()
        this.revs.set(safe, rev(await handle.getFile()))
    }

    /** Copy an imported file into the folder's media/ directory; returns its path. */
    async importFile(file) {
        const base = file.name.replace(/[^\p{L}\p{N}._ -]+/gu, '_').replace(/^\.+/, '') || 'media'
        const dot = base.lastIndexOf('.')
        const [stem, ext] = dot > 0 ? [base.slice(0, dot), base.slice(dot)] : [base, '']
        let path = `media/${base}`
        for (let n = 2; await this._file(path); n++) path = `media/${stem}-${n}${ext}`
        const handle = await this._handle(path, { create: true })
        const writable = await handle.createWritable()
        await writable.write(file)
        await writable.close()
        this.revs.set(path, rev(await handle.getFile()))
        return path
    }

    /**
     * Watch the folder. `onProject(result)` runs when project.json changes on
     * disk, with the newly read project; `onMedia(paths)` when media files
     * the project uses change. Returns a function that stops watching.
     */
    watch({ project, onProject, onMedia, onError }) {
        this.stop()
        let watched = mediaPaths(project())
        let stopped = false
        const tick = async () => {
            if (stopped) return
            try {
                const file = await this._file(PROJECT_FILE)
                if (file && rev(file) !== this.revOf(PROJECT_FILE)) {
                    this.revs.set(PROJECT_FILE, rev(file))
                    let result = null
                    try {
                        result = parseProject(await file.text(), this.name)
                    } catch (err) {
                        onError?.(err)
                    }
                    if (result) await onProject(result)
                }
                watched = mediaPaths(project())
                const changed = []
                for (const path of watched) {
                    const media = await this._file(path)
                    const next = media ? rev(media) : ''
                    if (next !== this.revOf(path)) {
                        this.revs.set(path, next)
                        changed.push(path)
                    }
                }
                if (changed.length) await onMedia(changed)
            } catch (err) {
                onError?.(err)
            }
            if (!stopped) this._timer = setTimeout(tick, document.hidden ? POLL_HIDDEN_MS : POLL_MS)
        }
        const onVisible = () => {
            if (document.hidden || stopped) return
            clearTimeout(this._timer)
            tick()
        }
        document.addEventListener('visibilitychange', onVisible)
        this._timer = setTimeout(tick, POLL_MS)
        this.stop = () => {
            stopped = true
            clearTimeout(this._timer)
            document.removeEventListener('visibilitychange', onVisible)
            this.stop = () => {}
        }
        return this.stop
    }

    stop() {}
}

export class UrlSource {
    /** `base` is a folder path on this site, such as `local-project/`; `name` names the project when it has none. */
    constructor(base, { name = null } = {}) {
        const url = new URL(base.endsWith('/') ? base : `${base}/`, document.baseURI)
        if (url.origin !== location.origin) throw new Error('A project path must be on this site')
        this.kind = 'url'
        this.base = url
        this.name = name || decodeURIComponent(url.pathname.split('/').filter(Boolean).pop() || 'project')
        this.token = uid('src')
        this.writable = false
        this.revs = new Map()
    }

    revOf() {
        return ''
    }

    async load() {
        const res = await fetch(new URL(PROJECT_FILE, this.base), { cache: 'no-store' })
        if (!res.ok) throw new Error(`${this.name}/project.json answered ${res.status}`)
        return parseProject(await res.text(), this.name)
    }

    readBytes(path, onProgress) {
        const safe = safeMediaPath(path)
        if (!safe) return Promise.reject(new Error(`${path} is not a path inside the project`))
        return fetchBytes(new URL(safe.split('/').map(encodeURIComponent).join('/'), this.base), onProgress, { cache: 'no-store' })
    }

    async readBlob(path) {
        const bytes = await this.readBytes(path)
        return new Blob([bytes])
    }

    async save() {
        return true
    }

    watch() {
        return () => {}
    }

    stop() {}
}
