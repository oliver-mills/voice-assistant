const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point the store at a throwaway folder before anything loads it
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-assistant-'));
const tools = require('../tools');

const call = (name, input, onTimer = () => {}) => tools.run({ name, input }, { onTimer });

test('remember saves a fact to disk and into the prompt', () => {
  const result = call('remember', { fact: 'Lives in Leeds' });
  assert.ok(!result.is_error);
  assert.match(tools.describeMemories(), /1: Lives in Leeds/);

  const saved = JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'memories.json'), 'utf8'));
  assert.strictEqual(saved[0].fact, 'Lives in Leeds');
});

test('remember rejects empty and oversized facts', () => {
  assert.ok(call('remember', { fact: '   ' }).is_error);
  assert.ok(call('remember', {}).is_error);
  assert.ok(call('remember', { fact: 'x'.repeat(301) }).is_error);
});

test('forget removes a fact by id and reports unknown ids', () => {
  const { content } = call('remember', { fact: 'Has a cat called Miso' });
  const id = Number(content.match(/\d+/)[0]);
  assert.ok(!call('forget', { id }).is_error);
  assert.doesNotMatch(tools.describeMemories(), /Miso/);
  assert.ok(call('forget', { id: 999 }).is_error);
});

test('set_timer hands valid timers to the browser', () => {
  let sent;
  const result = call('set_timer', { seconds: 300, label: 'Pasta' }, (t) => { sent = t; });
  assert.ok(!result.is_error);
  assert.deepStrictEqual(sent, { seconds: 300, label: 'Pasta' });
});

test('set_timer rejects bad durations without sending anything', () => {
  let sent = false;
  const onTimer = () => { sent = true; };
  for (const seconds of [0, -5, 1.5, 24 * 60 * 60 + 1, '60', undefined]) {
    assert.ok(call('set_timer', { seconds, label: 'x' }, onTimer).is_error, `seconds=${seconds}`);
  }
  assert.strictEqual(sent, false);
});

test('unknown tools come back as errors rather than throwing', () => {
  assert.ok(call('launch_rocket', {}).is_error);
});
