const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// A throwaway config pointing at the fake stdio server, plus entries that
// must fail cleanly without taking the others down
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-assistant-mcp-'));
const configPath = path.join(dir, 'mcp.json');
fs.writeFileSync(configPath, JSON.stringify({
  mcpServers: {
    fake: {
      command: process.execPath,
      args: [path.join(__dirname, 'fixtures', 'fake-mcp-server.js')],
      tools: ['echo', 'big', 'fails'],
      deny: ['secret']
    },
    needsToken: {
      url: 'https://example.invalid/mcp',
      headers: { Authorization: 'Bearer ${SURELY_UNSET_TOKEN_FOR_TESTS}' }
    },
    off: { command: 'nothing', disabled: true }
  }
}));
process.env.MCP_CONFIG = configPath;
delete process.env.SURELY_UNSET_TOKEN_FOR_TESTS;

const mcp = require('../mcp');

test.before(() => mcp.start());
test.after(() => mcp.stop());

test('connects and offers only allowlisted tools, namespaced by server', () => {
  const names = mcp.definitions().map((d) => d.name).sort();
  assert.deepStrictEqual(names, ['fake__big', 'fake__echo', 'fake__fails']);

  const echo = mcp.definitions().find((d) => d.name === 'fake__echo');
  assert.match(echo.description, /^\[fake\] /);
  assert.strictEqual(echo.input_schema.type, 'object');
  assert.ok(echo.input_schema.properties.text);
});

test('reports servers that could not start, without affecting the rest', () => {
  const byName = Object.fromEntries(mcp.status().map((s) => [s.name, s]));
  assert.strictEqual(byName.fake.status, 'connected');
  assert.strictEqual(byName.needsToken.status, 'error');
  assert.match(byName.needsToken.error, /SURELY_UNSET_TOKEN_FOR_TESTS not set/);
  assert.strictEqual(byName.off.status, 'disabled');
});

test('calls a tool and returns its text', async () => {
  assert.deepStrictEqual(await mcp.call('fake__echo', { text: 'hi' }), { content: 'echo: hi', is_error: false });
});

test('passes tool errors through as error results', async () => {
  const result = await mcp.call('fake__fails', {});
  assert.strictEqual(result.is_error, true);
  assert.strictEqual(result.content, 'it broke');
});

test('truncates huge results and says so', async () => {
  const { content } = await mcp.call('fake__big', {});
  assert.ok(content.length < 12200);
  assert.match(content, /\[truncated: 8000 more characters\]$/);
});

test('refuses calls whose arguments match a deny pattern, before the server sees them', async () => {
  const result = await mcp.call('fake__echo', { text: 'my SECRET plan' });
  assert.strictEqual(result.is_error, true);
  assert.match(result.content, /^Refused/);
});

test('never runs tools left off the allowlist', async () => {
  assert.strictEqual(mcp.has('fake__hidden'), false);
  assert.strictEqual((await mcp.call('fake__hidden', {})).is_error, true);
});

test('tool names are made safe for the API', () => {
  assert.strictEqual(mcp.claudeName('my server', 'do.thing'), 'my_server__do_thing');
  assert.ok(mcp.claudeName('s', 'x'.repeat(100)).length <= 64);
});
