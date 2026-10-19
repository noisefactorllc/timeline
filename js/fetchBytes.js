/**
 * Fetch a URL into an ArrayBuffer, reporting progress as the bytes
 * arrive: onProgress(fraction 0..1, bytes received, bytes expected).
 * Without a Content-Length the fraction stays at 0 until the body
 * completes.
 */
export async function fetchBytes(url, onProgress = () => {}, init = {}) {
    const res = await fetch(url, init)
    if (!res.ok) throw new Error(`${url} answered ${res.status}`)
    const total = Number(res.headers.get('content-length')) || 0
    if (!res.body || !total) {
        const bytes = await res.arrayBuffer()
        onProgress(1, bytes.byteLength, bytes.byteLength)
        return bytes
    }
    const reader = res.body.getReader()
    const chunks = []
    let received = 0
    for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        chunks.push(value)
        received += value.length
        // A compressed response decodes to more bytes than its length.
        onProgress(Math.min(1, received / total), Math.min(received, total), total)
    }
    const out = new Uint8Array(received)
    let offset = 0
    for (const chunk of chunks) {
        out.set(chunk, offset)
        offset += chunk.length
    }
    onProgress(1, received, Math.max(received, total))
    return out.buffer
}
