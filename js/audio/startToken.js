/**
 * A start gate for playback: a start that is still awaiting (audio unlock,
 * mix render) is stale once the user pauses, so it must not start playing
 * after the pause.
 */
export class StartGate {
    constructor() {
        this.token = 0
    }

    /** Open a start; returns the token this start owns. */
    begin() {
        return ++this.token
    }

    /** Close every start opened so far. */
    invalidate() {
        this.token++
    }

    /** Whether a start's token is still current. */
    current(token) {
        return this.token === token
    }
}
