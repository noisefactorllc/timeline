/**
 * A stand-in for the thumbnail IndexedDB cache: nothing is stored, so every
 * request renders fresh.
 */

export async function loadThumb() {
    return null
}

export async function saveThumb() {}
