/**
 * The demo project: a one-minute music video cut to the generated demo
 * track, built only from curated programs that use heightmap3d and
 * heightGrid. Each program is its curated original with one value wired
 * to the audio. Drums sit on A1 and synths on A2, so the terrain lifts
 * on the kick with `channel: 1` and swells with the synths with
 * `channel: 2`. The drop is a nested sequence that cuts on every bar
 * with its own post chain, inside a main sequence whose post chain
 * blooms on the kick and grains every frame.
 */

import {
    createProject, createSequence, createProgramClip, createSequenceClip, createAudioClip,
} from '../model/project.js'
import { insertClip, addTransition, addMarker } from '../model/edit.js'
import { transitionPreset, postPreset } from './presets.js'
import { demoMedia } from '../audio/media.js'
import { DEMO_ID, DEMO_BPM, DEMO_DURATION } from '../audio/demoTrack.js'

const BAR = (60 / DEMO_BPM) * 4
const BEAT = BAR / 4

// Curated programs from the Noisedeck library (`code` is the share code).
const P = {
    cyberGrid: {
        name: 'more meandering cyber grid',
        code: 'yK_2tw',
        tint: '#fb923c',
        dsl: `search synth, filter, synth3d, render, points, mixer

// the synths on A2 raise the grid

let osc1 = osc(type: oscKind.noise, min: 0.55, max: 0.7, seed: 1997)
let osc2 = osc(type: oscKind.noise, min: 0.53, max: 0.87)
let osc3 = osc(type: oscKind.noise, seed: 7877)
let osc4 = osc(type: oscKind.noise, min: 0.46, max: 0.56, speed: 2, seed: 8236)

perlin(
  scale: 100,
  octaves: 4,
  colorMode: mono,
  dimensions: 3,
  ridges: true
)
  .write(o0)

perlin(
  scale: 17.07,
  colorMode: mono,
  dimensions: 3,
  seed: 3,
  speed: 5
)
  .palette(
    index: springtime,
    offset: 11,
    repeat: 2,
    alpha: 0.62
  )
  .write(o1)

heightmap3d(heightTex: read(o0), tex: read(o1), heightScale: audio(band: audioBand.mid, channel: 2, min: 0.15, max: 0.7))
  .renderLandscape3d(
    zoom: 3.16,
    panY: -0.36,
    viewMode: perspective,
    rotateX: 0,
    rotateY: osc3,
    posX: osc1,
    posY: 11.8,
    posZ: osc2
  )
  .edge(
    channel: luminance,
    amount: 54.64,
    blend: darken
  )
  .wobble()
  .rotate(rotation: osc4)
  .subchain(name: "lens effects", id: "yq5n") {
    .temporalAberration(
      redDelay: 2,
      greenDelay: 1,
      blueDelay: 0
    )
    .bloom(taps: 15)
    .lens(displacement: -0.44)
    .vaseline()
  }
  .write(o2)

render(o2)`,
    },
    horizon: {
        name: 'horizon',
        code: '1FeoLQ',
        tint: '#84cc16',
        dsl: `search synth, filter, synth3d, render

// the synths on A2 raise the city

perlin(
  scale: 100,
  octaves: 4,
  colorMode: mono,
  dimensions: 3,
  ridges: true
)
  .write(o0)

perlin(
  scale: 17.07,
  colorMode: mono,
  dimensions: 3,
  seed: 3,
  speed: 5
)
  .palette(
    index: springtime,
    offset: 11,
    repeat: 2,
    alpha: 0.62
  )
  .write(o1)

heightmap3d(heightTex: read(o0), tex: read(o1), heightScale: audio(band: audioBand.mid, channel: 2, min: 0.15, max: 0.7))
  .renderLandscape3d(
    zoom: 2.08,
    panY: -0.23,
    diffuseIntensity: 0.82,
    specularIntensity: 0.1,
    viewMode: perspective,
    rotateX: 0.24,
    posY: 18.3,
    posZ: 44.2
  )
  .edge(
    channel: luminance,
    amount: 54.64,
    blend: darken
  )
  .write(o2)

render(o2)`,
    },
    infrastructure: {
        name: 'Infrastructure',
        code: '0IlHtg',
        tint: '#ff5fc0',
        dsl: `search synth, filter, synth3d, render, points, mixer

// the kick on A1 lifts the city

let posX = osc(type: oscKind.noise, min: 0.47, max: 0.53, seed: 1997)
let posZ = osc(type: oscKind.noise, min: 0.47, max: 0.53)
let rotY = osc(type: oscKind.noise, min: 0.49, max: 0.64, seed: 7877)
let wobbleRot = osc(type: oscKind.noise, min: 0.46, max: 0.56, speed: 2, seed: 8236)
let height = audio(band: audioBand.low, channel: 1, min: 0.05, max: 0.8)

cell(
  shape: square,
  scale: 31.65,
  cellScale: 65.23,
  speed: 5,
  seed: 26
)
  .write(o0)

cell(
  shape: square,
  scale: 22.38,
  speed: 4
)
  .palette(
    index: toxic,
    offset: 11,
    alpha: 0.62
  )
  .write(o1)

heightmap3d(
  heightTex: read(o0),
  tex: read(o1),
  volumeSize: x128,
  heightScale: height
)
  .renderLandscape3d(
    zoom: 2.72,
    panX: -0.04,
    panY: 0.06,
    ambient: 0.49,
    diffuseIntensity: 0.8,
    specularIntensity: 0.22,
    viewMode: perspective,
    rotateX: 4.43,
    rotateY: rotY,
    rotateZ: 2.56,
    posX: posX,
    posY: 11.8,
    posZ: posZ
  )
  .edge(
    kernel: fine,
    channel: luminance,
    amount: 97.24,
    threshold: 67.23,
    blend: multiply,
    mix: 70.08
  )
  .wobble(wrap: clamp)
  .rotate(
    rotation: wobbleRot,
    wrap: mirror,
    speed: 1
  )
  .subchain(name: "lens effects", id: "yq5n") {
    .temporalAberration(
      redDelay: 3.7,
      greenDelay: 1,
      blueDelay: 0
    )
    .bloom(
      threshold: 1,
      softKnee: 0.09,
      intensity: 0.7,
      radius: 55,
      taps: 38
    )
    .lens(displacement: -1)
    .vaseline(alpha: 0.25)
  }
  .write(o2)

render(o2)`,
    },
    nightVoxicles: {
        name: 'Night Voxicles',
        code: '0C4dKw',
        tint: '#ffd24e',
        dsl: `search synth, filter, synth3d, render, points, mixer, classicNoisedeck

// the kick on A1 lifts the voxels

let osc1 = osc(type: oscKind.saw)
let osc2 = osc(type: oscKind.noise, seed: 3310)
let osc3 = osc(type: oscKind.noise)
let osc4 = osc(type: oscKind.noise, seed: 2104)
let osc5 = osc(type: oscKind.noise, seed: 7169)
let osc6 = osc(type: oscKind.noise, seed: 8125)
let osc7 = osc(type: oscKind.sine, min: 0.07, max: 0.39)
let osc8 = osc(type: oscKind.sawInv)

perlin(scale: 26.15, speed: 5)
  .kaleido(
    sides: 20,
    metric: triangle,
    loopOffset: triangle,
    loopScale: 100,
    speed: -100,
    seed: 99,
    direction: counterclock,
    kernel: outline,
    effectWidth: 3.347
  )
  .write(o0)

read(o0)
  .palette(index: grayscale, repeat: 2)
  .write(o2)

solid(color: #000000)
  .subchain(name: "flow field particles", id: "myse") {
    .pointsEmit()
    .heightGrid(
      heightTex: read(o0),
      diffuseTex: read(o2),
      gridScale: 100,
      heightScale: 74.7,
      heightOffset: -49.4
    )
    .pointsRender(
      density: 100,
      intensity: 66.62,
      viewMode: perspective,
      rotateX: osc7,
      rotateZ: osc8,
      viewScale: 1.43
    )
    .pointsBillboardRender(
      shapeMode: square,
      blendMode: alpha,
      depositOpacity: 100,
      pointSize: 10.05,
      sizeVariation: 100,
      density: 1.98,
      inputIntensity: 100,
      viewMode: perspective,
      rotateX: osc7,
      rotateZ: osc8,
      viewScale: 1.43,
      aperture: 3.2,
      focalDistance: 255
    )
  }
  .write(o3)

heightmap3d(
  heightTex: read(o0),
  tex: read(o2),
  volumeSize: x128,
  heightScale: audio(band: audioBand.low, channel: 1, min: 0.3, max: 0.9)
)
  .renderLandscape3d(
    zoom: 2,
    bgColor: #000000,
    viewMode: perspective,
    rotateX: osc7,
    rotateZ: osc8
  )
  .split(
    tex: read(o3),
    invert: on,
    rotation: osc8,
    softness: 1,
    speed: 2
  )
  .subchain(name: "lens effects", id: "7efo") {
    .temporalAberration(
      redDelay: 2,
      greenDelay: 1,
      blueDelay: 0
    )
    .bloom(taps: 15)
    .lens(displacement: -0.46, aspectLens: false)
    .vignette(alpha: 0.69)
  }
  .write(o1)

render(o1)`,
    },
    rwnmq: {
        name: 'Untitled · rwN-MQ',
        code: 'rwN-MQ',
        tint: '#a78bfa',
        dsl: `search synth, filter, synth3d, render, points, mixer

// the kick on A1 lifts the landscape

let osc1 = osc(type: oscKind.noise, max: 0.15, speed: 2, seed: 8659)
let osc2 = osc(type: oscKind.noise, min: 0.29, max: 0.75, seed: 1342)
let osc3 = osc(type: oscKind.noise, min: 0.27, max: 0.72, seed: 7366)
let osc4 = osc(type: oscKind.noise, min: 0.26, max: 0.79, seed: 3287)
let osc5 = osc(type: oscKind.noise, min: 0.29, max: 0.8, seed: 3188)
let osc6 = osc(type: oscKind.noise, min: 0.21, max: 0.86, seed: 6278)
let osc7 = osc(type: oscKind.sine)
let osc8 = osc(type: oscKind.sine, min: 0.84)

subdivide(
  tex: read(o2),
  fill: arc,
  speed: 19
)
  .tile(
    symmetry: rotate6,
    scale: 4,
    offsetX: osc6,
    offsetY: osc5,
    angle: osc1,
    repeat: 1
  )
  .write(o0)

read(o0)
  .palette(index: santaCruz)
  .write(o2)

solid(color: #000000ff)
  .subchain(name: "flow field particles", id: "uvdh") {
    .pointsEmit(stateSize: x64)
    .heightGrid(
      heightTex: read(o0),
      diffuseTex: read(o2),
      gridScale: 100,
      heightScale: -35
    )
    .pointsRender(
      density: 100,
      intensity: 84.12,
      viewMode: perspective,
      rotateX: 1.56,
      rotateY: osc8,
      rotateZ: osc7,
      viewScale: 1
    )
  }
  .write(o3)

heightmap3d(
  heightTex: read(o0),
  tex: read(o2),
  volumeSize: x128,
  heightScale: audio(band: audioBand.low, channel: 1, min: 0.4, max: 1)
)
  .renderLandscape3d(
    zoom: 0.95,
    bgColor: #35001aff,
    viewMode: perspective,
    rotateX: 1.56,
    rotateY: osc8,
    rotateZ: osc7
  )
  .sobel(alpha: 0.44)
  .split(
    tex: read(o3),
    rotation: osc8,
    softness: 1
  )
  .rotate(speed: 2)
  .subchain(name: "lens effects", id: "7efo") {
    .temporalAberration(
      redDelay: 4,
      greenDelay: 2,
      blueDelay: 0
    )
    .bloom(
      threshold: 0.3,
      intensity: 2.65,
      taps: 15
    )
    .lens(displacement: -1, aspectLens: false)
    .vignette(brightness: 0.58, alpha: 0.44)
  }
  .write(o1)

render(o1)`,
    },
    cyberLandscape: {
        name: 'the evolving cyber landscape',
        code: 'K3MMgw',
        tint: '#a78bfa',
        dsl: `search synth, filter, synth3d, render, points, mixer

// the kick on A1 lifts the landscape

let osc1 = osc(type: oscKind.saw)

cell(
  shape: triangle,
  scale: 81.67,
  cellScale: 100,
  speed: 5
)
  .write(o0)

perlin(
  scale: 57.13,
  colorMode: mono,
  speed: 3
)
  .palette(
    index: vibrant,
    rotation: back,
    offset: 94.412,
    repeat: 2,
    alpha: 0.536
  )
  .write(o2)

heightmap3d(
  heightTex: read(o0),
  tex: read(o2),
  heightScale: audio(band: audioBand.low, channel: 1, min: 0.2, max: 0.8),
  baseHeight: 0.08
)
  .renderLandscape3d(
    zoom: 2.43,
    ambient: 0.16,
    diffuseIntensity: 1.02,
    specularIntensity: 0.2,
    bgColor: #000000,
    viewMode: perspective,
    rotateX: 1.47,
    rotateZ: osc1,
    posZ: 83.2,
    fieldOfView: 114
  )
  .sobel(amount: 1.96)
  .subchain(name: "lens effects", id: "m56y") {
    .temporalAberration()
    .bloom(
      threshold: 0.15,
      softKnee: 0.18,
      intensity: 1.55,
      taps: 15
    )
    .lens(displacement: -0.61, aspectLens: false)
    .vaseline()
  }
  .write(o1)

render(o1)`,
    },
    waveSort: {
        name: 'wave sort',
        code: 'tLMC4w',
        tint: '#ff6b6b',
        dsl: `search synth, points, render, filter, mixer

// the kick on A1 lifts the grid

osc2d(
  oscType: noise2d,
  freq: 8,
  speed: 1,
  rotation: -31.628,
  seed: 944
)
  .write(o1)

read(o1)
  .palette(
    index: dreamy,
    rotation: fwd,
    alpha: 0.58
  )
  .write(o2)

solid(color: #000000ff)
  .pointsEmit(stateSize: x128)
  .heightGrid(
    heightTex: read(o1),
    diffuseTex: read(o2),
    gridScale: 100,
    heightScale: audio(band: audioBand.low, channel: 1, min: 0.5, max: 0.8),
    heightOffset: 29.3
  )
  .pointsBillboardRender(
    shapeMode: square,
    blendMode: alpha,
    depositOpacity: 100,
    pointSize: 2.58,
    sizeVariation: 100,
    density: 100,
    intensity: 75.58,
    inputIntensity: 100,
    viewMode: perspective,
    rotateX: 0.36,
    rotateZ: 0.05,
    viewScale: 2.53,
    posY: -25,
    posZ: 2.2,
    fieldOfView: 73,
    sizeDistance: 226,
    brightnessDistance: 120,
    aperture: 9.6,
    focalDistance: 1
  )
  .subchain(name: "lens effects", id: "k6ns") {
    .temporalAberration()
    .bloom(
      threshold: 0.3,
      intensity: 1.5,
      taps: 15
    )
    .lens(displacement: -0.32, aspectLens: false)
    .vaseline(alpha: 1)
  }
  .pixelSort(angled: 15)
  .write(o0)

render(o0)`,
    },
    blocko: {
        name: 'blocko',
        code: 'e0ukeQ',
        tint: '#4ed99b',
        dsl: `search synth, filter, synth3d, render, points, mixer

// the kick on A1 lifts the blocks

let osc1 = osc(type: oscKind.noise, max: 0.15, speed: 2, seed: 8659)
let osc2 = osc(type: oscKind.noise, min: 0.29, max: 0.75, seed: 1342)
let osc3 = osc(type: oscKind.noise, min: 0.27, max: 0.72, seed: 7366)
let osc4 = osc(type: oscKind.noise, min: 0.26, max: 0.79, seed: 3287)
let osc5 = osc(type: oscKind.noise, min: 0.29, max: 0.8, seed: 3188)
let osc6 = osc(type: oscKind.noise, min: 0.26, max: 0.77, seed: 6278)
let osc7 = osc(type: oscKind.noise, min: 0.42, max: 0.67, seed: 9999)
let osc8 = osc(type: oscKind.noise, min: 0.87, seed: 6954)

bitwise(
  operation: and,
  scale: 100,
  offsetY: 154,
  speed: 5
)
  .tile(
    symmetry: rotate6,
    scale: 0.4,
    offsetX: osc6,
    offsetY: osc5,
    angle: osc1,
    repeat: 1
  )
  .write(o0)

read(o0)
  .palette(index: darkSatin)
  .write(o2)

solid(color: #000000ff)
  .subchain(name: "flow field particles", id: "uvdh") {
    .pointsEmit(stateSize: x2048)
    .heightGrid(
      heightTex: read(o0),
      diffuseTex: read(o2),
      heightScale: 100,
      heightOffset: -75.6
    )
    .pointsRender(
      density: 100,
      intensity: 0,
      inputIntensity: 100,
      viewMode: perspective,
      rotateX: 1.5,
      rotateY: osc8,
      rotateZ: osc7,
      viewScale: 2.5,
      posZ: 25,
      fieldOfView: 90
    )
  }
  .write(o3)

heightmap3d(
  heightTex: read(o0),
  tex: read(o2),
  volumeSize: x128,
  heightScale: audio(band: audioBand.low, channel: 1, min: 0.3, max: 0.9)
)
  .renderLandscape3d(
    zoom: 2.5,
    bgColor: #222222ff,
    viewMode: perspective,
    rotateX: 1.5,
    rotateY: osc8,
    rotateZ: osc7,
    posZ: 25,
    fieldOfView: 90
  )
  .sobel(amount: 0.59, alpha: 0.81)
  .blendMode(
    tex: read(o3),
    mode: lighten,
    mix: -68.88
  )
  .subchain(name: "lens effects", id: "7efo") {
    .temporalAberration(
      redDelay: 2,
      greenDelay: 1,
      blueDelay: 0
    )
    .bloom(
      threshold: 0.95,
      intensity: 0.9,
      taps: 15
    )
    .lens(displacement: -1, aspectLens: false)
    .vignette(brightness: 0.58, alpha: 0.44)
  }
  .write(o1)

render(o1)`,
    },
    voxicles: {
        name: 'voxicles',
        code: 'cixSsg',
        tint: '#f43f5e',
        dsl: `search synth, filter, render, points, mixer, synth3d

// the kick on A1 lifts the voxels

let osc1 = osc(type: oscKind.noise, min: 0.69, max: 0.72)
let osc2 = osc(type: oscKind.noise, max: 0.13)

perlin(
  scale: 9.51,
  octaves: 3,
  colorMode: mono,
  seed: 70,
  speed: 5
)
  .write(o0)

perlin(
  scale: 13.05,
  colorMode: mono,
  speed: 5
)
  .palette(
    index: mars,
    rotation: back,
    offset: 41.51,
    alpha: 0.669
  )
  .write(o2)

heightmap3d(
  heightTex: read(o0),
  tex: read(o2),
  volumeSize: x128,
  heightScale: audio(band: audioBand.low, channel: 1, min: 0.1, max: 0.45),
  baseHeight: 0.42
)
  .renderLandscape3d(
    viewMode: perspective,
    rotateX: 1,
    rotateY: osc2,
    rotateZ: osc2,
    posY: -10,
    posZ: osc1,
    fieldOfView: 96
  )
  .write(o3)

solid(color: #000000ff)
  .subchain(name: "strange attractor particles", id: "9xcv") {
    .pointsEmit(stateSize: x128)
    .heightGrid(
      heightTex: read(o0),
      diffuseTex: read(o2),
      heightOffset: -11.1
    )
    .pointsBillboardRender(
      shapeMode: square,
      blendMode: alpha,
      depositOpacity: 100,
      pointSize: 9.05,
      sizeVariation: 100,
      rotationVar: 100,
      density: 100,
      intensity: 92.19,
      inputIntensity: 100,
      viewMode: perspective,
      rotateX: 1,
      rotateY: osc2,
      rotateZ: osc2,
      viewScale: 0.75,
      posY: -10,
      posZ: osc1,
      fieldOfView: 96,
      sizeDistance: 116,
      brightnessDistance: 45,
      aperture: 1.1,
      focalDistance: 22
    )
  }
  .split(
    tex: read(o3),
    invert: on,
    rotation: -131.76,
    softness: 1,
    speed: 4
  )
  .subchain(name: "lens effects", id: "6uyj") {
    .temporalAberration()
    .bloom(taps: 15)
    .lens(displacement: -0.5)
    .vaseline()
  }
  .write(o1)

render(o1)`,
    },
    secretPattern: {
        name: 'secret pattern',
        code: 'YexlQw',
        tint: '#ffd24e',
        dsl: `search synth, filter, synth3d, render, points, mixer

// the kick on A1 lifts the circuit

let posX = osc(type: oscKind.noise, min: 0.49, max: 0.51, seed: 1997)
let posZ = osc(type: oscKind.noise, min: 0.49, max: 0.51)
let rotY = osc(type: oscKind.noise, min: 0.49, max: 0.51, seed: 7877)
let wobbleRot = osc(type: oscKind.noise, min: 0.49, max: 0.51, speed: 2, seed: 8236)
let height = audio(band: audioBand.low, channel: 1, min: 0.05, max: 0.8)

cell(
  shape: square,
  scale: 31.65,
  cellScale: 65.23,
  speed: 5,
  seed: 26
)
  .write(o0)

cell(
  shape: square,
  scale: 22.38,
  speed: 4
)
  .palette(
    index: skykissed,
    rotation: back,
    offset: 28.021,
    repeat: 3
  )
  .write(o1)

heightmap3d(
  heightTex: read(o0),
  tex: read(o1),
  volumeSize: x128,
  heightScale: height
)
  .renderLandscape3d(
    zoom: 2.72,
    panX: -0.04,
    panY: 0.06,
    ambient: 0.49,
    diffuseIntensity: 0.8,
    specularIntensity: 0.22,
    viewMode: perspective,
    rotateX: 4.43,
    rotateY: rotY,
    rotateZ: 2.56,
    posX: posX,
    posY: 11.8,
    posZ: posZ
  )
  .edge(
    kernel: fine,
    channel: luminance,
    amount: 97.24,
    threshold: 67.23,
    blend: multiply,
    mix: 81.05
  )
  .wobble(wrap: clamp)
  .rotate(rotation: wobbleRot, wrap: mirror)
  .subchain(name: "lens effects", id: "yq5n") {
    .bloom(
      threshold: 1,
      softKnee: 0.09,
      intensity: 0.7,
      radius: 55,
      taps: 38
    )
    .lens(displacement: -1)
    .vaseline(alpha: 0.58)
  }
  .write(o2)

render(o2)`,
    },
    landscapeTest: {
        name: 'landscape automation test 2',
        code: 'ZqWbKQ',
        tint: '#ff6b6b',
        dsl: `search synth, filter, synth3d, render, points, mixer

// the kick on A1 lifts the terrain

let osc1 = osc(type: oscKind.noise, min: 0.55, max: 0.7, seed: 1997)
let osc2 = osc(type: oscKind.noise, min: 0.53, max: 0.87)
let osc3 = osc(type: oscKind.noise, seed: 7877)
let osc4 = osc(type: oscKind.noise, min: 0.46, max: 0.56, speed: 2, seed: 8236)
let osc5 = osc(type: oscKind.noise, min: 0.26, speed: 4, seed: 7029)

perlin(
  scale: osc5,
  octaves: 4,
  colorMode: mono,
  dimensions: 3,
  ridges: true,
  speed: 4
)
  .write(o0)

perlin(
  scale: osc5,
  colorMode: mono,
  dimensions: 3,
  seed: 3
)
  .palette(
    index: royal,
    offset: 11,
    repeat: 2,
    alpha: 0.62
  )
  .write(o1)

heightmap3d(
  heightTex: read(o0),
  tex: read(o1),
  volumeSize: x128,
  heightScale: audio(band: audioBand.low, channel: 1, min: 0.2, max: 0.8)
)
  .renderLandscape3d(
    zoom: 3.16,
    panY: -0.36,
    viewMode: perspective,
    rotateX: 0,
    rotateY: osc3,
    posX: osc1,
    posY: 11.8,
    posZ: osc2
  )
  .edge(
    channel: luminance,
    amount: 54.64,
    blend: darken
  )
  .wobble(wrap: clamp)
  .rotate(rotation: osc4, wrap: clamp)
  .subchain(name: "lens effects", id: "yq5n") {
    .temporalAberration(
      redDelay: 2,
      greenDelay: 1,
      blueDelay: 0
    )
    .bloom(
      threshold: 0,
      intensity: 2,
      radius: 55,
      taps: 38
    )
    .lens(displacement: -0.44)
    .vaseline()
  }
  .write(o2)

render(o2)`,
    },
    softWaves: {
        name: 'soft waves',
        code: '6l1kKA',
        tint: '#4ea8ff',
        dsl: `search synth, points, render, filter, mixer

// the synths on A2 swell the waves

shape(
  loopAOffset: verticalScan,
  loopBOffset: noiseSimplex,
  loopBScale: 100,
  speedA: 100,
  speedB: -43
)
  .write(o1)

read(o1)
  .palette(
    index: afterimage,
    rotation: fwd,
    alpha: 0.58
  )
  .write(o2)

solid(color: #000000)
  .pointsEmit(stateSize: x128)
  .heightGrid(
    heightTex: read(o1),
    diffuseTex: read(o2),
    gridScale: 100,
    heightScale: audio(band: audioBand.mid, channel: 2, min: 0.5, max: 0.8),
    heightOffset: 29.3
  )
  .pointsBillboardRender(
    blendMode: alpha,
    pointSize: 4.16,
    density: 100,
    inputIntensity: 100,
    viewMode: perspective,
    rotateX: 0.37,
    viewScale: 2.19,
    posY: -31.3
  )
  .subchain(name: "lens effects", id: "k6ns") {
    .temporalAberration()
    .bloom(
      threshold: 0.3,
      intensity: 1.5,
      taps: 15
    )
    .lens(displacement: -0.71, aspectLens: false)
    .vaseline(alpha: 1)
  }
  .write(o0)

render(o0)`,
    },
    minimumLegroom: {
        name: 'minimum legroom',
        code: 'VrdCjg',
        tint: '#84cc16',
        dsl: `search synth, filter, synth3d, render, points, mixer

// the kick on A1 lifts the tunnel

let zRotation = osc(type: oscKind.saw)
let noiseScale = osc(type: oscKind.sine, min: 0.45, max: 0.84, speed: 2)
let zPosition = osc(type: oscKind.noise, min: 0.57, max: 0.78, seed: 2995)
let offsetX = osc(type: oscKind.noise, min: 0.31, max: 0.62, seed: 7785)
let offsetY = osc(type: oscKind.noise, min: 0.5, max: 0.63, seed: 5611)

cell(
  shape: triangle,
  scale: noiseScale,
  cellScale: 100,
  variation: 0,
  speed: 5,
  seed: 46
)
  .write(o0)

perlin(
  scale: 100,
  colorMode: mono,
  dimensions: 3,
  ridges: true,
  speed: 2
)
  .palette(
    index: eventHorizon,
    rotation: back,
    offset: 83.098,
    repeat: 3,
    alpha: 0.66
  )
  .write(o2)

heightmap3d(
  heightTex: read(o0),
  tex: read(o2),
  volumeSize: x128,
  heightScale: audio(band: audioBand.low, channel: 1, min: 0.25, max: 0.85),
  baseHeight: 0.08
)
  .renderLandscape3d(
    zoom: zPosition,
    ambient: 0.37,
    diffuseIntensity: 1.2,
    specularIntensity: 0.2,
    bgColor: #000000,
    viewMode: perspective,
    rotateX: 1.47,
    rotateZ: zRotation,
    posX: offsetX,
    posY: offsetY,
    posZ: zPosition,
    fieldOfView: 94
  )
  .edge(
    kernel: fine,
    size: kernel7x7,
    channel: luminance,
    amount: 17.89,
    mix: 84.15
  )
  .wobble()
  .subchain(name: "lens effects", id: "m56y") {
    .temporalAberration()
    .bloom(
      threshold: 0.15,
      softKnee: 0.18,
      intensity: 1.55,
      taps: 15
    )
    .lens(displacement: -1)
    .vaseline()
  }
  .write(o1)

render(o1)`,
    },
    orthoLandscape: {
        name: 'ortho landscape',
        code: 'wKiJpQ',
        tint: '#a78bfa',
        dsl: `search synth, filter, synth3d, render

perlin(
  scale: 100,
  octaves: 4,
  colorMode: mono,
  dimensions: 3,
  ridges: true
)
  .write(o0)

perlin(
  scale: 17.07,
  colorMode: mono,
  dimensions: 3,
  seed: 3,
  speed: 5
)
  .palette(
    index: springtime,
    offset: 11,
    repeat: 2,
    alpha: 0.62
  )
  .write(o1)

heightmap3d(heightTex: read(o0), tex: read(o1))
  .renderLandscape3d(
    zoom: 3.95,
    panY: -0.42,
    diffuseIntensity: 0.82,
    specularIntensity: 0.1,
    rotateX: 0.24,
    posY: 18.3,
    posZ: 44.2
  )
  .edge(
    channel: luminance,
    amount: 54.64,
    blend: darken
  )
  .write(o2)

render(o2)`,
    },
}

/** The demo's programs, offered first in the library. */
export const STARTER_PROGRAMS = Object.values(P).map(p => ({ name: p.name, dsl: p.dsl, tint: p.tint, tags: [] }))

function clip(spec, start, duration, extra = {}) {
    return createProgramClip({ name: spec.name, tint: spec.tint, dsl: spec.dsl, start, duration, loop: BAR * 8, ...extra })
}

function cut(track, a, b, preset, duration) {
    addTransition(track, { from: a.id, to: b.id, duration, preset, dsl: transitionPreset(preset).dsl })
}

/** Point a post preset's bare audio() calls at the drums track. */
function onDrums(dsl) {
    return dsl.replace(/audio\(band: audioBand\.(low|high),/g, 'audio(band: audioBand.$1, channel: 1,')
}

export function createDemoProject() {
    const project = createProject({ name: 'Demo: Refinery' })
    project.demo = DEMO_ID
    project.media = demoMedia()
    const main = project.sequences[project.mainSequenceId]
    Object.assign(main, { name: 'Refinery', duration: DEMO_DURATION, bpm: DEMO_BPM, fps: 30 })
    main.audioTracks[0].name = 'Drums'
    main.audioTracks[1].name = 'Synths'
    // The main post chain blooms on the kick and shakes on the hats.
    main.post = { enabled: true, preset: 'industrial', loop: BAR * 8, dsl: onDrums(postPreset('industrial').dsl) }

    // The drop: a nested sequence that cuts on every bar.
    const drop = createSequence({ name: 'Drop', duration: BAR * 8, fps: 30, tracks: 2, audioTracks: 0 })
    drop.bpm = DEMO_BPM
    drop.post = { enabled: true, preset: 'datamosh', loop: BAR * 4, dsl: onDrums(postPreset('datamosh').dsl) }
    const order = [
        P.nightVoxicles, P.rwnmq, P.cyberLandscape, P.waveSort,
        P.blocko, P.voxicles, P.secretPattern, P.landscapeTest,
    ]
    const dropClips = order.map((spec, i) => insertClip(drop.tracks[0], clip(spec, i * BAR, BAR, { loop: BAR * 4, offset: i * BEAT })))
    const dropCuts = ['hexagons', 'wipe', 'glitch', 'refract', 'iris', 'glitch', 'luma']
    dropCuts.forEach((preset, i) => cut(drop.tracks[0], dropClips[i], dropClips[i + 1], preset, preset === 'glitch' ? BEAT : BEAT * 2))
    project.sequences[drop.id] = drop
    project.sequenceOrder.push(drop.id)

    const v1 = main.tracks[0]
    const intro = insertClip(v1, clip(P.cyberGrid, 0, BAR * 4))
    const city = insertClip(v1, clip(P.horizon, BAR * 4, BAR * 4))
    const build = insertClip(v1, clip(P.infrastructure, BAR * 8, BAR * 8))
    const dropClip = insertClip(v1, createSequenceClip({ sequenceId: drop.id, name: 'Drop', start: BAR * 16, duration: BAR * 8 }))
    const brk = insertClip(v1, clip(P.softWaves, BAR * 24, BAR * 4))
    const finale = insertClip(v1, clip(P.minimumLegroom, BAR * 28, BAR * 4))
    addTransition(v1, { from: null, to: intro.id, duration: BAR, preset: 'dissolve' })
    cut(v1, intro, city, 'luma', BAR)
    cut(v1, city, build, 'glitch', BEAT)
    cut(v1, build, dropClip, 'flash', BEAT * 2)
    cut(v1, dropClip, brk, 'iris', BAR)
    cut(v1, brk, finale, 'glitch', BEAT)
    addTransition(v1, { from: finale.id, to: null, duration: BAR, preset: 'dissolve' })

    insertClip(main.tracks[1], clip(P.orthoLandscape, BAR * 28, BAR * 4, { blend: 'difference', opacity: 0.6 }))

    const fadeOut = BAR
    insertClip(main.audioTracks[0], Object.assign(createAudioClip({ mediaId: 'med_refinery_drums', name: 'Refinery drums', start: 0, duration: DEMO_DURATION }), { fadeOut }))
    insertClip(main.audioTracks[1], Object.assign(createAudioClip({ mediaId: 'med_refinery_synths', name: 'Refinery synths', start: 0, duration: DEMO_DURATION }), { fadeOut }))

    addMarker(main, 0, 'Intro')
    addMarker(main, BAR * 8, 'Build')
    addMarker(main, BAR * 16, 'Drop')
    addMarker(main, BAR * 24, 'Break')
    addMarker(main, BAR * 28, 'Final drop')
    return project
}
