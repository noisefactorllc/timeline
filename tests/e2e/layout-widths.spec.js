import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

// Controls the viewport cuts off at this width. Content of a scrolling container may lie
// outside the window by design; a control a non-scrolling box or the window cuts off may not.
// The search stops below <body>: its overflow: hidden is the window edge itself.
const cutOffControls = page => page.evaluate(() => {
    const vw = document.documentElement.clientWidth
    const out = []
    for (const el of document.querySelectorAll('button, input, select, textarea, a[href], [role="button"], [role="slider"], [role="menuitem"], [tabindex]:not([tabindex="-1"])')) {
        if (el.closest('[hidden], .tl-narrow')) continue
        const style = getComputedStyle(el)
        if (style.display === 'none' || style.visibility === 'hidden') continue
        const r = el.getBoundingClientRect()
        if (r.width < 1 || r.height < 1) continue
        let exempt = false
        for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
            const s = getComputedStyle(a)
            if (/auto|scroll/.test(s.overflowX)) { exempt = true; break }
            const ar = a.getBoundingClientRect()
            if (s.overflowX !== 'visible' && (r.left >= ar.right || r.right <= ar.left)) { exempt = true; break }
        }
        if (!exempt && (r.right > vw + 0.5 || r.left < -0.5)) {
            out.push(`${el.getAttribute('aria-label') || el.className || el.tagName} ${Math.round(r.left)}-${Math.round(r.right)}`)
        }
    }
    return out
})

// Above the narrow-screen notice (max-width: 760px) the whole editor fits the window.
test('every control stays inside the viewport at each width from 761px to 1000px', async ({ page }) => {
    test.slow()
    await boot(page)
    const offenders = []
    for (let width = 761; width <= 1000; width++) {
        await page.setViewportSize({ width, height: 600 })
        await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
        await expect(page.locator('.tl-narrow')).toBeHidden()
        const out = await cutOffControls(page)
        if (out.length) offenders.push(`${width}px: ${out.join(', ')}`)
    }
    expect(offenders).toEqual([])
})
