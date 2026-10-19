/**
 * Easing curves by the names motion designers and GSAP use: `power2.out`,
 * `expo.inOut`, `back.out`, `none`. A name without `.in`, `.out` or
 * `.inOut` eases out. Unknown names fall back to `power1.out`.
 */

const OUT = fn => t => 1 - fn(1 - t)
const IN_OUT = fn => t => (t < 0.5 ? fn(t * 2) / 2 : 1 - fn((1 - t) * 2) / 2)

const BACK = 1.70158

const CURVES = {
    none: t => t,
    linear: t => t,
    power0: t => t,
    power1: t => t * t,
    quad: t => t * t,
    power2: t => t * t * t,
    cubic: t => t * t * t,
    power3: t => t ** 4,
    quart: t => t ** 4,
    power4: t => t ** 5,
    quint: t => t ** 5,
    sine: t => 1 - Math.cos((t * Math.PI) / 2),
    expo: t => (t <= 0 ? 0 : 2 ** (10 * (t - 1))),
    circ: t => 1 - Math.sqrt(1 - t * t),
    back: t => t * t * ((BACK + 1) * t - BACK),
}

export const EASE_NAMES = ['none', 'power1', 'power2', 'power3', 'power4', 'sine', 'expo', 'circ', 'back']
export const EASE_DIRECTIONS = ['in', 'out', 'inOut']

const cache = new Map()

/** The easing function for a name such as `power3.out`; maps 0..1 to 0..1. */
export function ease(name = 'power1.out') {
    if (cache.has(name)) return cache.get(name)
    const [base, direction = 'out'] = String(name).split('.')
    const curve = CURVES[base] || CURVES.power1
    const linear = base === 'none' || base === 'linear' || base === 'power0'
    const fn = linear ? CURVES.none : direction === 'in' ? curve : direction === 'inOut' ? IN_OUT(curve) : OUT(curve)
    const clamped = t => fn(Math.max(0, Math.min(1, t)))
    cache.set(name, clamped)
    return clamped
}

export function isEaseName(name) {
    if (typeof name !== 'string') return false
    const [base, direction = 'out', extra] = name.split('.')
    return !extra && base in CURVES && EASE_DIRECTIONS.includes(direction)
}
