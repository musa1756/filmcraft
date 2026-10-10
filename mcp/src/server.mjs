#!/usr/bin/env node
// filmcraft-mcp-lite: a token-lean MCP server for the running FilmCraft app.
// Every engine command, menu item, UI element and control method is reachable; outputs are
// compact text instead of pretty JSON, and images are downscaled JPEGs.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { mkdtempSync, readFileSync, statSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { FcClient } from './client.mjs';
import { TPS, sec, fpsOf, fmtSequence, fmtProject, parseVal, parseDefault, compactJson, fmtElements, choiceName, same } from './format.mjs';
import { GUIDE, GUIDE_TOPICS } from './guide.mjs';

const run = promisify(execFile);
const fc = new FcClient({
  port: Number(process.env.FILMCRAFT_PORT || 9876),
  appPath: process.env.FILMCRAFT_APP || undefined,
  autoLaunch: process.env.FILMCRAFT_AUTOLAUNCH !== '0',
});
const WORK = mkdtempSync(join(tmpdir(), 'fcmcp-'));
const FFMPEG = process.env.FFMPEG || ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg'].find(existsSync) || 'ffmpeg';
const FFPROBE = FFMPEG.replace(/ffmpeg$/, 'ffprobe');

// ---------- helpers ----------

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const err = (s) => ({ content: [{ type: 'text', text: s }], isError: true });
const image = (b64, mime, note) => ({ content: [{ type: 'image', data: b64, mimeType: mime }, ...(note ? [{ type: 'text', text: note }] : [])] });

function safe(fn) {
  return async (args, extra) => {
    try {
      return await fn(args ?? {}, extra);
    } catch (e) {
      return err(String(e?.message || e));
    }
  };
}

let fxDefaults = null; // Map effectId -> {param: default}
let fxCatalog = null;
async function effectsCatalog() {
  if (!fxCatalog) {
    fxCatalog = await fc.exec('effects.list', { detail: true });
    fxDefaults = new Map(fxCatalog.map((e) => [e.id, Object.fromEntries((e.paramInfo || []).map((p) => [p.id, p]))]));
  }
  return fxCatalog;
}
async function defaults() {
  try { await effectsCatalog(); } catch { /* compact view still works without defaults */ }
  return fxDefaults;
}

let fpsCache = { seq: null, fps: 0 };
async function seqFps() {
  const seq = await fc.exec('sequence.inspect');
  fpsCache = { seq: seq?.id, fps: fpsOf(seq) || 24 };
  return fpsCache.fps;
}

/**
 * Time sugar: in params, `<key>_s: seconds` → `<key>: ticks` (snapped to the sequence frame),
 * `<key>_f: frames` → `<key>: ticks`. Works at any depth (e.g. inside `moves`).
 */
async function sugar(params) {
  let need = false;
  const scan = (v) => {
    if (Array.isArray(v)) v.forEach(scan);
    else if (v && typeof v === 'object') for (const k of Object.keys(v)) { if (/_[sf]$/.test(k) && k.length > 2) need = true; scan(v[k]); }
  };
  scan(params);
  if (!need) return params;
  const fps = await seqFps();
  const frameTicks = TPS / fps;
  const conv = (v) => {
    if (Array.isArray(v)) return v.map(conv);
    if (!v || typeof v !== 'object') return v;
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (/_s$/.test(k) && k.length > 2 && typeof x === 'number') o[k.slice(0, -2)] = Math.round(Math.round((x * TPS) / frameTicks) * frameTicks);
      else if (/_f$/.test(k) && k.length > 2 && typeof x === 'number') o[k.slice(0, -2)] = Math.round(x * frameTicks);
      else o[k] = conv(x);
    }
    return o;
  };
  return conv(params);
}

async function catalog() {
  const [cmds, menu] = await Promise.all([fc.call('engine.commands'), fc.call('ui.menu.list').catch(() => [])]);
  const byId = new Map(cmds.map((c) => [c.id, { ...c, menu: c.menu || [] }]));
  for (const m of menu || []) {
    if (!byId.has(m.id)) byId.set(m.id, { id: m.id, label: m.label, menu: m.path || [], shortcut: m.shortcut, enabled: m.enabled, params: '{}', uiOnly: true });
  }
  return [...byId.values()];
}

function fmtCmd(c, full = false) {
  const menu = c.menu?.length ? ` [${c.menu.join('>')}]` : '';
  const sc = c.shortcut ? ` (${c.shortcut})` : '';
  const p = c.params && c.params !== '{}' ? ' ' + (full || c.params.length < 260 ? c.params : c.params.slice(0, 257) + '…') : '';
  return `${c.enabled === false ? '✗ ' : ''}${c.id} — ${c.label}${menu}${sc}${c.uiOnly ? ' [ui]' : ''}${p}`;
}

function score(c, words) {
  const id = c.id.toLowerCase(), label = (c.label || '').toLowerCase(), menu = (c.menu || []).join(' ').toLowerCase(), params = (c.params || '').toLowerCase();
  let s = 0;
  for (const w of words) {
    if (id === w) s += 50;
    else if (id.split('.').includes(w)) s += 12;
    else if (id.includes(w)) s += 8;
    else if (label.includes(w)) s += 6;
    else if (menu.includes(w)) s += 3;
    else if (params.includes(w)) s += 1;
    else return 0;
  }
  return s;
}

async function suggest(id) {
  try {
    const cat = await catalog();
    const words = id.toLowerCase().split(/[.\s_-]+/).filter(Boolean);
    const scored = cat.map((c) => [c, words.reduce((a, w) => a + (c.id.toLowerCase().includes(w) ? 1 : 0), 0)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]).slice(0, 6);
    return scored.length ? '\nDid you mean:\n' + scored.map(([c]) => fmtCmd(c)).join('\n') : '';
  } catch { return ''; }
}

async function runCmd(id, params) {
  try {
    return await fc.exec(id, await sugar(params || {}));
  } catch (e) {
    if (/unknown command|no such command|not found/i.test(e.message)) e.message += await suggest(id);
    throw e;
  }
}

async function seqText(opts = {}) {
  const [seq, d, caps] = await Promise.all([
    fc.exec('sequence.inspect', opts.item ? { item: opts.item } : {}),
    defaults(),
    opts.item || opts.captions === false ? null : fc.exec('captions.list').catch(() => null),
  ]);
  let out = fmtSequence(seq, d, opts);
  for (const t of caps?.tracks || []) {
    if (opts.track && opts.track !== t.label) continue;
    const cs = t.captions || [];
    out += `\n${t.label} #${t.id} "${t.name}" ${t.format}${t.locked ? ' LOCKED' : ''} ${cs.length} captions`;
    const lim = opts.track === t.label ? cs.length : 12;
    for (const c of cs.slice(0, lim)) out += `\n  cap#${c.id} ${sec(c.start)}-${sec(c.start + (c.end - c.start))}s ${JSON.stringify(c.text.length > 80 ? c.text.slice(0, 77) + '…' : c.text)}`;
    if (cs.length > lim) out += `\n  … ${cs.length - lim} more (track:"${t.label}" for all)`;
  }
  return out;
}

async function shrink(srcPng, { width = 640, quality = 5 } = {}) {
  const out = srcPng.replace(/\.png$/, '') + `_${width}.jpg`;
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-i', srcPng, '-vf', `scale='min(${width},iw)':-2`, '-q:v', String(quality), out]);
  return readFileSync(out).toString('base64');
}

let nshot = 0;
const tmp = (ext) => join(WORK, `f${Date.now()}_${nshot++}.${ext}`);

async function exportFrame(t, extra = {}) {
  const path = tmp('png');
  const params = { path, format: 'png', ...extra };
  if (t != null) params.time = Math.round(t * TPS);
  const r = await fc.exec('file.exportFrame', params);
  return { path, r };
}

async function waitJob(job, extra, timeoutS = 3600) {
  const t0 = Date.now();
  let last = -1;
  const token = extra?._meta?.progressToken;
  while (Date.now() - t0 < timeoutS * 1000) {
    await new Promise((r) => setTimeout(r, 500));
    const jobs = await fc.exec('jobs.list');
    const j = (jobs || []).find((x) => x.id === job);
    if (!j) return { finished: true, result: null };
    if (j.finished) return j;
    if (token != null && extra?.sendNotification) {
      const done = j.done ?? j.progress ?? 0;
      if (done !== last) {
        last = done;
        extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: done, total: j.total ?? undefined, message: j.status || '' } }).catch(() => {});
      }
    }
    if (extra?.signal?.aborted) {
      await fc.exec('jobs.cancel', { job }).catch(() => {});
      throw new Error('cancelled');
    }
  }
  throw new Error(`job ${job} still running after ${timeoutS}s (check fc_run jobs.list)`);
}

async function probe(path) {
  try {
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,size:stream=codec_type,codec_name,width,height,r_frame_rate,sample_rate,channels', '-of', 'json', path]);
    const j = JSON.parse(stdout);
    const st = (j.streams || []).map((s) => (s.codec_type === 'video' ? `${s.codec_name} ${s.width}x${s.height}@${s.r_frame_rate}` : `${s.codec_name} ${s.sample_rate}Hz ${s.channels}ch`)).join(', ');
    return `${(+j.format.duration).toFixed(2)}s ${(j.format.size / 1048576).toFixed(1)}MB ${st}`;
  } catch {
    try { return `${(statSync(path).size / 1048576).toFixed(1)}MB`; } catch { return 'file not found'; }
  }
}

// ---------- server ----------

const server = new McpServer(
  { name: 'filmcraft', version: '0.1.0' },
  {
    instructions: `Drives the running FilmCraft video editor (Premiere-style NLE). Everything in the app is a command id.
Workflow: fc_guide (recipes, ~once) → fc_find "words" to locate ids → fc_run / fc_batch → fc_seq to check the timeline → fc_frame / fc_sheet to look at the picture.
Time: ticks (254016000000/s). In any params you may write key_s (seconds, frame-snapped) or key_f (frames) instead of key, e.g. {"time_s":3.5}. Many commands also accept "seconds".
Outputs are compact text; ids are shown as #clip, i<item>, T#transition. Prefer engine commands over UI clicks; use fc_ui only for things without a command.`,
  },
);

const RO = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const RW = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };
const params = z.record(z.string(), z.any()).optional().describe('JSON params; key_s / key_f time sugar allowed');

server.registerTool('fc_app', {
  title: 'App status / launch',
  description: 'Connection + one-line project status. action: status (default; launches the app if needed) | restart (quit and relaunch with the control port) | quit | focus.',
  inputSchema: { action: z.enum(['status', 'restart', 'quit', 'focus']).optional() },
  annotations: { ...RW, destructiveHint: false },
}, safe(async ({ action = 'status' }) => {
  if (action === 'restart') {
    try { await fc.call('app.quit', {}, 5000); } catch { await run('osascript', ['-e', 'tell application "FilmCraft" to quit']).catch(() => {}); }
    fc.close();
    for (let i = 0; i < 40 && fc.appRunning(); i++) await new Promise((r) => setTimeout(r, 250));
    if (fc.appRunning()) return err('FilmCraft did not quit (unsaved-changes dialog?). Handle it in the app, then call fc_app again.');
  }
  if (action === 'quit') { await fc.call('app.quit', {}, 5000).catch(() => {}); fc.close(); return text('quit sent'); }
  if (action === 'focus') { await fc.call('ui.focus'); return text('focused'); }
  const [p, ui] = await Promise.all([fc.exec('project.inspect'), fc.call('ui.inspect')]);
  const seq = await fc.exec('sequence.inspect').catch(() => null);
  return text(`connected :${fc.port} | project "${p.name}"${p.dirty ? ' *unsaved*' : ''} path=${p.path ?? '-'} rev=${p.revision} | seq ${seq ? `#${seq.id} "${seq.name}" ${sec(seq.duration)}s playhead ${sec(seq.playhead)}s` : '-'} | mode ${ui.ui?.mode} ws ${ui.ui?.workspace} tool ${ui.ui?.tool} dialog ${ui.dialog ?? '-'} window ${ui.window?.join('x')}`);
}));

server.registerTool('fc_guide', {
  title: 'Recipes cheat-sheet',
  description: `Exact command recipes for common editing tasks. topic: ${GUIDE_TOPICS.join(' | ')} (omit for the overview).`,
  inputSchema: { topic: z.string().optional() },
  annotations: RO,
}, safe(async ({ topic }) => text(GUIDE[topic || 'overview'] ?? `unknown topic; one of: ${GUIDE_TOPICS.join(', ')}`)));

server.registerTool('fc_find', {
  title: 'Find commands',
  description: 'Search all ~800 commands (engine + menus) by words in id/label/menu/params. One line each: id — Label [Menu] (shortcut) {params}. ✗ = disabled now. Use instead of listing everything.',
  inputSchema: {
    q: z.string().describe('words, e.g. "razor", "speed duration", "transition video"; prefix "id:" for id prefix like "id:mixer."'),
    limit: z.number().int().optional().describe('default 25'),
    enabled_only: z.boolean().optional(),
  },
  annotations: RO,
}, safe(async ({ q, limit = 25, enabled_only }) => {
  const cat = await catalog();
  let hits;
  if (q.startsWith('id:')) hits = cat.filter((c) => c.id.startsWith(q.slice(3).trim())).map((c) => [c, 1]);
  else {
    const words = q.toLowerCase().split(/\s+/).filter(Boolean);
    hits = cat.map((c) => [c, score(c, words)]).filter(([, s]) => s > 0).sort((a, b) => b[1] - a[1]);
  }
  if (enabled_only) hits = hits.filter(([c]) => c.enabled !== false);
  const shown = hits.slice(0, limit).map(([c]) => fmtCmd(c));
  return text((shown.join('\n') || 'no match') + (hits.length > limit ? `\n… ${hits.length - limit} more` : ''));
}));

server.registerTool('fc_help', {
  title: 'Describe commands',
  description: 'Full untruncated entries (params signature, menu, shortcut, enabled) for exact command ids.',
  inputSchema: { ids: z.array(z.string()) },
  annotations: RO,
}, safe(async ({ ids }) => {
  const cat = await catalog();
  const out = [];
  for (const id of ids) {
    const c = cat.find((x) => x.id === id);
    out.push(c ? fmtCmd(c, true) : `${id}: unknown${await suggest(id)}`);
  }
  return text(out.join('\n'));
}));

server.registerTool('fc_run', {
  title: 'Run a command',
  description: 'Run any command id with params (edits are undoable: edit.undo). Returns minified result. then:"seq" appends the compact timeline so you need no extra call.',
  inputSchema: {
    id: z.string(),
    params,
    then: z.enum(['seq', 'none']).optional(),
    max_chars: z.number().int().optional().describe('result truncation, default 3000'),
  },
  annotations: RW,
}, safe(async ({ id, params: p, then, max_chars }, extra) => {
  if ((id === 'file.exportMedia' || id === 'export.quick') && p?.wait) return exportImpl({ ...p }, extra, id);
  const r = await runCmd(id, p);
  let out = compactJson(r, max_chars ?? 3000);
  if (then === 'seq') out += '\n' + (await seqText({ fx: true }));
  return text(out);
}));

server.registerTool('fc_batch', {
  title: 'Run many commands',
  description: 'Run steps in order: [{id, params}]. Each line of the reply: index ok/ERR id → short result. stop_on_error default true. then:"seq" appends the timeline.',
  inputSchema: {
    steps: z.array(z.object({ id: z.string(), params })),
    stop_on_error: z.boolean().optional(),
    then: z.enum(['seq', 'none']).optional(),
    max_chars: z.number().int().optional().describe('per-step result truncation, default 300'),
  },
  annotations: RW,
}, safe(async ({ steps, stop_on_error = true, then, max_chars = 300 }) => {
  const lines = [];
  let failed = 0;
  for (let i = 0; i < steps.length; i++) {
    const st = steps[i];
    try {
      const r = await runCmd(st.id, st.params);
      lines.push(`${i} ok ${st.id} → ${compactJson(r, max_chars)}`);
    } catch (e) {
      failed++;
      lines.push(`${i} ERR ${st.id} → ${e.message}`);
      if (stop_on_error) { lines.push(`stopped; ${steps.length - i - 1} not run`); break; }
    }
  }
  if (then === 'seq') lines.push(await seqText());
  const res = text(lines.join('\n'));
  if (failed) res.isError = true;
  return res;
}));

server.registerTool('fc_seq', {
  title: 'Timeline (compact)',
  description: 'Active sequence as compact text: header, each track with clips "#clip start-end s fStart+len "name" i<item> src@in fx:changed-params", transitions ~T#, markers, caption tracks C1… fx only lists non-default params (*Nk = N keyframes). track:"V1" to filter, item:<seq id> for another sequence.',
  inputSchema: { track: z.string().optional(), item: z.number().int().optional(), fx: z.boolean().optional().describe('default true'), markers: z.boolean().optional(), captions: z.boolean().optional() },
  annotations: RO,
}, safe(async (a) => text(await seqText(a))));

server.registerTool('fc_project', {
  title: 'Project tree (compact)',
  description: 'Bins and items: "i<id> "name" Type dur". paths:true adds media paths.',
  inputSchema: { paths: z.boolean().optional() },
  annotations: RO,
}, safe(async ({ paths }) => text(fmtProject(await fc.exec('project.inspect'), { paths }))));

server.registerTool('fc_clip', {
  title: 'Clip details',
  description: 'Every effect and parameter of one timeline clip (parsed values, keyframe counts, defaults marked), plus its transitions. Use to find exact effect/param names before effects.setParam.',
  inputSchema: { clip: z.number().int(), all: z.boolean().optional().describe('include params at default') },
  annotations: RO,
}, safe(async ({ clip, all }) => {
  const [seq, d] = await Promise.all([fc.exec('sequence.inspect'), defaults()]);
  const w = seq.settings?.width, h = seq.settings?.height;
  for (const kind of ['video', 'audio']) {
    for (const t of seq[kind] || []) {
      const c = (t.items || []).find((x) => x.clip === clip);
      if (!c) continue;
      const lines = [`#${clip} on ${t.name} ${sec(c.start)}-${sec(c.end)}s "${c.name}" i${c.item} src ${sec(c.sourceIn)}-${sec(c.sourceOut)}s speed ${c.speed} link ${c.link ?? '-'}`];
      (c.effects || []).forEach((fx, idx) => {
        lines.push(`[${idx}] ${fx.effect}${fx.enabled === false ? ' (off)' : ''}${fx.masks ? ` masks=${fx.masks}` : ''}`);
        const dd = d?.get(fx.effect) || {};
        for (const [name, p] of Object.entries(fx.params || {})) {
          const v = parseVal(p.value);
          const pi = dd[name];
          const def = pi && !(name === 'anchor' && pi.default?.Vec2?.x == null) ? parseDefault(pi.default, w, h) : undefined;
          const isDef = def !== undefined && same(def, v);
          if (isDef && !all && !p.keyframes) continue;
          const shown = choiceName(pi, v);
          lines.push(`    ${name}=${JSON.stringify(shown)}${shown !== v ? `(#${v})` : ''}${p.keyframes ? ` keyframes=${p.keyframes}` : ''}${def !== undefined && !isDef ? ` (default ${JSON.stringify(choiceName(pi, def))})` : ''}${pi?.min != null ? ` [${pi.min}..${pi.max}]` : ''}`);
        }
      });
      for (const x of t.transitions || []) if (x.from === clip || x.to === clip) lines.push(`transition T#${x.id} ${x.effect} ${sec(x.start)}+${sec(x.duration)}s ${x.from ?? '∅'}→${x.to ?? '∅'} ${JSON.stringify(x.params)}`);
      if (!all) lines.push('(params at default hidden; all:true shows them)');
      return text(lines.join('\n'));
    }
  }
  return err(`clip #${clip} not in the active sequence`);
}));

server.registerTool('fc_effects', {
  title: 'Find effects / transitions',
  description: 'Search the effects & transitions catalog. ≤6 hits show params with type, default and range; more hits list id "Name" [folder] kind.',
  inputSchema: {
    q: z.string().optional().describe('words in id/name/folder, e.g. "blur", "dissolve", "lumetri"'),
    kind: z.enum(['Video', 'Audio', 'VideoTransition', 'AudioTransition']).optional(),
    detail: z.boolean().optional(),
    limit: z.number().int().optional(),
  },
  annotations: RO,
}, safe(async ({ q = '', kind, detail, limit = 40 }) => {
  const cat = await effectsCatalog();
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = cat.filter((e) => (!kind || e.kind === kind) && words.every((w) => `${e.id} ${e.name} ${e.path || ''} ${e.folder || ''}`.toLowerCase().includes(w)));
  const full = detail ?? hits.length <= 6;
  const out = hits.slice(0, limit).map((e) => {
    let s = `${e.id} "${e.name}" [${e.path || e.folder || '-'}] ${e.kind}`;
    if (full) s += '\n' + (e.paramInfo || []).map((p) => `    ${p.id}: ${p.type}${p.default ? ' =' + JSON.stringify(parseDefault(p.default)) : ''}${p.min != null ? ` [${p.min}..${p.max}]` : ''}${p.choices ? ' ' + JSON.stringify(p.choices) : ''}${p.options ? ' ' + JSON.stringify(p.options) : ''}${p.animatable === false ? ' static' : ''}`).join('\n');
    else s += ` (${(e.params || []).length}p)`;
    return s;
  });
  return text((out.join('\n') || 'no match') + (hits.length > limit ? `\n… ${hits.length - limit} more` : ''));
}));

server.registerTool('fc_frame', {
  title: 'Render a frame',
  description: 'The rendered sequence frame (true export render, not a screenshot) at seconds (default playhead) as a small JPEG. target:"source" renders the Source monitor clip.',
  inputSchema: {
    seconds: z.number().optional(),
    width: z.number().int().optional().describe('default 640'),
    target: z.enum(['program', 'source']).optional(),
  },
  annotations: RO,
}, safe(async ({ seconds, width = 640, target }) => {
  const { path, r } = await exportFrame(seconds, target ? { target } : {});
  const b64 = await shrink(path, { width });
  rmSync(path, { force: true });
  return image(b64, 'image/jpeg', `${target || 'program'} @ ${sec(r.time)}s (${r.width}x${r.height})`);
}));

server.registerTool('fc_sheet', {
  title: 'Contact sheet',
  description: 'Many frames in ONE small image to review an edit cheaply. at:"clips" = middle of every V1..Vn clip (default), "even" = n evenly spaced frames between from/to, or give times[]. Cells are numbered left→right; the text lists each cell\'s time.',
  inputSchema: {
    at: z.enum(['clips', 'even']).optional(),
    times: z.array(z.number()).optional().describe('seconds'),
    n: z.number().int().optional().describe('frames for even, default 8'),
    from: z.number().optional(),
    to: z.number().optional(),
    cols: z.number().int().optional().describe('default 4'),
    cell: z.number().int().optional().describe('cell width px, default 240'),
  },
  annotations: RO,
}, safe(async ({ at = 'clips', times, n = 8, from, to, cols = 4, cell = 240 }) => {
  const seq = await fc.exec('sequence.inspect');
  let ts = times;
  if (!ts) {
    if (at === 'clips') {
      const mids = [];
      for (const t of seq.video || []) for (const c of t.items || []) mids.push([(c.start + c.end) / 2 / TPS, `#${c.clip}`]);
      mids.sort((a, b) => a[0] - b[0]);
      ts = mids.slice(0, 48).map((m) => m[0]);
      ts.labels = mids.slice(0, 48).map((m) => m[1]);
    } else {
      const a = from ?? 0, b = to ?? seq.duration / TPS;
      ts = Array.from({ length: n }, (_, i) => a + ((b - a) * (i + 0.5)) / n);
    }
  }
  if (!ts.length) return err('nothing to show (empty sequence)');
  const dir = mkdtempSync(join(WORK, 'sheet'));
  const notes = [];
  for (let i = 0; i < ts.length; i++) {
    const p = join(dir, `f${String(i).padStart(3, '0')}.png`);
    await fc.exec('file.exportFrame', { path: p, format: 'png', time: Math.round(ts[i] * TPS) });
    notes.push(`${i + 1}:${ts[i].toFixed(2)}s${ts.labels ? ' ' + ts.labels[i] : ''}`);
  }
  const c = Math.min(cols, ts.length), rows = Math.ceil(ts.length / c);
  const out = join(dir, 'sheet.jpg');
  await run(FFMPEG, ['-y', '-loglevel', 'error', '-framerate', '1', '-i', join(dir, 'f%03d.png'), '-vf', `scale=${cell}:-2,tile=${c}x${rows}:padding=4:margin=2:color=white`, '-frames:v', '1', '-q:v', '5', out]);
  const b64 = readFileSync(out).toString('base64');
  rmSync(dir, { recursive: true, force: true });
  return image(b64, 'image/jpeg', notes.join('  '));
}));

server.registerTool('fc_shot', {
  title: 'Screenshot the app',
  description: 'Screenshot of the app window or one panel (Timeline, Program, Source, Project, EffectControls, Lumetri, Essential Graphics, …) as a downscaled JPEG.',
  inputSchema: { panel: z.string().optional(), width: z.number().int().optional().describe('default 1000') },
  annotations: RO,
}, safe(async ({ panel, width = 1000 }) => {
  const path = tmp('png');
  const r = await fc.call('ui.screenshot', panel ? { path, panel } : { path }, 30000);
  const b64 = await shrink(path, { width });
  rmSync(path, { force: true });
  return image(b64, 'image/jpeg', `${panel || 'window'} ${r.width}x${r.height}px; coordinates for fc_ui are in points (px / pixelsPerPoint)`);
}));

server.registerTool('fc_ui', {
  title: 'Drive the UI',
  description: `Mouse/keyboard/UI-state. action:
elements {prefix?, q?, limit?} → "id "label" @x,y,w,h" (points)
inspect {full?} → tool/workspace/mode/dialog/playback (full = raw JSON)
click {id | x,y, button?, count?, modifiers?} · move {id|x,y}
drag {from:{id|x,y,fx?,fy?}, to:{…}, steps?, modifiers?} · scroll {id|x,y, dx, dy}
key {key:"Cmd+K"} · type {text}
set {state} (ui.set: tool, workspace, mode, program/source monitor, panels, export, dialogs…)
panel {name, close?} · playback {play|stop|toggle, speed?} · hit {x,y} · locate {clip, edge?}`,
  inputSchema: {
    action: z.enum(['elements', 'inspect', 'click', 'move', 'drag', 'scroll', 'key', 'type', 'set', 'panel', 'playback', 'hit', 'locate']),
    id: z.string().optional(), x: z.number().optional(), y: z.number().optional(),
    button: z.string().optional(), count: z.number().int().optional(), modifiers: z.any().optional(),
    from: z.any().optional(), to: z.any().optional(), steps: z.number().int().optional(),
    dx: z.number().optional(), dy: z.number().optional(),
    key: z.string().optional(), text: z.string().optional(),
    prefix: z.string().optional(), q: z.string().optional(), limit: z.number().int().optional(), full: z.boolean().optional(),
    state: z.record(z.string(), z.any()).optional(), name: z.string().optional(), close: z.boolean().optional(),
    play: z.enum(['play', 'stop', 'toggle']).optional(), speed: z.number().optional(),
    clip: z.number().int().optional(), edge: z.string().optional(),
  },
  annotations: RW,
}, safe(async (a) => {
  const pick = (...keys) => Object.fromEntries(keys.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
  switch (a.action) {
    case 'elements': return text(fmtElements(await fc.call('ui.elements', { prefix: a.prefix || '' }), { q: a.q, limit: a.limit }));
    case 'inspect': {
      const u = await fc.call('ui.inspect');
      if (a.full) return text(compactJson(u, 20000));
      const ui = u.ui || {};
      return text(compactJson({ mode: ui.mode, workspace: ui.workspace, tool: ui.tool, focused: ui.focused, dialog: u.dialog, clip_dialog: ui.clip_dialog, playhead_s: +(u.playhead / TPS).toFixed(3), selection: u.selection, playback: u.playback, window: u.window, ppp: u.pixelsPerPoint, status: ui.status, text_tab: ui.text_tab, gfx_edit: ui.gfx_edit }));
    }
    case 'click': return text(compactJson(await fc.call('ui.click', pick('id', 'x', 'y', 'button', 'count', 'modifiers'))));
    case 'move': return text(compactJson(await fc.call('ui.move', pick('id', 'x', 'y'))));
    case 'drag': return text(compactJson(await fc.call('ui.drag', pick('from', 'to', 'steps', 'modifiers'))));
    case 'scroll': return text(compactJson(await fc.call('ui.scroll', pick('id', 'x', 'y', 'dx', 'dy', 'modifiers'))));
    case 'key': return text(compactJson(await fc.call('ui.key', { key: a.key })));
    case 'type': return text(compactJson(await fc.call('ui.type', { text: a.text })));
    case 'set': return text(compactJson(await fc.call('ui.set', a.state || {})));
    case 'panel': return text(compactJson(await fc.call(a.close ? 'ui.panel.close' : 'ui.panel.show', { panel: a.name })));
    case 'playback': return text(compactJson(await fc.call('ui.playback', { action: a.play || 'toggle', ...(a.speed ? { speed: a.speed } : {}) })));
    case 'hit': return text(compactJson(await fc.call('ui.timeline.hit', pick('x', 'y', 'modifiers'))));
    case 'locate': return text(compactJson(await fc.call('ui.timeline.locate', pick('clip', 'edge'))));
  }
  return err('unknown action');
}));

server.registerTool('fc_control', {
  title: 'Raw control method',
  description: 'Escape hatch: call any control-channel method (engine.execute, ui.*, perf.stats, …) with raw params. Prefer the dedicated tools.',
  inputSchema: { method: z.string(), params, max_chars: z.number().int().optional() },
  annotations: RW,
}, safe(async ({ method, params: p, max_chars }) => text(compactJson(await fc.call(method, await sugar(p || {})), max_chars ?? 4000))));

function findClip(seq, clip) {
  for (const kind of ['video', 'audio']) for (const t of seq[kind] || []) { const c = (t.items || []).find((x) => x.clip === clip); if (c) return c; }
  return null;
}

server.registerTool('fc_keys', {
  title: 'Animate a parameter',
  description: 'Set keyframes on one effect parameter in one call: keys [[seconds (sequence time), value], …]. Turns animation on, writes every key, sets interpolation (ease: linear|bezier|autoBezier|continuousBezier|hold|easeIn|easeOut). E.g. Ken Burns: {clip:13, effect:"motion", param:"scale", keys:[[0,100],[3,120]], ease:"bezier"}. clear:true removes existing animation first.',
  inputSchema: {
    clip: z.number().int(),
    effect: z.union([z.string(), z.number().int()]).describe('effect id on the clip (motion, opacity, volume, lumetri, gaussian_blur…) or index'),
    param: z.string(),
    keys: z.array(z.tuple([z.number(), z.any()])).min(1),
    ease: z.string().optional(),
    clear: z.boolean().optional(),
  },
  annotations: RW,
}, safe(async ({ clip, effect, param, keys, ease, clear }) => {
  const kfCount = async () => {
    const c = findClip(await fc.exec('sequence.inspect'), clip);
    if (!c) throw new Error(`clip #${clip} not found`);
    const fx = typeof effect === 'number' ? c.effects[effect] : c.effects.find((e) => e.effect === effect);
    if (!fx) throw new Error(`effect ${effect} not on clip #${clip} (has: ${c.effects.map((e) => e.effect).join(', ')})`);
    if (!fx.params[param]) throw new Error(`param ${param} not on ${fx.effect} (has: ${Object.keys(fx.params).join(', ')})`);
    return { c, n: fx.params[param].keyframes || 0 };
  };
  const fps = await seqFps();
  const ft = TPS / fps;
  const snap = (s) => Math.round(Math.round((s * TPS) / ft) * ft);
  const sorted = [...keys].sort((a, b) => a[0] - b[0]);
  let { c, n } = await kfCount();
  const before = (await fc.call('ui.inspect')).playhead;
  if (n > 0 && clear) { await fc.exec('effects.toggleAnimation', { clip, effect, param }); n = 0; }
  if (n === 0) {
    // the stopwatch writes a key at the playhead: put the playhead on the first key so it is overwritten
    await fc.exec('playhead.set', { time: snap(sorted[0][0]) });
    await fc.exec('effects.setParam', { clip, effect, param, value: sorted[0][1] });
    await fc.exec('effects.toggleAnimation', { clip, effect, param });
  }
  for (const [t, v] of sorted) await fc.exec('effects.setParam', { clip, effect, param, value: v, time: snap(t) });
  if (ease) {
    for (const [t] of sorted) {
      const tt = Math.min(Math.max(snap(t), c.start), c.end - 1);
      const mediaTime = Math.round(c.sourceIn + (tt - c.start) * (c.speed || 1));
      await fc.exec('effects.setInterpolation', { clip, effect, param, mediaTime, interpolation: ease }).catch(() => {});
    }
  }
  if (before != null) await fc.exec('playhead.set', { time: before }).catch(() => {});
  ({ n } = await kfCount());
  return text(`#${clip} ${effect}.${param}: ${n} keyframes (${sorted.map(([t, v]) => `${t}s=${JSON.stringify(v)}`).join(', ')})${ease ? ' ' + ease : ''}`);
}));

server.registerTool('fc_append', {
  title: 'Assemble clips',
  description: 'Place project items one after another on a track (a rough cut in one call). clips: [{item, in?, dur?} (seconds; in = source in, dur default = rest of the item)]. start = seconds (default: end of that track). transition: video transition id between neighbours (e.g. cross_dissolve) with trans_frames. video/audio false = picture/sound only. Returns clip ids and the timeline.',
  inputSchema: {
    clips: z.array(z.object({ item: z.number().int(), in: z.number().optional(), dur: z.number().optional() })).min(1),
    track: z.string().optional().describe('default V1 (or A1.. for sound only)'),
    audioTrack: z.string().optional(),
    start: z.number().optional(),
    gap: z.number().optional().describe('seconds between clips, default 0'),
    video: z.boolean().optional(), audio: z.boolean().optional(),
    transition: z.string().optional(), trans_frames: z.number().int().optional(),
    fill: z.boolean().optional().describe('scale to fill the frame (vertical reels from 16:9 footage)'),
  },
  annotations: RW,
}, safe(async ({ clips, track = 'V1', audioTrack, start, gap = 0, video, audio, transition, trans_frames = 15, fill }) => {
  const fps = await seqFps();
  const ft = TPS / fps;
  const snap = (s) => Math.round(Math.round((s * TPS) / ft) * ft);
  const seq = await fc.exec('sequence.inspect');
  const proj = await fc.exec('project.inspect');
  const items = new Map();
  const walk = (n) => { if (n.item != null) items.set(n.item, n); (n.children || []).forEach(walk); };
  walk(proj.root);
  let t;
  if (start != null) t = snap(start);
  else {
    const all = [...(seq.video || []), ...(seq.audio || [])];
    const idx = /^V(\d+)$/i.test(track) ? ['video', Number(track.slice(1)) - 1] : /^A(\d+)$/i.test(track) ? ['audio', Number(track.slice(1)) - 1] : null;
    const tr = idx ? seq[idx[0]]?.[idx[1]] : all.find((x) => String(x.id) === String(track));
    t = Math.max(0, ...((tr?.items || []).map((c) => c.end)));
  }
  const made = [];
  for (const cl of clips) {
    const it = items.get(cl.item);
    if (!it) throw new Error(`item i${cl.item} not in project`);
    const srcIn = snap(cl.in ?? 0);
    const dur = cl.dur != null ? snap(cl.dur) : Math.max(ft, Math.floor(((it.duration || 5 * TPS) - srcIn) / ft) * ft);
    const p = { item: cl.item, track, time: t, sourceIn: srcIn, duration: dur };
    if (audioTrack) p.audioTrack = audioTrack;
    if (video === false) p.video = false;
    if (audio === false) p.audio = false;
    const r = await fc.exec('timeline.place', p);
    made.push(r?.clips || []);
    t += dur + snap(gap);
  }
  const firsts = made.map((m) => m[0]).filter((x) => x != null);
  if (fill) await fc.exec('clip.fillFrame', { clips: firsts }).catch(() => {});
  if (transition) for (const id of firsts.slice(1)) await fc.exec('sequence.applyVideoTransition', { clip: id, effect: transition, frames: trans_frames, edge: 'in' }).catch(() => {});
  return text(`placed ${made.map((m) => '[' + m.join(',') + ']').join(' ')} ends ${sec(t - snap(gap))}s\n` + (await seqText({ track: undefined })));
}));

async function exportImpl(p, extra, id = 'file.exportMedia') {
  if (p.path) p.path = resolvePath(p.path);
  const t0 = Date.now();
  const start = await runCmd(id, { ...p, wait: false });
  const job = start?.job;
  let res = null;
  if (job != null) {
    const j = await waitJob(job, extra, p.timeout_s || 3600);
    res = j.result;
    if (res?.error) return err(`export failed: ${res.error}`);
  }
  const path = start?.path || p.path;
  return text(`exported ${path} in ${((Date.now() - t0) / 1000).toFixed(1)}s | ${path ? await probe(path) : ''}${res ? ' | ' + compactJson(res, 400) : ''}`);
}

server.registerTool('fc_export', {
  title: 'Export media (waits)',
  description: 'Export the active sequence and wait until the file is written (progress notifications, cancellable). Returns path, time, ffprobe summary. Params as file.exportMedia: path (required), preset?, format? (h264|hevc|prores|…), width/height/fps/bitrateKbps?, range? etc. — see fc_help file.exportMedia / fc_find "export preset".',
  inputSchema: { path: z.string(), opts: params.describe('other file.exportMedia params') },
  annotations: { ...RW, destructiveHint: false },
}, safe(async ({ path, opts }, extra) => exportImpl({ ...(opts || {}), path }, extra)));

const transport = new StdioServerTransport();
await server.connect(transport);
process.on('exit', () => { try { rmSync(WORK, { recursive: true, force: true }); } catch {} });
