import { test, expect } from '@playwright/test'
import { boot } from './helpers.js'

// Help > Copy the Timeline skill prompt puts on the clipboard the prompt a
// person pastes into their agent: read the agent guide this site publishes,
// and follow it.

const PROMPT = [
    'Learn the Timeline skill so you can make videos with me in Timeline.',
    'Read https://timeline.noisedeck.app/llms.txt first, and follow it.',
].join('\n')

test('Help copies the prompt that teaches an agent the Timeline skill', async ({ page, context, baseURL }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(baseURL).origin })
    const errors = await boot(page, { demo: false })
    await page.evaluate(() => navigator.clipboard.writeText('before'))

    await page.locator('#menu .hf-menubar-trigger', { hasText: 'help' }).click()
    const item = page.locator('#copySkillPrompt')
    await expect(item).toHaveText('Copy the Timeline skill prompt')
    await item.click()

    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(PROMPT)
    await expect(page.locator('.hf-toast')).toContainText('Prompt copied. Paste it into your agent to teach it the Timeline skill.')
    expect(errors).toEqual([])
})

test('the prompt names the agent guide this site publishes', async ({ request }) => {
    const guide = await request.get('/llms.txt')
    expect(guide.status()).toBe(200)
    expect((await guide.text()).split('\n')[0]).toBe('# Timeline -- Agent guide')
    expect(PROMPT).toContain('https://timeline.noisedeck.app/llms.txt')
})
