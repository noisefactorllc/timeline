/**
 * Tooltip text for elements built in code.
 *
 * Handfish shows the tooltip for any `.tooltip` element from its
 * `data-title` (falling back to `aria-label`) and keeps it on screen at the
 * page edges. A native `title` would also raise the browser's own unstyled
 * tooltip, so it is never set; an existing one is removed.
 */
export function setTooltip(el, text) {
    if (!el) return
    if (text == null || text === '') {
        delete el.dataset.title
        el.classList.remove('tooltip')
        return
    }
    el.dataset.title = String(text)
    el.classList.add('tooltip')
    el.removeAttribute('title')
}
