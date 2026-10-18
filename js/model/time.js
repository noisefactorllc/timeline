/**
 * Time math for sequences: frames, timecode and the beat grid.
 *
 * Times are seconds (floats). Every value the renderer or exporter uses is
 * snapped to the sequence frame grid with `n / fps`, never `n * (1 / fps)`,
 * so a frame boundary lands exactly where the frame count says it does.
 */

const EPS = 1e-6

/** Index of the frame showing at time `t`. */
export function frameAt(t, fps) {
    return Math.floor(t * fps + EPS)
}

/** Start time of frame `n`. */
export function frameTime(n, fps) {
    return n / fps
}

/** Snap `t` down to the start of the frame showing at that time. */
export function snapToFrame(t, fps) {
    return frameTime(frameAt(t, fps), fps)
}

/** Frames needed to cover `seconds`, keeping a genuinely partial last frame. */
export function frameCount(seconds, fps) {
    const exact = seconds * fps
    const rounded = Math.round(exact)
    if (Math.abs(exact - rounded) < 1e-6) return Math.max(0, rounded)
    return Math.max(0, Math.ceil(exact))
}

function pad(n, width = 2) {
    return String(n).padStart(width, '0')
}

/** HH:MM:SS:FF at the sequence rate. Negative times format with a minus sign. */
export function formatTimecode(t, fps) {
    const sign = t < -EPS ? '-' : ''
    const frames = frameAt(Math.abs(t), fps)
    const rate = Math.round(fps)
    const ff = frames % rate
    const totalSeconds = Math.floor(frames / rate)
    const ss = totalSeconds % 60
    const mm = Math.floor(totalSeconds / 60) % 60
    const hh = Math.floor(totalSeconds / 3600)
    return `${sign}${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`
}

/** Short ruler label: m:ss, or m:ss.f when the step is under a second. */
export function formatRulerLabel(t, step) {
    const m = Math.floor(t / 60)
    const s = t - m * 60
    if (step < 1) return `${m}:${pad(Math.floor(s))}.${Math.round((s % 1) * 10) % 10}`
    return `${m}:${pad(Math.round(s) % 60)}`
}

/**
 * Parse a typed time. Accepts timecode (HH:MM:SS:FF, MM:SS:FF), m:ss,
 * plain seconds ("12.5" or "12.5s") and frames ("90f").
 * Returns seconds, or null when the text is not a time.
 */
export function parseTime(text, fps) {
    const s = String(text ?? '').trim()
    if (!s) return null
    let m = /^(-?\d+(?:\.\d+)?)\s*s?$/i.exec(s)
    if (m) return Number(m[1])
    m = /^(-?\d+)\s*f$/i.exec(s)
    if (m) return Number(m[1]) / fps
    const parts = s.split(':')
    if (parts.length < 2 || parts.length > 4 || parts.some(p => !/^\d+(\.\d+)?$/.test(p))) return null
    const nums = parts.map(Number)
    if (nums.length === 2) return nums[0] * 60 + nums[1]
    if (nums.length === 3) return nums[0] * 60 + nums[1] + nums[2] / fps
    return nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / fps
}

/** Seconds per beat at a tempo. */
export function beatSeconds(bpm) {
    return 60 / bpm
}

/** Seconds per bar at a tempo and meter. */
export function barSeconds(bpm, beatsPerBar = 4) {
    return beatSeconds(bpm) * beatsPerBar
}

/**
 * Engine phase (0..1) for a clip-local time and loop length, robust at the
 * loop seam: a time a hair either side of a whole loop maps to 0.
 */
export function loopPhase(localTime, loop) {
    if (!(loop > 0)) return 0
    let x = (localTime / loop) % 1
    if (x < 0) x += 1
    if (x < 1e-9 || 1 - x < 1e-9) return 0
    return x
}

/** Clamp to [lo, hi]. */
export function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v
}
