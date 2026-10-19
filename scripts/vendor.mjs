// Copy the browser builds of the app's libraries from node_modules into
// js/lib, so the site loads nothing from third-party hosts. Run after a
// version change in package.json: npm install && npm run vendor
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lib = join(root, 'js', 'lib')
mkdirSync(lib, { recursive: true })

const version = name => JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8')).version

// mediabunny's bundle carries its MPL-2.0 notice.
writeFileSync(join(lib, 'mediabunny.min.mjs'), readFileSync(join(root, 'node_modules/mediabunny/dist/bundles/mediabunny.min.mjs')))

// fflate's ESM build has no notice of its own; MIT asks for one.
const notice = readFileSync(join(root, 'node_modules/fflate/LICENSE'), 'utf8').split('\n').find(l => l.startsWith('Copyright'))
writeFileSync(join(lib, 'fflate.mjs'), `/*! fflate ${version('fflate')} | MIT License | ${notice} */\n${readFileSync(join(root, 'node_modules/fflate/esm/browser.js'), 'utf8')}`)

console.log(`vendored mediabunny ${version('mediabunny')} and fflate ${version('fflate')} into js/lib`)
