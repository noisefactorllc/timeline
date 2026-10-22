import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GOOD = 'search synth, filter\ncell(scale: 20)\n  .write(o0)\nrender(o0)'
const BROKEN = 'search synth, filter\nclel(scale: 20)\n  .write(o0)\nrender(o0)'

function run(args) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, ['cli/timeline.mjs', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
        let stdout = ''
        let stderr = ''
        child.stdout.on('data', d => { stdout += d })
        child.stderr.on('data', d => { stderr += d })
        child.on('exit', status => resolve({ status, stdout, stderr }))
    })
}

function writeProject(dir, dsl) {
    writeFileSync(join(dir, 'project.json'), JSON.stringify({
        name: 'CLI test',
        media: { drums: { path: 'media/drums.flac' } },
        sequences: {
            main: {
                duration: 4,
                tracks: [{ clips: [{ name: 'Cells', start: 0, duration: 4, dsl }] }],
                audioTracks: [{ clips: [{ mediaId: 'drums', start: 0 }] }],
            },
        },
    }))
}

test('the command line checks a project folder and renders frames of it', async ({ baseURL }) => {
    const dir = mkdtempSync(join(tmpdir(), 'timeline-cli-test-'))
    try {
        mkdirSync(join(dir, 'media'))
        copyFileSync('media/refinery-drums.flac', join(dir, 'media', 'drums.flac'))
        const url = `${baseURL}/`

        writeProject(dir, BROKEN)
        const failed = await run(['check', dir, '--url', url, '--json'])
        expect(failed.status, failed.stderr).toBe(1)
        const report = JSON.parse(failed.stdout)
        expect(report.errors.map(e => e.where)).toEqual(['main › V1 › "Cells" at 00:00:00:00'])
        expect(report.sequences).toEqual([{ id: 'main', name: 'main', size: '1920x1080', fps: 30, duration: 4, bpm: 120, clips: 1, audioClips: 1 }])

        writeProject(dir, GOOD)
        const passed = await run(['check', dir, '--url', url])
        expect(passed.status, passed.stdout + passed.stderr).toBe(0)
        expect(passed.stdout.trim().split('\n').at(-1)).toBe('ok')

        const shot = await run(['snapshot', dir, '--url', url, '--at', '1,0:02.5', '--scale', '0.25', '--json'])
        expect(shot.status, shot.stderr).toBe(0)
        const { frames, width, height } = JSON.parse(shot.stdout)
        expect([width, height]).toEqual([480, 270])
        expect(frames.map(f => f.timecode)).toEqual(['00:00:01:00', '00:00:02:15'])
        for (const f of frames) {
            const png = readFileSync(f.path)
            expect(png.subarray(1, 4).toString()).toBe('PNG')
            expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([480, 270])
        }

        const video = await run(['render', dir, '--url', url, '--to', '1', '--scale', '0.25', '--json'])
        expect(video.status, video.stderr).toBe(0)
        const rendered = JSON.parse(video.stdout)
        expect(rendered.frames).toBe(30)
        expect([rendered.width, rendered.height]).toEqual([480, 270])
        const bytes = readFileSync(rendered.path)
        expect(bytes.length).toBe(rendered.size)
        expect(bytes.subarray(4, 8).toString()).toBe('ftyp')

        const missing = await run(['check', join(dir, 'nope'), '--url', url])
        expect(missing.status).toBe(1)
        expect(missing.stderr).toContain('project.json does not exist')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the command line runs a project with a custom effect kept as files in its folder', async ({ baseURL }) => {
    const dir = mkdtempSync(join(tmpdir(), 'timeline-cli-effect-'))
    try {
        mkdirSync(join(dir, 'effects', 'flipTone', 'glsl'), { recursive: true })
        writeFileSync(join(dir, 'effects', 'flipTone', 'definition.json'), JSON.stringify({
            name: 'Flip tone',
            passes: [{ name: 'render', program: 'flip', inputs: { inputTex: 'inputTex' }, outputs: { fragColor: 'outputTex' } }],
        }))
        copyFileSync('tests/fixtures/flip-tone.glsl', join(dir, 'effects', 'flipTone', 'glsl', 'flip.glsl'))
        const project = {
            effects: { flipTone: { path: 'effects/flipTone' }, broken: { path: 'effects/broken' } },
            sequences: { main: { duration: 2, post: { enabled: false }, tracks: [{ clips: [
                { start: 0, duration: 2, dsl: 'search synth, filter, user\nnoise()\n  .flipTone()\n  .write(o0)\nrender(o0)' },
            ] }] } },
        }
        writeFileSync(join(dir, 'project.json'), JSON.stringify(project))
        const url = `${baseURL}/`
        const failed = await run(['check', dir, '--url', url, '--json'])
        const report = JSON.parse(failed.stdout)
        expect(report.errors.map(e => `${e.where}: ${e.message}`)).toEqual(['effect "broken": effects/broken/definition.json could not be read'])

        delete project.effects.broken
        writeFileSync(join(dir, 'project.json'), JSON.stringify(project))
        const passed = await run(['check', dir, '--url', url])
        expect(passed.status, passed.stdout + passed.stderr).toBe(0)
        const shot = await run(['snapshot', dir, '--url', url, '--at', '1', '--scale', '0.25', '--json'])
        expect(shot.status, shot.stderr).toBe(0)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the command line does not serve a symlink outside the project folder', async ({ baseURL }) => {
    const dir = mkdtempSync(join(tmpdir(), 'timeline-cli-boundary-'))
    try {
        const project = join(dir, 'project')
        mkdirSync(join(project, 'media'), { recursive: true })
        copyFileSync('media/refinery-drums.flac', join(dir, 'outside.flac'))
        symlinkSync(join(dir, 'outside.flac'), join(project, 'media', 'drums.flac'))
        writeProject(project, GOOD)

        const result = await run(['check', project, '--url', `${baseURL}/`, '--json'])
        expect(result.status, result.stderr).toBe(1)
        expect(JSON.parse(result.stdout).errors.some(error => error.where === 'media "drums"')).toBe(true)
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})

test('the command line fails a check when the page throws an exception', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'timeline-cli-page-error-'))
    const server = createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html')
        response.end(`<script>
            window.__timeline = {
                ready: true,
                check: () => new Promise(resolve => {
                    setTimeout(() => { throw new Error('check page failure') }, 0)
                    setTimeout(() => resolve({ project: 'CLI test', sequences: [], programs: 0, errors: [], warnings: [], ok: true }), 100)
                }),
            }
        </script>`)
    })
    try {
        writeFileSync(join(dir, 'project.json'), '{}')
        await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
        const url = `http://127.0.0.1:${server.address().port}/`
        const result = await run(['check', dir, '--url', url, '--json'])
        expect(result.status, result.stderr).toBe(1)
        const report = JSON.parse(result.stdout)
        expect(report.ok).toBe(false)
        expect(report.pageErrors.join('\n')).toContain('check page failure')
        expect(report.errors.some(error => error.where === 'page' && error.message.includes('check page failure'))).toBe(true)
    } finally {
        await new Promise(resolve => server.close(resolve))
        rmSync(dir, { recursive: true, force: true })
    }
})
