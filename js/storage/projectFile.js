/**
 * Project files: a zip holding project.json and the bytes of every
 * imported audio file, so a project moves between browsers intact.
 * Audio that ships with the app travels as its URL, and files a project
 * reads from its folder travel inside the zip. Media stay binary throughout.
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate'
import { loadMedia, saveMedia } from './db.js'
import { uid, SCHEMA_VERSION } from '../model/project.js'

export const PROJECT_EXTENSION = 'timeline'

/** `source` is the folder the project reads media from, when it has one. */
export async function projectToFile(project, { source = null } = {}) {
    const files = { 'project.json': strToU8(JSON.stringify(project, null, 2)) }
    for (const media of Object.values(project.media || {})) {
        if (media.recipe || media.url) continue
        if (media.path) {
            if (source) files[`media/${media.id}`] = new Uint8Array(await source.readBytes(media.path))
            continue
        }
        const record = await loadMedia(media.id)
        if (record?.bytes) files[`media/${media.id}`] = new Uint8Array(record.bytes)
    }
    const zipped = zipSync(files, { level: 0 })
    const name = `${project.name.replace(/[^\p{L}\p{N}\- ]+/gu, '').trim() || 'project'}.${PROJECT_EXTENSION}`
    return new File([zipped], name, { type: 'application/zip' })
}

export async function projectFromFile(file) {
    const bytes = new Uint8Array(await file.arrayBuffer())
    let files
    try {
        files = unzipSync(bytes)
    } catch {
        throw new Error(`${file.name} is not a Timeline project file`)
    }
    if (!files['project.json']) throw new Error(`${file.name} has no project.json`)
    const project = JSON.parse(strFromU8(files['project.json']))
    if (project.schema !== SCHEMA_VERSION || !project.sequences) throw new Error(`${file.name} is not a Timeline project this version can open`)
    for (const media of Object.values(project.media || {})) {
        const data = files[`media/${media.id}`]
        if (data) {
            await saveMedia({ id: media.id, name: media.name, type: media.type || 'audio/*', bytes: data.slice().buffer })
            // A file from a project folder now lives in this browser's storage.
            delete media.path
        }
    }
    project.id = uid('prj')
    project.updatedAt = Date.now()
    return project
}
