/**
 * Undo history as whole-project snapshots. Projects are small JSON
 * documents, so a snapshot per action is simple and exact: undo restores
 * precisely what the user saw, including selection-independent state.
 */

export class History {
    constructor({ limit = 200 } = {}) {
        this.limit = limit
        this.past = []
        this.future = []
    }

    /** Record the state before an action. */
    push(snapshot, label = '') {
        this.past.push({ snapshot: structuredClone(snapshot), label })
        if (this.past.length > this.limit) this.past.shift()
        this.future = []
    }

    get canUndo() { return this.past.length > 0 }
    get canRedo() { return this.future.length > 0 }
    get undoLabel() { return this.past.at(-1)?.label || '' }
    get redoLabel() { return this.future.at(-1)?.label || '' }

    /** Returns the state to restore, given the current one. */
    undo(current) {
        const entry = this.past.pop()
        if (!entry) return null
        this.future.push({ snapshot: structuredClone(current), label: entry.label })
        return entry.snapshot
    }

    redo(current) {
        const entry = this.future.pop()
        if (!entry) return null
        this.past.push({ snapshot: structuredClone(current), label: entry.label })
        return entry.snapshot
    }

    clear() {
        this.past = []
        this.future = []
    }
}
