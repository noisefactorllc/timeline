/**
 * Checks and still frames for tools that drive Timeline from outside: the
 * command-line `check` and `snapshot`, and the end-to-end suite. Nothing
 * here draws any interface.
 */

import { ProgramRenderer } from './render/programRenderer.js'
import { transitionDsl } from './render/sequenceRenderer.js'
import { getAudioBuffer } from './audio/media.js'
import { PREROLL_SECONDS } from './export/exporter.js'
import { formatTimecode } from './model/time.js'
import { isGraphic } from './model/project.js'
import { loadFont, fontError } from './render/fonts.js'

function orderedSequences(project) {
    return project.sequenceOrder.map(id => project.sequences[id]).filter(Boolean)
}

/**
 * Compile every program, transition and post chain once, load every media
 * file and font, and add the problems found when the project was read.
 * `ok` is false when anything cannot play as written.
 */
export async function checkProject({ project, problems = [], audio, graphics }) {
    const errors = problems.filter(p => p.level === 'error')
    const warnings = problems.filter(p => p.level !== 'error')

    const programs = new Map()
    const add = (dsl, where) => {
        if (!programs.has(dsl)) programs.set(dsl, [])
        programs.get(dsl).push(where)
    }
    for (const seq of orderedSequences(project)) {
        for (const track of seq.tracks) {
            for (const clip of track.clips) {
                if (clip.type === 'program') add(clip.dsl, `${seq.name} › ${track.name} › "${clip.name}" at ${formatTimecode(clip.start, seq.fps)}`)
            }
            for (const x of track.transitions) add(transitionDsl(x), `${seq.name} › ${track.name} › transition "${x.id}"`)
        }
        if (seq.post?.enabled) add(seq.post.dsl, `${seq.name} › post chain`)
    }
    const compiler = new ProgramRenderer({ width: 64, height: 36, audioState: audio.state })
    try {
        for (const [dsl, places] of programs) {
            const result = await compiler.load(dsl)
            if (!result.success) for (const where of places) errors.push({ level: 'error', where, message: result.error || 'does not compile' })
        }
    } finally {
        await compiler.dispose()
    }

    // Sound: every file an audio clip plays, and every audio file.
    const heard = new Set()
    for (const seq of orderedSequences(project)) for (const t of seq.audioTracks) for (const c of t.clips) heard.add(c.mediaId)
    for (const media of Object.values(project.media || {})) {
        if (media.kind !== 'audio' && !heard.has(media.id)) continue
        try {
            await getAudioBuffer(media)
        } catch (err) {
            errors.push({ level: 'error', where: `media "${media.id}"`, message: err?.message || 'could not be loaded' })
        }
    }

    // Pictures and words: every image and video loads, every font is on the font service.
    const seen = new Set()
    for (const seq of orderedSequences(project)) {
        for (const track of seq.tracks) {
            for (const clip of track.clips) {
                if (!isGraphic(clip) || !graphics) continue
                const where = `${seq.name} › ${track.name} › "${clip.name}" at ${formatTimecode(clip.start, seq.fps)}`
                if (clip.type === 'text') {
                    const key = `${clip.font}|${clip.weight}|${clip.italic}`
                    if (seen.has(key)) continue
                    seen.add(key)
                    if (!(await loadFont(clip.font, clip.weight, clip.italic))) {
                        warnings.push({ level: 'warning', where, message: `${fontError(clip.font, clip.weight, clip.italic) || `font ${clip.font} did not load`}; the text draws in a fallback face` })
                    }
                    continue
                }
                if (seen.has(clip.mediaId) || !project.media[clip.mediaId]) continue
                seen.add(clip.mediaId)
                const error = await graphics.prepare(clip, clip.offset || 0)
                if (error) errors.push({ level: 'error', where, message: error })
            }
        }
    }

    return {
        ok: errors.length === 0,
        errors,
        warnings,
        project: project.name,
        mainSequence: project.mainSequenceId,
        sequences: orderedSequences(project).map(seq => ({
            id: seq.id,
            name: seq.name,
            size: `${seq.width}x${seq.height}`,
            fps: seq.fps,
            duration: seq.duration,
            bpm: seq.bpm,
            clips: seq.tracks.reduce((n, t) => n + t.clips.length, 0),
            audioClips: seq.audioTracks.reduce((n, t) => n + t.clips.length, 0),
        })),
        programs: programs.size,
    }
}

/**
 * Render still frames of a sequence as PNG bytes. Each frame is rendered
 * the way export renders it: full detail, every program compiled, and
 * stateful programs run up to it from up to two seconds before.
 *
 * @param {object} o
 * @param {number[]} o.times - seconds
 * @param {string} [o.sequence] - id or name; the main sequence by default
 * @param {number} [o.scale] - fraction of the sequence's size (default 1)
 */
export async function snapshotFrames({ project, renderer, pool, audio, times, sequence, scale = 1 }) {
    const seq = Object.values(project.sequences).find(s => s.id === sequence || s.name === sequence)
        || (sequence ? null : project.sequences[project.mainSequenceId])
    if (!seq) throw new Error(`There is no sequence "${sequence}"`)
    const width = Math.max(2, Math.round(seq.width * scale / 2) * 2)
    const height = Math.max(2, Math.round(seq.height * scale / 2) * 2)
    await audio.mix(project, seq)

    const previous = { width: pool.width, height: pool.height }
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { alpha: false })
    const frames = []
    renderer.exporting = true
    try {
        pool.resizeAll(width, height)
        for (const time of times) {
            if (!Number.isFinite(time) || time < 0 || time > seq.duration) throw new Error(`${time} s is outside ${seq.name} (0 to ${seq.duration} s)`)
            pool.resetAll()
            const pre = Math.round(Math.min(time, PREROLL_SECONDS) * seq.fps)
            for (let i = pre; i > 0; i--) await renderer.renderFrameExact(seq, time - i / seq.fps, { seek: i === pre })
            const { canvas: frame } = await renderer.renderFrameExact(seq, time, { seek: pre === 0 })
            ctx.drawImage(frame, 0, 0, width, height)
            const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'))
            frames.push({ time, timecode: formatTimecode(time, seq.fps), bytes: new Uint8Array(await blob.arrayBuffer()) })
        }
    } finally {
        pool.resizeAll(previous.width, previous.height)
        pool.resetAll()
        renderer.exporting = false
    }
    return { sequence: seq.name, width, height, frames }
}
