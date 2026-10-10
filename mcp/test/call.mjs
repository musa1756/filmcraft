// Usage: node test/call.mjs <tool> '<json args>' [<tool> '<json>' ...]  — calls tools through a real MCP client.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const server = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
const client = new Client({ name: 'cli', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [server] }));
const argv = process.argv.slice(2);
if (argv[0] === '--list') {
  const { tools } = await client.listTools();
  const s = JSON.stringify(tools);
  console.log(`${tools.length} tools, tools/list ${s.length} chars (~${Math.round(s.length / 4)} tokens)`);
  for (const t of tools) console.log('-', t.name, JSON.stringify(t).length);
} else {
  for (let i = 0; i < argv.length; i += 2) {
    const r = await client.callTool({ name: argv[i], arguments: JSON.parse(argv[i + 1] || '{}') });
    for (const c of r.content) {
      if (c.type === 'text') console.log(c.text);
      else { const f = `/private/tmp/claude-501/-Users-musa-film-craft/6c487252-eb68-49d7-990f-f0238c5c6000/scratchpad/out_${i}.jpg`; writeFileSync(f, Buffer.from(c.data, 'base64')); console.log(`[image ${c.data.length} b64 chars → ${f}]`); }
    }
    if (r.isError) console.log('(isError)');
  }
}
await client.close();
