/**
 * WAV files from AudioBuffers: 16-bit PCM, interleaved, with triangular
 * dither so quiet passages do not turn into distortion.
 */

export function encodeWav(buffer) {
    const channels = Math.min(2, buffer.numberOfChannels)
    const n = buffer.length
    const bytes = new ArrayBuffer(44 + n * channels * 2)
    const view = new DataView(bytes)
    const tag = (offset, text) => { for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i)) }
    tag(0, 'RIFF')
    view.setUint32(4, 36 + n * channels * 2, true)
    tag(8, 'WAVE')
    tag(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, channels, true)
    view.setUint32(24, buffer.sampleRate, true)
    view.setUint32(28, buffer.sampleRate * channels * 2, true)
    view.setUint16(32, channels * 2, true)
    view.setUint16(34, 16, true)
    tag(36, 'data')
    view.setUint32(40, n * channels * 2, true)
    const data = Array.from({ length: channels }, (_, c) => buffer.getChannelData(c))
    let offset = 44
    for (let i = 0; i < n; i++) {
        for (let c = 0; c < channels; c++) {
            const dither = (Math.random() - Math.random()) / 32768
            const v = Math.max(-1, Math.min(1, data[c][i] + dither))
            view.setInt16(offset, Math.round(v * 32767), true)
            offset += 2
        }
    }
    return new Blob([bytes], { type: 'audio/wav' })
}
