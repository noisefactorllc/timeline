import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

// A triangle pass whose count is 'screen' draws one vertex per texel of the
// mesh-position texture it reads: a 2x3 mesh texture draws 6 vertices, two
// whole triangles. The engine release of 2026-11-26 fixed the triangles path,
// which dropped 'screen' counts and drew nothing (the points and billboards
// paths already resolved them). A screen-count triangle pass reaches the app
// as a portable effect, so a program renders it through the same
// registration and rendering paths a project uses.
//
// The probe reads its vertex count from the texture the source effect hands
// on, and its two triangles fill the left and right halves with different
// colours: a pass that falls back to one triangle, or draws nothing, leaves
// the other half black.

const CLEAR_GLSL = `#version 300 es
precision highp float;
out vec4 fragColor;
void main() { fragColor = vec4(0.0); }`

const TRI_VERT = `#version 300 es
precision highp float;
flat out int vSide;
void main() {
    // Vertices 0-2 fill the left half, 3-5 the right half.
    vec2 corner[3] = vec2[3](vec2(-1.0, -1.0), vec2(0.0, 0.0), vec2(-1.0, 1.0));
    vec2 screen[3] = vec2[3](vec2(1.0, 1.0), vec2(0.0, 0.0), vec2(1.0, -1.0));
    int id = int(gl_VertexID);
    vSide = id >= 3 ? 1 : 0;
    gl_Position = vec4(id >= 3 ? screen[id - 3] : corner[id], 0.0, 1.0);
}`

const TRI_FRAG = `#version 300 es
precision highp float;
flat in int vSide;
out vec4 fragColor;
void main() { fragColor = vSide == 1 ? vec4(0.0, 1.0, 0.0, 1.0) : vec4(1.0, 0.0, 0.0, 1.0); }`

const SOURCE = {
    name: 'triSource',
    func: 'triSource',
    // The mesh texture the screen count derives from: 2x3 texels = 6 vertices.
    textures: { meshTex: { width: 2, height: 3, format: 'rgba8unorm' } },
    outputTex: 'meshTex',
    passes: [{ name: 'fill', program: 'fill', outputs: { fragColor: 'meshTex' } }],
}

const PROBE = {
    name: 'triScreen',
    func: 'triScreen',
    passes: [
        { name: 'clear', program: 'clear', inputs: {}, outputs: { fragColor: 'outputTex' } },
        {
            name: 'draw',
            program: 'draw',
            drawMode: 'triangles',
            count: 'screen',
            blend: false,
            inputs: { meshPositions: 'inputTex' },
            outputs: { fragColor: 'outputTex' },
        },
    ],
}

test('a screen-count triangle pass draws one vertex per texel of its mesh texture', async ({ page }) => {
    const bootErrors = await boot(page)
    const pageErrors = []
    page.on('pageerror', err => pageErrors.push(err.message))
    const result = await page.evaluate(async ({ source, probe, shaders }) => {
        const tl = window.__timeline
        const raw = {
            name: 'Screen-count triangles',
            sequences: { main: { width: 960, height: 540, fps: 30, duration: 4, tracks: [], post: { enabled: false } } },
            effects: {
                triSource: { definition: source, shaders: { fill: { glsl: shaders.fill } } },
                triScreen: { definition: probe, shaders: { clear: { glsl: shaders.clear }, draw: { glsl: shaders.frag, vertex: shaders.vert } } },
            },
        }
        const { normalizeProject } = await import('/js/model/normalize.js')
        const { project, problems } = normalizeProject(raw)
        await tl.actions.openProject(project, { problems })
        tl.store.edit('plain', s => { s.post.enabled = false })
        tl.store.edit('probe', s => {
            const track = tl.edits.addTrack(s, 'visual')
            tl.edits.insertClip(track, tl.model.createProgramClip({
                start: 0, duration: 4, dsl: 'search user\ntriSource().triScreen().write(o0)\nrender(o0)',
            }))
        })
        const shot = await tl.snapshot({ times: [1], scale: 0.25 })
        const bitmap = await createImageBitmap(new Blob([shot.frames[0].bytes], { type: 'image/png' }))
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        canvas.getContext('2d').drawImage(bitmap, 0, 0)
        const read = (x, y) => [...canvas.getContext('2d').getImageData(x, y, 1, 1).data.slice(0, 3)]
        return {
            left: read(10, 10),
            right: read(bitmap.width - 11, 10),
            registered: Object.keys(tl.store.project.effects || {}),
            check: await tl.check(),
        }
    }, {
        source: SOURCE,
        probe: PROBE,
        shaders: { clear: CLEAR_GLSL, fill: CLEAR_GLSL, frag: TRI_FRAG, vert: TRI_VERT },
    })
    // Six vertices from the 2x3 mesh texture: red on the left, green on the
    // right. One fallback triangle or no draw leaves either probe black.
    result.left.forEach((value, channel) => expect(Math.abs(value - [255, 0, 0][channel]), `left channel ${channel}`).toBeLessThanOrEqual(1))
    result.right.forEach((value, channel) => expect(Math.abs(value - [0, 255, 0][channel]), `right channel ${channel}`).toBeLessThanOrEqual(1))
    expect(result.registered).toEqual(['triSource', 'triScreen'])
    expect(result.check.errors).toEqual([])
    expect(bootErrors).toEqual([])
    expect(pageErrors).toEqual([])
})
