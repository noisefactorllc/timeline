// The agent guide at timeline.noisedeck.app is the plugin's skill, fetched
// tool and all: it must match a fresh render and name no plugin-only path.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { access, readFile } from 'node:fs/promises'
import { LLMS_FULL_PATH, LLMS_PATH, renderLlms, renderLlmsFull } from '../../scripts/build-llms.mjs'
import { normalizeProject } from '../../js/model/normalize.js'

test('llms.txt and llms-full.txt match a fresh render (run node scripts/build-llms.mjs)', async () => {
    assert.equal(await readFile(LLMS_PATH, 'utf8'), await renderLlms())
    assert.equal(await readFile(LLMS_FULL_PATH, 'utf8'), await renderLlmsFull())
})

test('the guide fetches the tool the site serves, and carries the schema', async () => {
    const llms = await readFile(LLMS_PATH, 'utf8')
    assert.match(llms, /curl -fsSLO https:\/\/timeline\.noisedeck\.app\/cli\/timeline\.mjs/)
    assert.doesNotMatch(llms, /<base>|<cli>/)
    await access(new URL('../../cli/timeline.mjs', import.meta.url))
    const schema = JSON.parse(await readFile(new URL('../../schema/project.schema.json', import.meta.url), 'utf8'))
    assert.ok((await readFile(LLMS_FULL_PATH, 'utf8')).includes(JSON.stringify(schema, null, 2).slice(0, 200)))
})

test('an audio clip without start satisfies the schema and uses the runtime default', async () => {
    const schema = JSON.parse(await readFile(new URL('../../schema/project.schema.json', import.meta.url), 'utf8'))
    const clip = { mediaId: 'song' }
    const { project, problems } = normalizeProject({
        media: { song: { path: 'media/song.flac', duration: 8 } },
        sequences: { main: { duration: 8, audioTracks: [{ clips: [clip] }] } },
    })
    assert.deepEqual(problems, [])
    const normalized = project.sequences.main.audioTracks[0].clips[0]
    assert.equal(normalized.start, 0)
    assert.deepEqual(schema.$defs.audioClip.required.filter(key => !Object.hasOwn(clip, key)), [])
    assert.ok(schema.$defs.audioClip.required.includes('mediaId'))
    assert.equal(schema.$defs.audioClip.properties.start.default, normalized.start)
})
