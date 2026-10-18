/**
 * The demo project: a one-minute music video cut to the generated demo
 * track. Drums sit on A1 and music on A2, so programs bind to the kick
 * with `channel: 1` and to the harmony with `channel: 2`. The drop is a
 * nested sequence that cuts on every bar with its own post chain, inside
 * a main sequence whose post chain blooms on the kick.
 */

import {
    createProject, createSequence, createProgramClip, createSequenceClip, createAudioClip,
} from '../model/project.js'
import { insertClip, addTransition, addMarker } from '../model/edit.js'
import { transitionPreset, postPreset } from './presets.js'
import { demoMedia } from '../audio/media.js'
import { DEMO_BPM, DEMO_DURATION } from '../audio/demoTrack.js'

const BAR = (60 / DEMO_BPM) * 4
const BEAT = BAR / 4

const P = {
    crystalCave: {
        name: 'Crystal cave',
        tint: '#a78bfa',
        dsl: `search synth, filter, classicNoisedeck, render, points, mixer

// slow geometric opener; the harmony track (A2) breathes the bloom
perlin(scale: 52.81)
  .lowPoly(scale: 96, seed: 42, mode: distance2, edgeStrength: 0.82, alpha: 0.7, speed: 5)
  .adjust(mode: hsv, rotation: 120, hueRange: 40)
  .lighting(normalStrength: 5, smoothing: 2.9, specularIntensity: 2, shininess: 156, reflection: 21.3, refraction: 45.4, aberration: 36.1)
  .write(o0)

caustic(interp: catmullRom4x4, noiseScale: 192.39, speed: 57.27, seed: 52)
  .coalesce(tex: read(o0), blendMode: screen, mix: 8.27, refractAAmt: 63.56)
  .bloom(threshold: 0.9, intensity: audio(band: audioBand.mid, channel: 2, min: 0.2, max: 0.6), taps: 24)
  .lens(displacement: -0.5)
  .vignette()
  .adjust(saturation: 1.24, contrast: 0.61)
  .write(o1)

render(o1)`,
    },
    kickPulse: {
        name: 'Kick pulse',
        tint: '#ff4d5e',
        dsl: `search classicNoisedeck, synth, filter

// the kick (A1) drives the lens and the refraction mix
let kick = audio(band: audioBand.low, channel: 1)

noise(hueRange: 30, speed: 50, refractAmt: 80, ridges: true, wrap: true, xScale: 95, yScale: 95, type: simplex, colorMode: hsv, kaleido: 1, octaves: 1)
  .write(o0)

noise(palette: vaporwave, type: catmullRom3x3, colorMode: palette, kaleido: 1, xScale: 60, yScale: 60, octaves: 1)
  .coalesce(tex: read(o0), blendMode: reflect, mix: kick, refractAAmt: 40, refractBAmt: 80)
  .lensDistortion(aberration: kick, distortion: kick, speed: 0, loopScale: 60, alpha: 30, shape: circle, tint: #ff4d5e, vignetteAmt: -60)
  .write(o1)

render(o1)`,
    },
    fireEyes: {
        name: 'Fire eyes',
        tint: '#ff8b3d',
        dsl: `search classicNoisedeck, synth, filter

let kick = audio(band: audioBand.low, channel: 1, min: 0.35, max: 0.75)

shapes(speedA: -31, loopAOffset: triangle, loopAScale: kick, speedB: 23, loopBOffset: diamond, loopBScale: 100, palette: grayscale, wrap: true, cyclePalette: off, rotatePalette: 0)
  .write(o0)

noise(hueRange: 34, hueRotation: 78, speed: 100, refractAmt: 47, ridges: true, wrap: true, xScale: 99, yScale: 96, type: catmullRom3x3, colorMode: hsv, kaleido: 1, octaves: 1)
  .coalesce(tex: read(o0), blendMode: cloak, mix: 71, refractAAmt: 73, refractBAmt: 83)
  .lensDistortion(aberration: 47, distortion: 14, speed: -78, loopScale: 67, alpha: 16, saturation: -15, shape: triangle, tint: #c45f95, vignetteAmt: -100)
  .write(o1)

render(o1)`,
    },
    glitchField: {
        name: 'Glitch field',
        tint: '#00d4ff',
        dsl: `search classicNoisedeck, synth, filter

let hats = audio(band: audioBand.high, channel: 1)

noise(hueRange: 83, hueRotation: hats, speed: 100, refractAmt: 90, ridges: true, wrap: true, xScale: 100, yScale: 97, type: simplex, colorMode: hsv, kaleido: 1, octaves: 1)
  .write(o0)

noise(hueRange: 81, hueRotation: 66, speed: 100, refractAmt: 100, ridges: true, wrap: true, xScale: 99, yScale: 96, type: simplex, colorMode: hsv, kaleido: 1, octaves: 1)
  .coalesce(tex: read(o0), blendMode: reflect, mix: -86, refractAAmt: 48, refractBAmt: 60)
  .lensDistortion(aberration: 100, hueRange: 100, hueRotation: 0, blendMode: add, modulate: true, passthru: 33, alpha: 0, speed: 0, distortion: 0)
  .write(o1)

render(o1)`,
    },
    pinkKaleido: {
        name: 'Pink kaleidoscope',
        tint: '#ff5fc0',
        dsl: `search classicNoisedeck, synth, filter

// the harmony (A2) sets the number of mirrors
let sides = audio(band: audioBand.mid, channel: 2, min: 0.1, max: 0.5)

noise(hueRotation: 0, kaleido: sides, metric: circle, palette: eventHorizon, wrap: true, type: catmullRom3x3, colorMode: palette, xScale: 85, yScale: 85, octaves: 1)
  .write(o0)

render(o0)`,
    },
    rainbowMirror: {
        name: 'Rainbow mirror',
        tint: '#8a47ae',
        dsl: `search classicNoisedeck, synth, filter

let mid = audio(band: audioBand.mid, channel: 2, min: 0.2, max: 1)

noise(hueRange: 37, hueRotation: 0, speed: mid, octaves: 5, refractAmt: 100, ridges: false, type: simplex, colorMode: hsv, kaleido: 1, xScale: 98, yScale: 98)
  .write(o0)

noise(hueRange: 100, hueRotation: 28, speed: 98, refractAmt: 0, ridges: false, wrap: false, xScale: 98, yScale: 98, type: hermite, colorMode: hsv, kaleido: 1, octaves: 1)
  .coalesce(tex: read(o0), blendMode: hardLight, mix: -72, refractAAmt: 0, refractBAmt: 100)
  .lensDistortion(aberration: 0, distortion: -22, speed: 10, loopScale: 71, alpha: 0, shape: hexagon, tint: #8a47ae, vignetteAmt: -73)
  .write(o1)

render(o1)`,
    },
    beatRings: {
        name: 'Beat rings',
        tint: '#ffb03d',
        dsl: `search classicNoisedeck, synth, filter

let kick = audio(band: audioBand.low, channel: 1, min: 0.1, max: 0.8)
let kickMix = audio(band: audioBand.low, channel: 1)

shapes(speedA: -30, loopAOffset: circle, loopAScale: kick, speedB: 50, loopBOffset: heptagon, loopBScale: kick, palette: solaris, wrap: true, cyclePalette: off, rotatePalette: 0)
  .write(o0)

noise(hueRange: 37, hueRotation: 88, speed: 95, octaves: 3, refractAmt: 0, ridges: true, type: simplex, colorMode: hsv, kaleido: 1, xScale: 100, yScale: 100)
  .coalesce(tex: read(o0), blendMode: reflect, mix: kickMix, refractAAmt: 6, refractBAmt: 0)
  .write(o1)

render(o1)`,
    },
    oilSlick: {
        name: 'Oil slick',
        tint: '#22d3ee',
        dsl: `search classicNoisedeck, synth, filter

noise(hueRange: 100, hueRotation: audio(band: audioBand.high, channel: 1), speed: 100, refractAmt: 100, ridges: true, wrap: true, xScale: 100, yScale: 100, type: simplex, colorMode: hsv, kaleido: 1, octaves: 1)
  .write(o0)

render(o0)`,
    },
    softGlow: {
        name: 'Soft glow',
        tint: '#ffd24e',
        dsl: `search classicNoisedeck, synth, filter

// the break: hue follows the pads on A2
let pads = audio(band: audioBand.mid, channel: 2)

noise(hueRange: 34, hueRotation: pads, speed: 17, octaves: 3, refractAmt: 0, ridges: true, type: simplex, colorMode: hsv, kaleido: 1, xScale: 100, yScale: 100)
  .colorLab(colorMode: srgbDefault, dither: none, hueRange: 100, hueRotation: 0, levels: 0, palette: royal)
  .write(o1)

render(o1)`,
    },
    blueMandala: {
        name: 'Blue mandala',
        tint: '#4a88fb',
        dsl: `search classicNoisedeck, synth, filter

let sides = audio(band: audioBand.low, channel: 1, min: 0.15, max: 0.6)

noise(hueRotation: 74, kaleido: sides, metric: circle, palette: royal, wrap: true, type: catmullRom3x3, colorMode: palette, xScale: 98, yScale: 98, octaves: 1)
  .write(o0)

noise(hueRotation: 83, kaleido: 5, metric: circle, palette: skykissed, wrap: true, type: linear, colorMode: palette, xScale: 92, yScale: 92, octaves: 1)
  .coalesce(tex: read(o0), blendMode: difference, mix: -21, refractAAmt: 40, refractBAmt: 42)
  .kaleido(direction: clockwise, effectWidth: 0, sides: 5, kernel: none, speed: 2, loopOffset: pentagon, loopScale: 34, metric: circle, wrap: true)
  .colorLab(colorMode: srgbDefault, dither: none, hueRange: 100, hueRotation: 58, levels: 0, palette: sulphur)
  .write(o1)

render(o1)`,
    },
    spectrum: {
        name: 'Spectrum',
        tint: '#22c55e',
        dsl: `search synth

// the mix's spectrum, screened over the drop
spectrum().write(o0)
render(o0)`,
    },
    scope: {
        name: 'Scope',
        tint: '#4ed99b',
        dsl: `search synth

scope().write(o0)
render(o0)`,
    },
}

/** The demo's programs, offered first in the library. */
export const STARTER_PROGRAMS = Object.values(P).map(p => ({ name: p.name, dsl: p.dsl, tint: p.tint, tags: [] }))

function clip(spec, start, duration, extra = {}) {
    return createProgramClip({ name: spec.name, tint: spec.tint, dsl: spec.dsl, start, duration, loop: BAR * 4, ...extra })
}

function cut(track, a, b, preset, duration) {
    addTransition(track, { from: a.id, to: b.id, duration, preset, dsl: transitionPreset(preset).dsl })
}

export function createDemoProject() {
    const project = createProject({ name: 'Demo: Night Drive' })
    project.media = demoMedia()
    const main = project.sequences[project.mainSequenceId]
    Object.assign(main, { name: 'Night Drive', duration: DEMO_DURATION, bpm: DEMO_BPM, fps: 30 })
    main.tracks[0].name = 'V1'
    main.audioTracks[0].name = 'Drums'
    main.audioTracks[1].name = 'Music'
    const cinema = postPreset('cinema')
    main.post = { enabled: true, preset: 'cinema', dsl: cinema.dsl, loop: BAR * 4 }

    // The drop: a nested sequence that cuts on every bar.
    const drop = createSequence({ name: 'Drop', duration: BAR * 8, fps: 30, tracks: 2, audioTracks: 0 })
    drop.bpm = DEMO_BPM
    const datamosh = postPreset('datamosh')
    drop.post = {
        enabled: true,
        preset: 'datamosh',
        loop: BAR * 4,
        dsl: datamosh.dsl.replace(/audio\(band: audioBand\.low,/g, 'audio(band: audioBand.low, channel: 1,'),
    }
    const order = [P.fireEyes, P.glitchField, P.pinkKaleido, P.rainbowMirror, P.beatRings, P.oilSlick, P.fireEyes, P.glitchField]
    const dropClips = order.map((spec, i) => insertClip(drop.tracks[0], clip(spec, i * BAR, BAR, { loop: BAR * 2, offset: i * BEAT })))
    const dropCuts = ['hexagons', 'wipe', 'glitch', 'refract', 'iris', 'glitch', 'luma']
    dropCuts.forEach((preset, i) => cut(drop.tracks[0], dropClips[i], dropClips[i + 1], preset, preset === 'glitch' ? BEAT : BEAT * 2))
    insertClip(drop.tracks[1], clip(P.spectrum, BAR * 4, BAR * 4, { blend: 'screen', opacity: 0.55 }))
    project.sequences[drop.id] = drop
    project.sequenceOrder.push(drop.id)

    const v1 = main.tracks[0]
    const intro = insertClip(v1, clip(P.crystalCave, 0, BAR * 8))
    const build = insertClip(v1, clip(P.kickPulse, BAR * 8, BAR * 8))
    const dropClip = insertClip(v1, createSequenceClip({ sequenceId: drop.id, name: 'Drop', start: BAR * 16, duration: BAR * 8 }))
    const brk = insertClip(v1, clip(P.softGlow, BAR * 24, BAR * 4))
    const finale = insertClip(v1, clip(P.blueMandala, BAR * 28, BAR * 4))
    addTransition(v1, { from: null, to: intro.id, duration: BAR, preset: 'dissolve' })
    cut(v1, intro, build, 'luma', BAR)
    cut(v1, build, dropClip, 'flash', BEAT * 2)
    cut(v1, dropClip, brk, 'iris', BAR)
    cut(v1, brk, finale, 'glitch', BEAT)
    addTransition(v1, { from: finale.id, to: null, duration: BAR, preset: 'dissolve' })

    insertClip(main.tracks[1], clip(P.scope, BAR * 28, BAR * 4, { blend: 'add', opacity: 0.35 }))

    insertClip(main.audioTracks[0], createAudioClip({ mediaId: 'med_demo_drums', name: 'Demo drums', start: 0, duration: DEMO_DURATION }))
    insertClip(main.audioTracks[1], createAudioClip({ mediaId: 'med_demo_music', name: 'Demo music', start: 0, duration: DEMO_DURATION }))

    addMarker(main, 0, 'Intro')
    addMarker(main, BAR * 8, 'Build')
    addMarker(main, BAR * 16, 'Drop')
    addMarker(main, BAR * 24, 'Break')
    addMarker(main, BAR * 28, 'Final drop')
    return project
}
