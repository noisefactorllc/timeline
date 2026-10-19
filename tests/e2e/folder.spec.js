import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

const DSL = 'search synth, filter\nnoise(octaves: 3, ridges: true, colorMode: rgb)\n  .write(o0)\nrender(o0)'

function folderProject(clipName) {
    return {
        name: 'Folder test',
        media: { drums: { path: 'media/drums.flac' } },
        sequences: {
            main: {
                duration: 8,
                bpm: 128,
                tracks: [{ clips: [{ id: 'a', name: clipName, start: 0, duration: 8, dsl: DSL }] }],
                audioTracks: [{ name: 'Drums', clips: [{ mediaId: 'drums', start: 0, duration: 8 }] }],
            },
        },
    }
}

// The folder is a directory in the origin-private file system, standing in for one the user picks.
async function writeProjectJson(page, project) {
    await page.evaluate(async json => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('folder-test', { create: true })
        const writable = await (await dir.getFileHandle('project.json', { create: true })).createWritable()
        await writable.write(json)
        await writable.close()
    }, JSON.stringify(project, null, 2))
}

async function readProjectJson(page) {
    return page.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('folder-test')
        return JSON.parse(await (await (await dir.getFileHandle('project.json')).getFile()).text())
    })
}

test('a project folder opens, follows changes made on disk, and saves edits back to it', async ({ page }) => {
    await page.addInitScript(() => {
        window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('folder-test', { create: true })
    })
    const errors = await boot(page)
    await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory()
        await root.removeEntry('folder-test', { recursive: true }).catch(() => {})
        const media = await (await root.getDirectoryHandle('folder-test', { create: true })).getDirectoryHandle('media', { create: true })
        const writable = await (await media.getFileHandle('drums.flac', { create: true })).createWritable()
        await writable.write(await (await fetch('/media/refinery-drums.flac')).blob())
        await writable.close()
    })
    await writeProjectJson(page, folderProject('Storm'))

    await page.evaluate(() => window.__timeline.actions.openFolder())
    await expect(page.locator('.tl-clip', { hasText: 'Storm' })).toBeVisible()
    await expect(page.locator('.tl-clip', { hasText: 'Drums' })).toBeVisible()
    // The audio decodes from the file in the folder.
    await expect.poll(() => page.evaluate(async () => {
        const { cachedAudioBuffer } = await import('/js/audio/media.js')
        return cachedAudioBuffer(window.__timeline.store.project.media.drums)?.duration || 0
    }), { timeout: 60_000 }).toBeGreaterThan(59)
    // Opening the folder does not rewrite what was written there.
    expect((await readProjectJson(page)).sequences.main.tracks[0].clips[0]).toEqual(folderProject('Storm').sequences.main.tracks[0].clips[0])

    // A change on disk appears in the editor, and Undo goes back to the version before it.
    await writeProjectJson(page, folderProject('Squall'))
    await expect(page.locator('.tl-clip', { hasText: 'Squall' })).toBeVisible({ timeout: 10_000 })
    await page.evaluate(() => window.__timeline.store.undo())
    await expect(page.locator('.tl-clip', { hasText: 'Storm' })).toBeVisible()

    // An edit here, the undo included, is written back to the folder.
    await expect.poll(async () => (await readProjectJson(page)).sequences.main.tracks[0].clips[0].name, { timeout: 10_000 }).toBe('Storm')
    await page.evaluate(() => window.__timeline.store.edit('rename', s => { s.tracks[0].clips[0].name = 'Gale' }))
    await expect.poll(async () => (await readProjectJson(page)).sequences.main.tracks[0].clips[0].name, { timeout: 10_000 }).toBe('Gale')
    const saved = await readProjectJson(page)
    expect(saved.sequences.main.tracks[0].clips[0].dsl).toBe(DSL)
    expect(saved.media.drums.path).toBe('media/drums.flac')
    expect(errors).toEqual([])
})

test('a project folder that cannot work as written says why when it opens', async ({ page }) => {
    await page.addInitScript(() => {
        window.showDirectoryPicker = async () => (await navigator.storage.getDirectory()).getDirectoryHandle('folder-test', { create: true })
    })
    await boot(page)
    const broken = folderProject('Storm')
    broken.sequences.main.audioTracks[0].clips[0].mediaId = 'missing'
    await page.evaluate(async () => {
        await (await navigator.storage.getDirectory()).removeEntry('folder-test', { recursive: true }).catch(() => {})
    })
    await writeProjectJson(page, broken)
    await page.evaluate(() => window.__timeline.actions.openFolder())
    await expect(page.locator('.tl-clip', { hasText: 'Storm' })).toBeVisible()
    await expect(page.getByText(/Opened the folder folder-test, with 1 problem\. main › Drums › "missing": mediaId "missing"/)).toBeVisible()
    const report = await page.evaluate(() => window.__timeline.check())
    expect(report.ok).toBe(false)
    // This folder also lacks the drums file that project.json lists.
    expect(report.errors.map(e => `${e.where}: ${e.message}`)).toEqual([
        'main › Drums › "missing": mediaId "missing" names nothing under "media"; the clip is silent',
        'media "drums": media/drums.flac is missing from folder-test',
    ])
})
