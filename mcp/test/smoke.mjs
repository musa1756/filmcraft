// Read-only smoke test against the running app: never edits the open project.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server] }));
const { tools } = await client.listTools();
console.log(`tools: ${tools.length}, tools/list ≈ ${Math.round(JSON.stringify(tools).length / 4)} tokens`);
let fails = 0;
const check = async (name, args, expect) => {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  const img = r.content.some((c) => c.type === 'image');
  const ok = !r.isError && expect(txt, img);
  if (!ok) fails++;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(args)} → ${txt.split('\n')[0].slice(0, 100)}${img ? ' [image]' : ''}`);
};
await check('fc_app', {}, (t) => t.startsWith('connected'));
await check('fc_guide', {}, (t) => t.includes('FILMCRAFT MCP'));
await check('fc_find', { q: 'razor' }, (t) => t.includes('timeline.razor'));
await check('fc_help', { ids: ['timeline.place'] }, (t) => t.includes('"item":id'));
await check('fc_effects', { q: 'gaussian blur' }, (t) => t.includes('blurriness'));
await check('fc_project', {}, (t) => t.startsWith('PROJECT'));
await check('fc_seq', {}, (t) => t.startsWith('SEQ') || t === 'no active sequence');
await check('fc_ui', { action: 'inspect' }, (t) => t.includes('"mode"'));
await check('fc_ui', { action: 'elements', prefix: 'tools.' }, (t) => t.includes('tools.'));
await check('fc_shot', { panel: 'Timeline', width: 400 }, (_, i) => i);
await check('fc_frame', { width: 320 }, (_, i) => i);
await client.close();
console.log(fails ? `${fails} FAILED` : 'all passed');
process.exit(fails ? 1 : 0);
