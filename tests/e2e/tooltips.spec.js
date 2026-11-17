import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

const nativeTitles = page => page.evaluate(() => [...document.querySelectorAll('[title]')]
    .filter(el => el.tagName !== 'IFRAME')
    .map(el => el.outerHTML.slice(0, 120)))

async function expectHandfishTooltip(page, locator, text) {
    await expect(locator).toHaveClass(/\btooltip\b/)
    await expect(locator).toHaveAttribute('data-title', text)
    expect(await locator.getAttribute('title')).toBeNull()
    await locator.hover()
    await expect(page.locator('#hf-tooltip-layer[data-visible="true"]')).toHaveText(text)
}

test('every hover tooltip goes through Handfish and no element keeps a native title', async ({ page }) => {
    await boot(page)
    expect(await nativeTitles(page)).toEqual([])
    await expectHandfishTooltip(page, page.locator('.tl-monitor .tl-transport [aria-label="Play or pause (Space)"]'), 'Play or pause (Space)')
    await expectHandfishTooltip(page, page.locator('.tl-monitor [aria-label="Full screen"]'), 'Full screen (F)')
    await expectHandfishTooltip(page, page.locator('.tl-track-btn[aria-label="Add video track"]'), 'Add video track')
    const card = page.locator('.tl-card').first()
    const name = (await card.locator('.tl-card-title').textContent()).trim()
    await expectHandfishTooltip(page, card, `${name}: drag to the timeline`)
})

// The tooltip's natural width: its text on one layer with no viewport edge,
// limited by the inline max-width Handfish sets from the viewport.
const tooltipBox = layer => layer.evaluate((el) => {
    const probe = el.cloneNode(true)
    Object.assign(probe.style, { position: 'fixed', left: '0px', top: '0px', transform: 'none', width: 'max-content', maxWidth: el.style.maxWidth, visibility: 'hidden' })
    document.body.appendChild(probe)
    const natural = probe.getBoundingClientRect().width
    probe.remove()
    const rect = el.getBoundingClientRect()
    return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, natural, vw: document.documentElement.clientWidth, vh: innerHeight }
})

for (const viewport of [{ width: 1000, height: 600 }, { width: 480, height: 640 }]) {
    test(`tooltips keep their natural width at the page edges at ${viewport.width}x${viewport.height}`, async ({ page }) => {
        await page.setViewportSize(viewport)
        await boot(page, { demo: false })
        const text = 'Find the tempo and first beat of this sequence’s audio'
        const probes = { centre: 'left:50%;top:50%', left: 'left:0;top:50%', right: 'right:0;top:50%', 'bottom-right': 'right:0;bottom:0' }
        await page.evaluate(({ text, probes }) => {
            for (const [name, css] of Object.entries(probes)) {
                const el = document.createElement('div')
                el.className = 'tooltip edge-probe'
                el.dataset.probe = name
                el.dataset.title = text
                el.style.cssText = `position:fixed;${css};width:12px;height:12px;z-index:2147483647`
                document.body.appendChild(el)
            }
        }, { text, probes })
        for (const name of Object.keys(probes)) {
            await page.locator(`.edge-probe[data-probe="${name}"]`).hover()
            const layer = page.locator('#hf-tooltip-layer[data-visible="true"]')
            await expect(layer).toHaveText(text)
            const box = await tooltipBox(layer)
            expect(box.left, name).toBeGreaterThanOrEqual(0)
            expect(box.top, name).toBeGreaterThanOrEqual(0)
            expect(box.right, name).toBeLessThanOrEqual(box.vw)
            expect(box.bottom, name).toBeLessThanOrEqual(box.vh)
            expect(Math.abs(box.width - box.natural), `${name}: width ${box.width} vs natural ${box.natural}`).toBeLessThan(1)
        }
    })
}
