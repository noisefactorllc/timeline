// deployment-meta.json gives `git_hash` and `date` in Unix seconds.
// The About dialog's setBuild reads a number as milliseconds, so the
// date is converted to a Date here. The hash shows its first eight
// characters, as the Noisemaker Engine line does.
export function buildInfoFromMeta(meta) {
    const hash = typeof meta?.git_hash === 'string' ? meta.git_hash.trim().slice(0, 8) : ''
    if (!hash) return null
    const deployed = Number.isFinite(meta.date) ? new Date(meta.date * 1000) : null
    return { hash, deployed }
}
