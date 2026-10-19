/**
 * Writes llms.txt and llms-full.txt, the contract an agent reads at
 * https://timeline.noisedeck.app. Both come from the Claude Code plugin's
 * skill (skills/timeline/SKILL.md), so the plugin and the site teach the same
 * thing: llms.txt is the skill with the tool fetched from the site instead of
 * the plugin folder, and llms-full.txt adds the project schema.
 *
 * Run `node scripts/build-llms.mjs` after you change the skill or the schema.
 * tests/unit/llms.test.js fails when either file is stale.
 */
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const at = (path) => fileURLToPath(new URL(`../${path}`, import.meta.url))
export const SKILL_PATH = at('skills/timeline/SKILL.md')
export const SCHEMA_PATH = at('schema/project.schema.json')
export const LLMS_PATH = at('llms.txt')
export const LLMS_FULL_PATH = at('llms-full.txt')

const SITE = 'https://timeline.noisedeck.app'

// Each replacement must match the skill exactly once, so a change to the
// skill's wording fails the build here instead of shipping a stale contract.
function replaceOnce(text, find, replace) {
    const count = text.split(find).length - 1
    if (count !== 1) throw new Error(`build-llms: expected one match for ${JSON.stringify(find)}, found ${count}`)
    return text.replace(find, replace)
}

const INTRO = `# Timeline -- Agent guide

> Timeline (${SITE}) is the Noise Factor audio reactive video editor. It cuts
> Noisemaker programs, text, images and video to music, and exports MP4 or
> WebM. An agent makes a video by writing a project folder that the person
> opens in Timeline, and checks, snapshots and renders it with a command-line
> tool. This file is everything the agent needs; it is the same guide as the
> Timeline plugin for Claude Code.

The full guide adds the project schema: ${SITE}/llms-full.txt

Agents in Claude Code can install the plugin instead of reading this file:
\`/plugin marketplace add noisefactorllc/timeline\`, then
\`/plugin install timeline@noisefactor-timeline\`.

Other Noise Factor apps an agent can control: Noisedeck
(https://noisedeck.app/llms-full.txt), Polymorphic
(https://polymorphic.noisedeck.app/llms.txt), Visualize
(https://visualize.noisedeck.app/llms.txt) and HD4
(https://hd4.noisefactor.io/llms.txt).
`

const PROGRAMS_FROM_APPS = `
## Programs from the person's other apps

A clip's \`dsl\` is a Noisemaker program, the same language that Noisedeck,
Polymorphic, Visualize and HD4 run. When the person has Noisedeck, Polymorphic
or Visualize online, the Seance agent tool reads and writes its program
(https://noisedeck.app/llms-full.txt explains how to get it and join):

- Use a program from the app in a clip: \`node seance-agent.mjs program noisedeck\`,
  then put the text in the clip's \`dsl\`.
- Send a clip's program to the app: \`node seance-agent.mjs set polymorphic clip.dsl\`.
- An image the program names as \`image:<sha256>\`:
  \`node seance-agent.mjs image-get noisedeck <sha256> --out media/name\` saves it
  into the folder; refer to it in Timeline by its \`path\` in \`media\`.

\`check\` tells you when a program uses an effect or an argument that Timeline does
not have.
`

export async function renderLlms() {
    let skill = await readFile(SKILL_PATH, 'utf8')
    skill = skill.replace(/^---\n[\s\S]*?\n---\n+/, '')
    // The guide has its own title; the skill's sections follow it.
    skill = replaceOnce(skill, '# Making videos with Timeline\n\n', '')
    skill = replaceOnce(skill,
        "The tool is `cli/timeline.mjs`, two folders up from this skill's base directory: `<base>/../../cli/timeline.mjs`. It needs Node 22 or later and Google Chrome (set `CHROME_PATH` for another Chromium). It has no other dependencies.",
        `Get the tool with \`curl -fsSLO ${SITE}/cli/timeline.mjs\` and run it as \`node timeline.mjs\`. It needs Node 22 or later and Google Chrome (set \`CHROME_PATH\` for another Chromium). It has no other dependencies. It runs the real Timeline in Chrome on this computer and answers Chrome's requests for the folder's files from disk, so nothing is uploaded.`)
    skill = skill.replaceAll('node <cli>', 'node timeline.mjs')
    skill = replaceOnce(skill,
        'is the JSON schema at `<base>/../../schema/project.schema.json` (also at https://timeline.noisedeck.app/schema/project.schema.json).',
        `is the JSON schema at ${SITE}/schema/project.schema.json, which ${SITE}/llms-full.txt also contains.`)
    if (skill.includes('<cli>') || skill.includes('<base>')) {
        throw new Error('build-llms: the skill still names a path inside the plugin')
    }
    return `${INTRO}\n${skill.trimEnd()}\n${PROGRAMS_FROM_APPS}`
}

export async function renderLlmsFull() {
    const schema = await readFile(SCHEMA_PATH, 'utf8')
    return `${(await renderLlms()).trimEnd()}\n\n---\n\n## The project schema\n\nThis is ${SITE}/schema/project.schema.json.\n\n\`\`\`json\n${schema.trimEnd()}\n\`\`\`\n`
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    await writeFile(LLMS_PATH, await renderLlms())
    await writeFile(LLMS_FULL_PATH, await renderLlmsFull())
}
