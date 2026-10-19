import { test, expect } from '@playwright/test'
import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

        const missing = await run(['check', join(dir, 'nope'), '--url', url])
        expect(missing.status).toBe(1)
        expect(missing.stderr).toContain('project.json does not exist')
    } finally {
        rmSync(dir, { recursive: true, force: true })
    }
})
