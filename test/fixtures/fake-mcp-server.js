// A minimal MCP server over stdio for the tests: no network, predictable tools
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');

const server = new McpServer({ name: 'fake', version: '1.0.0' });

server.registerTool('echo', {
  description: 'Echo the text back',
  inputSchema: { text: z.string() }
}, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));

server.registerTool('big', {
  description: 'Return a very long result'
}, async () => ({ content: [{ type: 'text', text: 'x'.repeat(20000) }] }));

server.registerTool('fails', {
  description: 'Always reports an error'
}, async () => ({ content: [{ type: 'text', text: 'it broke' }], isError: true }));

server.registerTool('hidden', {
  description: 'Not on the allowlist, so the assistant should never see it'
}, async () => ({ content: [{ type: 'text', text: 'should not run' }] }));

server.connect(new StdioServerTransport());
