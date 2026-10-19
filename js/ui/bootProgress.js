/**
 * The boot screen: an overall progress bar with its percent, a status line
 * naming what is happening now, and one row per boot step with its own
 * detail (bytes downloaded, programs compiled). Steps can run at the same
 * time; the status line names the earliest one still running.
 */

const STEPS = {
    engine: { weight: 0.25, doing: 'Loading the Noisemaker engine' },
    editor: { weight: 0.05, doing: 'Starting the editor' },
    project: { weight: 0.05, doing: 'Opening your project' },
    audio: { weight: 0.35, doing: 'Loading the soundtrack' },
    programs: { weight: 0.3, doing: 'Compiling the programs at the playhead' },
}

export function formatBytes(bytes) {
    if (bytes < 1048576) return `${Math.max(1, Math.round(bytes / 1024))} KB`
    return `${(bytes / 1048576).toFixed(1)} MB`
}

export class BootProgress {
    constructor(root) {
        this.root = root
        this.bar = root.querySelector('.tl-progress')
        this.percent = root.querySelector('.tl-boot-percent')
        this.status = root.querySelector('.tl-boot-status')
        this.rows = new Map([...root.querySelectorAll('[data-step]')].map(row => [row.dataset.step, row]))
        this.steps = Object.fromEntries(Object.keys(STEPS).map(id => [id, { fraction: 0, state: 'pending' }]))
        this.failed = false
    }

    start(id, detail = '') {
        this._set(id, { state: 'active', fraction: 0, detail })
    }

    progress(id, fraction, detail) {
        this._set(id, { state: 'active', fraction: Math.max(0, Math.min(1, fraction)), detail })
    }

    done(id, detail) {
        this._set(id, { state: 'done', fraction: 1, detail })
    }

    fail(message) {
        this.failed = true
        for (const [id, step] of Object.entries(this.steps)) {
            if (step.state === 'active') this._set(id, { state: 'error' })
        }
        this.status.classList.add('is-error')
        this.status.textContent = message
    }

    /** Fade the boot screen out once the app is ready. */
    finish() {
        this.root.classList.add('is-done')
        setTimeout(() => { this.root.hidden = true }, 450)
    }

    _set(id, patch) {
        const step = this.steps[id]
        if (!step || this.failed) return
        Object.assign(step, patch)
        const row = this.rows.get(id)
        if (row) {
            row.dataset.state = step.state
            const detail = row.querySelector('.tl-boot-step-detail')
            if (detail && patch.detail !== undefined) detail.textContent = patch.detail
        }
        this._render()
    }

    _render() {
        let total = 0
        for (const [id, step] of Object.entries(this.steps)) total += STEPS[id].weight * step.fraction
        const allDone = Object.values(this.steps).every(s => s.state === 'done')
        const pct = allDone ? 100 : Math.min(99, Math.floor(total * 100))
        this.bar.style.setProperty('--p', String(pct / 100))
        this.bar.setAttribute('aria-valuenow', String(pct))
        this.percent.textContent = `${pct}%`
        const running = Object.keys(STEPS).find(id => this.steps[id].state === 'active')
        this.status.textContent = allDone ? 'Ready' : STEPS[running]?.doing || this.status.textContent
    }
}
