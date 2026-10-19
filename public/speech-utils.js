// Pure helpers with no DOM or network, loaded as a plain script by the page
// and with require() by the tests
(function (root) {
  // Pulls the next speakable chunk off the front of the buffer, or returns a
  // null chunk if what is there so far might still grow into a longer sentence.
  function takeChunk(buffer, minChars = 20, maxChars = 220) {
    // Requiring whitespace after the terminator keeps "8.8 km" and "3.5" intact
    const boundary = /[.!?…]["')\]]?(?=\s)/g;
    let match;
    while ((match = boundary.exec(buffer))) {
      const end = match.index + match[0].length;
      if (end >= minChars) {
        return [buffer.slice(0, end).trim(), buffer.slice(end)];
      }
    }

    // No usable sentence end yet. If it has run long, break at a word boundary
    // so speech isn't held up waiting for a full stop that may be far away.
    if (buffer.length > maxChars) {
      const cut = buffer.lastIndexOf(' ', maxChars);
      if (cut > 0) return [buffer.slice(0, cut).trim(), buffer.slice(cut)];
    }

    return [null, buffer];
  }

  function concatSamples(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const out = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return out;
  }

  // Averages each window down to one sample. Crude next to a proper filter, but
  // plenty for speech headed to a transcriber, and a third the size at 16kHz.
  function downsample(samples, fromRate, toRate) {
    if (toRate >= fromRate) return samples;
    const ratio = fromRate / toRate;
    const out = new Float32Array(Math.floor(samples.length / ratio));
    for (let i = 0; i < out.length; i++) {
      const start = Math.floor(i * ratio);
      const end = Math.min(samples.length, Math.floor((i + 1) * ratio));
      let sum = 0;
      for (let j = start; j < end; j++) sum += samples[j];
      out[i] = sum / Math.max(1, end - start);
    }
    return out;
  }

  // 16-bit mono PCM in a WAV container, which every transcriber accepts
  function encodeWav(samples, sampleRate) {
    const bytes = new Uint8Array(44 + samples.length * 2);
    const view = new DataView(bytes.buffer);
    const writeText = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
    };

    writeText(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeText(8, 'WAVE');
    writeText(12, 'fmt ');
    view.setUint32(16, 16, true);             // fmt chunk size
    view.setUint16(20, 1, true);              // PCM
    view.setUint16(22, 1, true);              // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);              // block align
    view.setUint16(34, 16, true);             // bits per sample
    writeText(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    for (let i = 0; i < samples.length; i++) {
      const clamped = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i * 2, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    }
    return bytes;
  }

  const api = { takeChunk, concatSamples, downsample, encodeWav };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SpeechUtils = api;
})(this);
