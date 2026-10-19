// MCP client: connects to the servers listed in mcp.json at startup and offers
// their tools to Claude alongside the built-in ones. Local servers run as
// child processes over stdio; remote ones are reached over streamable HTTP.
// The config uses the same mcpServers shape as Claude Desktop, so existing
// setups copy across.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport, getDefaultEnvironment } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');

const CONFIG_PATH = process.env.MCP_CONFIG || path.join(__dirname, 'mcp.json');

// Claude sees "server__tool", so tools from different servers can't collide
const SEPARATOR = '__';
const MAX_NAME_LENGTH = 64;

// A browser page snapshot can run to tens of thousands of characters, and all
// of it is input tokens on every later leg of the turn. Keep enough to answer
// from and say what was cut.
const MAX_RESULT_CHARS = 12000;
const CONNECT_TIMEOUT_MS = 60000;   // npx may be downloading the server first
const CALL_TIMEOUT_MS = 60000;

const servers = new Map();    // name -> { name, status, error, client, tools }
const toolIndex = new Map();  // Claude-facing name -> { server, tool }

// "${GITHUB_TOKEN}" in the config is read from the environment, so secrets
// stay in .env rather than in mcp.json
function expander(missing) {
  return (value) => String(value).replace(/\$\{(\w+)\}/g, (_, key) => {
    if (!process.env[key]) missing.add(key);
    return process.env[key] || '';
  });
}

function expandHome(value) {
  return value === '~' || value.startsWith('~/') ? path.join(os.homedir(), value.slice(1)) : value;
}

function mapValues(object = {}, fn) {
  return Object.fromEntries(Object.entries(object).map(([key, value]) => [key, fn(value)]));
}

function claudeName(serverName, toolName) {
  return `${serverName}${SEPARATOR}${toolName}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, MAX_NAME_LENGTH);
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    })
  ]).finally(() => clearTimeout(timer));
}

function buildTransport(name, spec) {
  const missing = new Set();
  const expand = expander(missing);
  let transport;

  if (spec.url) {
    transport = new StreamableHTTPClientTransport(new URL(expand(spec.url)), {
      requestInit: { headers: mapValues(spec.headers, expand) }
    });
  } else if (spec.command) {
    transport = new StdioClientTransport({
      command: spec.command,
      args: (spec.args || []).map((arg) => expandHome(expand(arg))),
      env: { ...getDefaultEnvironment(), ...mapValues(spec.env, expand) },
      cwd: spec.cwd ? expandHome(expand(spec.cwd)) : undefined,
      stderr: 'pipe'
    });
    // Servers log to stderr; keep it, labelled, rather than mixing it in raw
    transport.stderr.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line.trim()) console.log(`[mcp:${name}] ${line}`);
      }
    });
  } else {
    throw new Error('needs either "command" or "url"');
  }

  if (missing.size) throw new Error(`${[...missing].join(', ')} not set in .env`);
  return transport;
}

async function listAllTools(client) {
  const tools = [];
  let cursor;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return tools;
}

async function connect(name, spec) {
  const entry = { name, status: 'connecting', error: null, client: null, tools: [] };
  servers.set(name, entry);

  if (spec.disabled) {
    entry.status = 'disabled';
    return;
  }

  try {
    const transport = buildTransport(name, spec);
    const client = new Client({ name: 'voice-assistant', version: '1.0.0' });
    await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, 'Connecting');

    // An allowlist keeps a voice command from reaching anything destructive,
    // and keeps the tool list (sent with every request) short
    const available = await listAllTools(client);
    const allowed = Array.isArray(spec.tools) ? new Set(spec.tools) : null;
    entry.tools = allowed ? available.filter((tool) => allowed.has(tool.name)) : available;
    if (allowed) {
      const unknown = [...allowed].filter((tool) => !available.some((t) => t.name === tool));
      if (unknown.length) console.warn(`MCP ${name}: no such tools, check mcp.json: ${unknown.join(', ')}`);
    }

    // Patterns that refuse a call outright when its arguments match, e.g. so a
    // filesystem server pointed at this project can never read .env aloud
    entry.deny = (spec.deny || []).map((pattern) => new RegExp(pattern, 'i'));

    for (const tool of entry.tools) {
      toolIndex.set(claudeName(name, tool.name), { server: entry, tool });
    }
    entry.client = client;
    entry.status = 'connected';
    console.log(`MCP ${name}: connected, ${entry.tools.length} tool${entry.tools.length === 1 ? '' : 's'}`);
  } catch (err) {
    entry.status = 'error';
    entry.error = err.message;
    console.warn(`MCP ${name}: ${err.message}`);
  }
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')).mcpServers || {};
  } catch (err) {
    console.warn(`Could not read ${path.basename(CONFIG_PATH)}: ${err.message}`);
    return {};
  }
}

// Connects in the background; the assistant works without MCP tools until
// each server is up, and a server that fails just stays out of the list
function start() {
  const config = loadConfig();
  return Promise.all(Object.entries(config).map(([name, spec]) => connect(name, spec)));
}

async function stop() {
  await Promise.allSettled([...servers.values()]
    .filter((entry) => entry.client)
    .map((entry) => entry.client.close()));
}

// Tool definitions in the shape the Messages API takes
function definitions() {
  const defs = [];
  for (const [name, { server, tool }] of toolIndex) {
    const schema = tool.inputSchema && tool.inputSchema.type === 'object'
      ? tool.inputSchema
      : { type: 'object', properties: {} };
    defs.push({
      name,
      description: `[${server.name}] ${tool.description || tool.name}`.slice(0, 1024),
      input_schema: schema
    });
  }
  return defs;
}

function has(name) {
  return toolIndex.has(name);
}

// "github · list_issues", for the transcript and status line
function label(name) {
  const entry = toolIndex.get(name);
  return entry ? `${entry.server.name} · ${entry.tool.name}` : name;
}

function flatten(result) {
  const parts = (result.content || []).map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'resource' && block.resource && block.resource.text) return block.resource.text;
    return `[${block.type} content not shown]`;
  });
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent));
  return parts.join('\n').trim();
}

// Runs one tool call. Returns tool_result fields; never throws, since Claude
// can read an error and try something else.
async function call(name, input) {
  const entry = toolIndex.get(name);
  if (!entry) return { content: `Unknown tool ${name}`, is_error: true };

  const args = JSON.stringify(input || {});
  if (entry.server.deny.some((pattern) => pattern.test(args))) {
    return { content: 'Refused: that path is blocked in this assistant\'s configuration.', is_error: true };
  }

  try {
    const result = await entry.server.client.callTool(
      { name: entry.tool.name, arguments: input || {} },
      undefined,
      { timeout: CALL_TIMEOUT_MS }
    );
    let text = flatten(result) || '(no output)';
    if (text.length > MAX_RESULT_CHARS) {
      text = `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${text.length - MAX_RESULT_CHARS} more characters]`;
    }
    return { content: text, is_error: Boolean(result.isError) };
  } catch (err) {
    return { content: `Tool failed: ${err.message}`, is_error: true };
  }
}

// For the settings menu: what is connected and what it offers
function status() {
  return [...servers.values()].map(({ name, status, error, tools }) => ({
    name,
    status,
    error,
    tools: tools.map((tool) => tool.name)
  }));
}

module.exports = { start, stop, definitions, has, label, call, status, claudeName, CONFIG_PATH };
