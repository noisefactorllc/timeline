/**
 * A small context menu built on the handfish menu styles. One open at a
 * time; Escape, a click elsewhere, scrolling or choosing an item closes it.
 */

import { registerEscapeable, unregisterEscapeable } from 'handfish'

let open = null

function close() {
    if (!open) return
    const { el, onDoc } = open
    unregisterEscapeable(el)
    document.removeEventListener('pointerdown', onDoc, true)
    window.removeEventListener('blur', close)
    el.remove()
    open = null
}

/**
 * Show a menu at a pointer position.
 * @param {number} x
 * @param {number} y
 * @param {Array<{label?: string, onSelect?: Function, disabled?: boolean, checked?: boolean, separator?: boolean, danger?: boolean, shortcut?: string}>} items
 */
export function showContextMenu(x, y, items) {
    close()
    const el = document.createElement('div')
    el.className = 'hf-menu tl-context-menu'
    el.setAttribute('role', 'menu')
    for (const item of items) {
        if (item.separator) {
            el.append(Object.assign(document.createElement('div'), { className: 'hf-menu-separator', role: 'separator' }))
            continue
        }
        const b = document.createElement('button')
        b.type = 'button'
        b.className = `hf-menu-item${item.danger ? ' hf-menu-item-destructive' : ''}`
        b.setAttribute('role', item.checked === undefined ? 'menuitem' : 'menuitemradio')
        if (item.checked !== undefined) b.setAttribute('aria-checked', String(!!item.checked))
        const label = document.createElement('span')
        label.textContent = `${item.checked ? '✓ ' : ''}${item.label}`
        b.append(label)
        if (item.shortcut) {
            const s = document.createElement('span')
            s.className = 'hf-menu-shortcut'
            s.textContent = item.shortcut
            b.append(s)
        }
        if (item.disabled) {
            b.disabled = true
            b.setAttribute('aria-disabled', 'true')
        }
        b.addEventListener('click', () => {
            close()
            item.onSelect?.()
        })
        el.append(b)
    }
    el.addEventListener('keydown', e => {
        const buttons = [...el.querySelectorAll('button:not(:disabled)')]
        const i = buttons.indexOf(document.activeElement)
        if (e.key === 'ArrowDown') {
            e.preventDefault()
            buttons[(i + 1) % buttons.length]?.focus()
        } else if (e.key === 'ArrowUp') {
            e.preventDefault()
            buttons[(i - 1 + buttons.length) % buttons.length]?.focus()
        }
    })
    document.body.append(el)
    const rect = el.getBoundingClientRect()
    el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 4))}px`
    el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 4))}px`
    const onDoc = e => {
        if (!el.contains(e.target)) close()
    }
    document.addEventListener('pointerdown', onDoc, true)
    window.addEventListener('blur', close)
    registerEscapeable(el, close)
    open = { el, onDoc }
    el.querySelector('button:not(:disabled)')?.focus()
}

export function closeContextMenu() {
    close()
}
