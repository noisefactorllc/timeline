/**
 * Captions and word timings from the files speech tools write: WebVTT,
 * SubRip (SRT), and JSON word or segment lists such as Whisper's. Each
 * becomes a list of cues, { start, end, text }, in seconds from the start
 * of the audio they were made from. Words without cues are grouped into
 * readable lines, breaking at pauses.
 */

import { createTextClip } from './project.js'

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/

function seconds(text) {
    const m = TIME.exec(text)
    if (!m) return null
    const [, h = '0', min, s, frac] = m
    return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(frac.padEnd(3, '0')) / 1000
}

function cleanText(text) {
    return text
        .replace(/<\d{1,2}:\d{2}[:.,\d]*>/g, '')
        .replace(/<\/?[a-z][^>]*>/gi, '')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .trim()
}

/** WebVTT inline timestamps (karaoke style) give each word its start. */
function vttWords(line, start, end) {
    const parts = line.split(/(<\d{1,2}:\d{2}[:.,\d]*>)/)
    if (parts.length < 2) return null
    const words = []
    let t = start
    for (const part of parts) {
        if (/^<[\d:.,]+>$/.test(part)) {
            t = seconds(part) ?? t
            continue
        }
        const text = cleanText(part)
        if (text) words.push({ start: t, text })
    }
    words.forEach((w, i) => { w.end = words[i + 1]?.start ?? end })
    return words
}

/** Cues from WebVTT or SRT text. */
function parseTimedText(text) {
    const cues = []
    const blocks = text.replace(/\r\n?/g, '\n').split(/\n{2,}/)
    for (const block of blocks) {
        const lines = block.split('\n').filter(l => l.trim())
        const timing = lines.findIndex(l => l.includes('-->'))
        if (timing < 0) continue
        const [a, b] = lines[timing].split('-->')
        const start = seconds(a)
        const end = seconds(b)
        if (start === null || end === null || end <= start) continue
        const body = lines.slice(timing + 1)
        const words = body.flatMap(l => vttWords(l, start, end) || [])
        const cue = { start, end, text: body.map(cleanText).filter(Boolean).join('\n') }
        if (words.length) cue.words = words
        if (cue.text) cues.push(cue)
    }
    return cues
}

/** A word or segment from the shapes speech tools use. */
function timed(item) {
    if (!item || typeof item !== 'object') return null
    const text = item.text ?? item.word ?? item.punctuated_word
    let start = item.start ?? item.start_time ?? item.startTime
    let end = item.end ?? item.end_time ?? item.endTime
    if (Array.isArray(item.timestamp)) [start, end] = item.timestamp
    if (typeof text !== 'string' || !Number.isFinite(start)) return null
    return { text: text.trim(), start, end: Number.isFinite(end) ? end : start }
}

/** Cues from JSON: a list of words or segments, or an object holding one. */
function parseJson(text) {
    const data = JSON.parse(text)
    const list = Array.isArray(data) ? data : data.segments || data.cues || data.chunks || data.words || null
    if (!Array.isArray(list)) throw new Error('it holds no list of words or segments with start and end times')
    const items = list.map(timed).filter(Boolean)
    if (!items.length) throw new Error('none of its entries has text with a start time')
    // A segment list (multi-word entries, or with its own word lists) is already cues.
    const segments = list.some(s => Array.isArray(s?.words)) || items.some(i => /\s/.test(i.text))
    if (segments) {
        return items.map((cue, i) => {
            const words = (list[i]?.words || []).map(timed).filter(Boolean)
            return words.length ? { ...cue, words } : cue
        })
    }
    return groupWords(items)
}

/**
 * Words grouped into caption lines: a new line after a pause of `maxGap`
 * seconds, at about `maxChars` characters, or after `maxDuration` seconds,
 * preferring to break after a sentence ends.
 */
export function groupWords(words, { maxChars = 42, maxGap = 0.6, maxDuration = 5 } = {}) {
    const cues = []
    let current = null
    for (const w of words) {
        const text = w.text.trim()
        if (!text) continue
        const breakHere = current && (
            w.start - current.end > maxGap ||
            current.text.length + 1 + text.length > maxChars ||
            w.end - current.start > maxDuration ||
            /[.!?]["')\]]?$/.test(current.text))
        if (!current || breakHere) {
            current = { start: w.start, end: w.end, text, words: [w] }
            cues.push(current)
        } else {
            current.text = /^[,.;:!?%)]/.test(text) ? current.text + text : `${current.text} ${text}`
            current.end = Math.max(current.end, w.end)
            current.words.push(w)
        }
    }
    return cues
}

/** Cues from a caption or word-timing file; throws with the reason when it has none. */
export function parseCaptions(text, filename = '') {
    const ext = (filename.match(/\.([^.]+)$/)?.[1] || '').toLowerCase()
    const trimmed = text.trimStart()
    let cues
    if (ext === 'json' || trimmed.startsWith('[') || trimmed.startsWith('{')) cues = parseJson(text)
    else cues = parseTimedText(text)
    cues = cues.filter(c => c.text && c.end > c.start).sort((a, b) => a.start - b.start)
    if (!cues.length) throw new Error('it has no timed captions')
    return cues
}

export function isCaptionFile(name = '') {
    return /\.(vtt|srt|json)$/i.test(name)
}

/** The look of a caption: small, near the bottom, on a dark band, popping in quickly. */
export const CAPTION_STYLE = {
    size: 0.05,
    weight: 600,
    y: 0.86,
    maxWidth: 0.8,
    background: '#000000a6',
    enter: { preset: 'fade', duration: 0.12, ease: 'power2.out' },
    exit: { preset: 'none', duration: 0.1, ease: 'power2.in' },
}

/** Text clips for cues, with cue time 0 at sequence time `origin`. */
export function captionClips(cues, origin = 0, style = {}) {
    return cues.map(cue => {
        const start = Math.max(0, origin + cue.start)
        const clip = createTextClip({
            name: cue.text.split('\n')[0].slice(0, 40),
            start,
            duration: Math.max(0.05, origin + cue.end - start),
            text: cue.text,
            ...CAPTION_STYLE,
            ...style,
        })
        return clip
    })
}
