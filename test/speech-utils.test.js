const test = require('node:test');
const assert = require('node:assert');
const { takeChunk, concatSamples, downsample, encodeWav } = require('../public/speech-utils');

test('takeChunk splits at the first sentence end past the minimum', () => {
  assert.deepStrictEqual(
    takeChunk('The weather today is mild. Tomorrow rain.'),
    ['The weather today is mild.', ' Tomorrow rain.']
  );
});

test('takeChunk holds back a sentence that might still be growing', () => {
  assert.deepStrictEqual(takeChunk('It is mild today'), [null, 'It is mild today']);
});

test('takeChunk keeps short openers with the sentence after them', () => {
  const [chunk] = takeChunk('Yes. The shop opens at nine tomorrow. ');
  assert.strictEqual(chunk, 'Yes. The shop opens at nine tomorrow.');
});

test('takeChunk does not split decimals or abbreviations without a space', () => {
  assert.deepStrictEqual(takeChunk('It was 3.5 degrees and 8.8 km'), [null, 'It was 3.5 degrees and 8.8 km']);
});

test('takeChunk breaks a run-on sentence at a word boundary', () => {
  const long = 'word '.repeat(60);
  const [chunk, rest] = takeChunk(long, 20, 220);
  assert.ok(chunk.length > 200 && chunk.length <= 220, `chunk was ${chunk.length}`);
  assert.ok(chunk.endsWith('word'));
  assert.ok(rest.startsWith(' word'));
});

test('concatSamples joins chunks in order', () => {
  const joined = concatSamples([new Float32Array([1, 2]), new Float32Array([3])]);
  assert.deepStrictEqual([...joined], [1, 2, 3]);
});

test('downsample averages down to the target rate', () => {
  const out = downsample(new Float32Array([0, 0.3, 0.6, 0.9, 0.9, 0.9]), 48000, 16000);
  assert.strictEqual(out.length, 2);
  assert.ok(Math.abs(out[0] - 0.3) < 1e-6);
  assert.ok(Math.abs(out[1] - 0.9) < 1e-6);
});

test('downsample leaves audio already at or below the target alone', () => {
  const samples = new Float32Array([0.1, 0.2]);
  assert.strictEqual(downsample(samples, 16000, 16000), samples);
});

test('encodeWav writes a valid 16-bit mono header and clamps samples', () => {
  const wav = encodeWav(new Float32Array([0, 1, -1, 2]), 16000);
  const view = new DataView(wav.buffer);
  const text = (offset) => Buffer.from(wav.slice(offset, offset + 4)).toString();

  assert.strictEqual(wav.length, 44 + 4 * 2);
  assert.strictEqual(text(0), 'RIFF');
  assert.strictEqual(text(8), 'WAVE');
  assert.strictEqual(view.getUint16(22, true), 1);      // mono
  assert.strictEqual(view.getUint32(24, true), 16000);  // sample rate
  assert.strictEqual(view.getUint16(34, true), 16);     // bits per sample
  assert.strictEqual(view.getUint32(40, true), 8);      // data size
  assert.strictEqual(view.getInt16(46, true), 0x7fff);  // 1 -> max
  assert.strictEqual(view.getInt16(48, true), -0x8000); // -1 -> min
  assert.strictEqual(view.getInt16(50, true), 0x7fff);  // 2 clamped
});
