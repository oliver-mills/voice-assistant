const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Nothing in here may reach a real API: fake keys, a throwaway data folder,
// and a fetch that records ElevenLabs calls instead of making them
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-assistant-'));
process.env.ELEVENLABS_API_KEY = 'test-not-real';
process.env.ANTHROPIC_API_KEY = 'test-not-real';
process.env.VOICE_ID = 'test-voice';
delete process.env.APP_PASSWORD;

const realFetch = globalThis.fetch;
const elevenLabsCalls = [];
globalThis.fetch = async (url, options) => {
  if (String(url).includes('elevenlabs.io')) {
    elevenLabsCalls.push(url);
    return new Response(new Uint8Array(10), { status: 200 });
  }
  return realFetch(url, options);
};

const { app, trimHistory } = require('../server');

let base;
let server;
test.before(async () => {
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(() => server.close());

const say = (text) => ({ role: 'user', content: text });
const reply = (text) => ({ role: 'assistant', content: [{ type: 'text', text }] });
const toolResults = { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }] };

test('trimHistory leaves a short history alone', () => {
  const history = [say('hi'), reply('hello')];
  assert.deepStrictEqual(trimHistory(history), history);
});

test('trimHistory never starts on an assistant reply or orphaned tool results', () => {
  const turn = [say('q'), { role: 'assistant', content: [{ type: 'tool_use', id: 'a' }] }, toolResults, reply('a')];
  const history = Array.from({ length: 12 }, () => turn).flat(); // 48 messages
  const trimmed = trimHistory(history);
  assert.ok(trimmed.length <= 40);
  assert.strictEqual(trimmed[0].role, 'user');
  assert.strictEqual(typeof trimmed[0].content, 'string');
});

test('trimHistory returns nothing when no user turn survives', () => {
  assert.deepStrictEqual(trimHistory([reply('a'), toolResults]), []);
});

const speak = (text) => realFetch(`${base}/api/text-to-speech`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text })
});

test('text-to-speech refuses oversized text before calling ElevenLabs', async () => {
  const before = elevenLabsCalls.length;
  const response = await speak('x'.repeat(401));
  assert.strictEqual(response.status, 413);
  assert.strictEqual(elevenLabsCalls.length, before);
});

test('text-to-speech refuses empty text before calling ElevenLabs', async () => {
  const before = elevenLabsCalls.length;
  assert.strictEqual((await speak('  ')).status, 400);
  assert.strictEqual(elevenLabsCalls.length, before);
});

test('text-to-speech streams audio for a normal sentence', async () => {
  const response = await speak('Hello there, this is a sentence.');
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers.get('content-type'), 'audio/mpeg');
  assert.strictEqual((await response.arrayBuffer()).byteLength, 10);
});

test('server files are not served to the browser', async () => {
  for (const file of ['server.js', 'package.json', 'tools.js', '.env']) {
    assert.strictEqual((await realFetch(`${base}/${file}`)).status, 404, file);
  }
  assert.strictEqual((await realFetch(`${base}/app.js`)).status, 200);
});

test('memory panel can list and delete saved facts', async () => {
  const tools = require('../tools');
  tools.run({ name: 'remember', input: { fact: 'Prefers tea' } }, { onTimer() {} });

  const { memories } = await (await realFetch(`${base}/api/memories`)).json();
  const tea = memories.find((m) => m.fact === 'Prefers tea');
  assert.ok(tea);

  const del = (id) => realFetch(`${base}/api/memories/${id}`, { method: 'DELETE' });
  assert.strictEqual((await del(tea.id)).status, 200);
  assert.strictEqual((await del(tea.id)).status, 404);
  assert.doesNotMatch(tools.describeMemories(), /Prefers tea/);
});

test('APP_PASSWORD gates every route', async () => {
  process.env.APP_PASSWORD = 'correct horse';
  try {
    const auth = (password) => ({
      headers: { Authorization: `Basic ${Buffer.from(`any:${password}`).toString('base64')}` }
    });
    assert.strictEqual((await realFetch(`${base}/`)).status, 401);
    assert.strictEqual((await realFetch(`${base}/api/history`, auth('wrong'))).status, 401);
    assert.strictEqual((await realFetch(`${base}/api/history`, auth('correct horse'))).status, 200);
  } finally {
    delete process.env.APP_PASSWORD;
  }
});
