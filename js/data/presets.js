/**
 * Transition and post-chain presets. Every one is plain DSL the user can
 * open and edit.
 *
 * A transition program reads the outgoing clip with its first `media()`
 * and the incoming clip with its second. Its clock runs from 0 to 1 across
 * the transition, so `osc(type: oscKind.saw)` is the transition's progress
 * and `osc(type: oscKind.sine, speed: 0.5)` is the same progress eased in
 * and out. A post chain reads the composited sequence with `media()`; its
 * clock loops over the post chain's loop length.
 */

const EASE = 'osc(type: oscKind.sine, speed: 0.5)'

function mixer(body) {
    return `search synth, mixer, filter

// outgoing clip
media().write(o0)
// incoming clip
media().write(o1)

read(o0)
${body}
  .write(o2)
render(o2)`
}

export const TRANSITIONS = [
    {
        id: 'dissolve',
        name: 'Cross dissolve',
        dsl: mixer(`  .blendMode(tex: read(o1), mode: mix, mix: ${EASE})`),
    },
    {
        id: 'additive',
        name: 'Additive dissolve',
        dsl: mixer(`  .blendMode(tex: read(o1), mode: add, mix: ${EASE})`),
    },
    {
        id: 'flash',
        name: 'Flash',
        dsl: mixer(`  .blendMode(tex: read(o1), mode: mix, mix: osc(type: oscKind.saw))
  .adjust(brightness: osc(type: oscKind.sine, min: 0.1, max: 0.6))`),
    },
    {
        id: 'wipe',
        name: 'Wipe',
        dsl: mixer(`  .split(tex: read(o1), position: osc(type: oscKind.saw, min: 1, max: 0), rotation: 90, softness: 0.08)`),
    },
    {
        id: 'iris',
        name: 'Iris',
        dsl: mixer(`  .shapeMask(tex: read(o1), shape: circle, invert: sourceB, radius: ${EASE}, edgeSmooth: 0.04)`),
    },
    {
        id: 'hexagons',
        name: 'Hexagons',
        dsl: mixer(`  .patternMix(tex: read(o1), type: hexagons, scale: 6, smoothness: 0.04, thickness: osc(type: oscKind.saw))`),
    },
    {
        id: 'luma',
        name: 'Luma key',
        dsl: mixer(`  .thresholdMix(tex: read(o1), mapSource: sourceB, range: 0.12, threshold: osc(type: oscKind.sawInv))`),
    },
    {
        id: 'glitch',
        name: 'Glitch',
        dsl: mixer(`  .blendMode(tex: read(o1), mode: mix, mix: osc(type: oscKind.square, speed: 1, offset: 0))
  .corrupt(intensity: osc(type: oscKind.sine, min: 0, max: 0.9), channelShift: 40, speed: 3)`),
    },
    {
        id: 'refract',
        name: 'Refract',
        dsl: mixer(`  .distortion(tex: read(o1), mode: refract, intensity: osc(type: oscKind.sine, min: 0, max: 0.8))
  .blendMode(tex: read(o1), mode: mix, mix: ${EASE})`),
    },
]

export const DEFAULT_TRANSITION = 'dissolve'

export function transitionPreset(id) {
    return TRANSITIONS.find(t => t.id === id) || TRANSITIONS[0]
}

function post(body) {
    return `search synth, filter

// the composited timeline
media()
${body}
  .write(o0)
render(o0)`
}

export const POST_PRESETS = [
    {
        id: 'clean',
        name: 'Clean',
        dsl: post('  .adjust()'),
    },
    {
        id: 'cinema',
        name: 'Cinema',
        dsl: post(`  .grade(preset: cinematic, alpha: 0.8)
  .bloom(intensity: audio(band: audioBand.low, min: 0.15, max: 0.55), threshold: 0.7)
  .grain(alpha: 0.16)
  .vignette(alpha: 0.6)`),
    },
    {
        id: 'industrial',
        name: 'Industrial',
        dsl: post(`  .grade(contrast: 0.3, blacks: -0.25, saturation: 1.25)
  .bloom(intensity: audio(band: audioBand.low, min: 0.15, max: 0.6), threshold: 0.6)
  .chromaticAberration(aberration: audio(band: audioBand.high, min: 0.05, max: 0.4))
  .grain(alpha: 0.16)
  .vignette(alpha: 0.7)`),
    },
    {
        id: 'vhs',
        name: 'VHS',
        dsl: post(`  .scanlineError(mode: vhs, distortion: audio(band: audioBand.high, min: 0.05, max: 0.4), noise: 0.5)
  .chromaticAberration(aberration: audio(band: audioBand.low, min: 0.1, max: 0.6))
  .crt(alpha: 0.35)
  .grain(alpha: 0.2)`),
    },
    {
        id: 'dream',
        name: 'Dream',
        dsl: post(`  .vaseline(alpha: 0.45)
  .bloom(intensity: audio(band: audioBand.mid, min: 0.2, max: 0.6), radius: 64)
  .lightLeak(alpha: 0.35, speed: 0.3)
  .vignette(alpha: 0.4)`),
    },
    {
        id: 'datamosh',
        name: 'Datamosh',
        dsl: post(`  .corrupt(intensity: audio(band: audioBand.low, min: 0, max: 0.5), channelShift: 30, speed: 2)
  .prismaticAberration(aberration: audio(band: audioBand.high, min: 0.1, max: 0.7))
  .grain(alpha: 0.12)`),
    },
    {
        id: 'print',
        name: 'Print',
        dsl: post(`  .halftone(mode: 0, frequency: 10)
  .grain(alpha: 0.1)`),
    },
    {
        id: 'lofi',
        name: 'Lo-fi',
        dsl: post(`  .posterize(levels: 6)
  .dither(type: bayer4x4, levels: 5, mix: 0.6)
  .vignette(alpha: 0.5)`),
    },
]

export function postPreset(id) {
    return POST_PRESETS.find(p => p.id === id) || POST_PRESETS[0]
}

/** Snippets the inspector offers for wiring audio into a program. */
export function audioSnippets(seq) {
    const snippets = [
        { label: 'Mix, low', code: 'audio(band: audioBand.low)' },
        { label: 'Mix, high', code: 'audio(band: audioBand.high)' },
    ]
    seq.audioTracks.forEach((track, i) => {
        snippets.push({ label: `${track.name}, low`, code: `audio(band: audioBand.low, channel: ${i + 1})` })
    })
    return snippets
}
