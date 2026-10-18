/**
 * Small in-app dialogs for a name or a yes/no decision, built on the
 * handfish dialog styles and the shared Escape stack. The app never uses
 * the browser's built-in alert, confirm or prompt.
 */

import { registerEscapeable, unregisterEscapeable } from 'handfish'

function el(tag, className, attrs = {}) {
    const node = document.createElement(tag)
    if (className) node.className = className
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined) continue
        if (k === 'text') node.textContent = v
        else node.setAttribute(k, v)
    }
    return node
}

function show(build) {
    return new Promise(resolve => {
        const dialog = el('dialog', 'hf-dialog tl-dialog')
        document.body.append(dialog)
        let settled = false
        const finish = value => {
            if (settled) return
            settled = true
            unregisterEscapeable(dialog)
            dialog.close()
            dialog.remove()
            resolve(value)
        }
        dialog.addEventListener('cancel', e => {
            e.preventDefault()
            finish(null)
        })
        build(dialog, finish)
        dialog.showModal()
        registerEscapeable(dialog, () => finish(null))
    })
}

/** Ask for a line of text. Resolves to the text, or null when cancelled. */
export function askText({ title, label, value = '', action = 'Save' }) {
    return show((dialog, finish) => {
        const form = el('form', '')
        form.method = 'dialog'
        const body = el('div', 'hf-dialog-body')
        const f = el('label', 'tl-field')
        const input = el('input', '', { type: 'text', spellcheck: 'false' })
        input.value = value
        f.append(el('span', '', { text: label }), input)
        body.append(f)
        const actions = el('div', 'tl-dialog-actions')
        const cancel = el('button', 'tl-button', { type: 'button', text: 'Cancel' })
        cancel.addEventListener('click', () => finish(null))
        const ok = el('button', 'tl-button is-primary', { type: 'submit', text: action })
        actions.append(cancel, ok)
        form.append(el('h2', 'hf-dialog-title', { text: title }), body, actions)
        form.addEventListener('submit', e => {
            e.preventDefault()
            finish(input.value.trim() || null)
        })
        dialog.append(form)
        queueMicrotask(() => {
            input.focus()
            input.select()
        })
    })
}

/** Ask a yes/no question. Resolves to true or false. */
export function askConfirm({ title, message, action = 'Continue', danger = false }) {
    return show((dialog, finish) => {
        const body = el('div', 'hf-dialog-body')
        body.append(el('p', 'tl-export-note', { text: message }))
        const actions = el('div', 'tl-dialog-actions')
        const cancel = el('button', 'tl-button', { type: 'button', text: 'Cancel' })
        cancel.addEventListener('click', () => finish(false))
        const ok = el('button', `tl-button ${danger ? 'is-danger' : 'is-primary'}`, { type: 'button', text: action })
        ok.addEventListener('click', () => finish(true))
        actions.append(cancel, ok)
        dialog.append(el('h2', 'hf-dialog-title', { text: title }), body, actions)
        queueMicrotask(() => ok.focus())
    }).then(v => v === true)
}
