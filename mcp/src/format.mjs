// Compact, token-lean text renderings of FilmCraft JSON.

export const TPS = 254016000000; // ticks per second

export const sec = (t) => (t == null ? '-' : (t / TPS).toFixed(2));

// ---------- effect parameter values ----------

/** Engine param value string ("Float(100.0)", "Vec2(Vec2 { x: 1.0, y: 2.0 })", …) → JS value. */
export function parseVal(v) {
  if (v == null || typeof v !== 'string') return v;
  let m;
  if ((m = v.match(/^Float\(([-\d.eE+]+|NaN|inf|-inf)\)$/))) return Number(m[1]);
  if ((m = v.match(/^Bool\((true|false)\)$/))) return m[1] === 'true';
  if ((m = v.match(/^(?:Choice|Int)\((-?\d+)\)$/))) return Number(m[1]);
  if ((m = v.match(/^Vec2\(.*?x: ([-\d.eE+]+), y: ([-\d.eE+]+)/))) return [Number(m[1]), Number(m[2])];
  if ((m = v.match(/^Color\((\[.*\])\)$/))) return hex(JSON.parse(m[1]));
  if ((m = v.match(/^Curve\((\[.*\])\)$/s))) { try { return JSON.parse(m[1]); } catch { /* fall through */ } }
  if ((m = v.match(/^(?:Text|String|Path)\("(.*)"\)$/s))) return m[1];
  return v.length > 60 ? v.slice(0, 57) + '…' : v;
}

const hex = (c) =>
  '#' + c.slice(0, c[3] != null && c[3] < 1 ? 4 : 3).map((x) => Math.round(Math.min(1, Math.max(0, Number(x))) * 255).toString(16).padStart(2, '0')).join('');

/** Default from effects.list detail ({"Float":100}, {"Vec2":{x:null,y:null}}, …) → JS value. */
export function parseDefault(d, w = 1920, h = 1080) {
  if (d == null || typeof d !== 'object') return d;
  const [k, v] = Object.entries(d)[0] ?? [];
  if (k === 'Vec2') return [v?.x ?? w / 2, v?.y ?? h / 2];
  if (k === 'Color' && Array.isArray(v)) return hex(v);
  return v;
}

/** A choice index as its option label ("Multiply"), anything else unchanged. */
export const choiceName = (pi, v) => (pi?.options && typeof v === 'number' && pi.options[v] != null ? pi.options[v] : v);

export function same(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-4;
  return a === b;
}

const fmtVal = (v) =>
  Array.isArray(v)
    ? v.every((x) => typeof x === 'number') ? v.map((x) => +x.toFixed(2)).join(',') : JSON.stringify(v)
    : typeof v === 'number' ? String(+v.toFixed(3)) : typeof v === 'string' && /\s/.test(v) ? JSON.stringify(v) : String(v);

const INTRINSIC = new Set(['motion', 'opacity', 'time_remap', 'volume', 'channel_volume', 'panner']);

/**
 * One effect as "name(p=v,q=v*3k)": only parameters that differ from the default or are animated.
 * Returns null for an untouched intrinsic effect (motion/opacity/volume…).
 */
export function fmtEffect(fx, defaults, w, h) {
  const info = defaults?.get(fx.effect) || {};
  const changed = [];
  for (const [name, p] of Object.entries(fx.params || {})) {
    const val = parseVal(p.value);
    const kf = p.keyframes || 0;
    const pi = info[name];
    // a null Vec2 default means "centre of the clip's own frame", which we don't know (anchor)
    const d = pi && !(pi.default?.Vec2?.x == null && pi.default?.Vec2 && name === 'anchor') ? parseDefault(pi.default, w, h) : undefined;
    // shown when animated, or when it differs from a known default
    if (kf > 0 || (d !== undefined && !same(val, d))) changed.push(`${name}=${fmtVal(choiceName(pi, val))}${kf ? `*${kf}k` : ''}`);
  }
  const off = fx.enabled === false ? '!off' : '';
  const masks = fx.masks ? `+${fx.masks}mask` : '';
  if (!changed.length && !off && !masks && INTRINSIC.has(fx.effect)) return null;
  return `${fx.effect}${off}${masks}${changed.length ? `(${changed.join(' ')})` : ''}`;
}

// ---------- sequence ----------

export function fpsOf(seq) {
  const fr = seq?.settings?.frame_rate;
  return fr && fr.num ? fr.num / fr.den : 0;
}

function fmtClip(c, defaults, w, h, opts) {
  const parts = [`#${c.clip}`, `${sec(c.start)}-${sec(c.end)}s`, `f${c.startFrame}+${c.durationFrames}`, JSON.stringify(c.name)];
  if (c.item != null) parts.push(`i${c.item}`);
  parts.push(`src@${sec(c.sourceIn)}`);
  if (c.speed != null && Math.abs(c.speed - 1) > 1e-6) parts.push(`spd${+(c.speed * 100).toFixed(1)}%`);
  if (c.reverse) parts.push('rev');
  if (c.gainDb) parts.push(`gain${c.gainDb}dB`);
  if (c.enabled === false) parts.push('DISABLED');
  if (c.link != null) parts.push(`link#${c.link}`);
  if (opts.fx !== false) {
    const fx = (c.effects || []).map((e) => fmtEffect(e, defaults, w, h)).filter(Boolean);
    if (fx.length) parts.push('fx:' + fx.join(' '));
  }
  for (const k of Object.keys(c)) {
    if (!KNOWN_CLIP_KEYS.has(k) && c[k] != null && c[k] !== false && JSON.stringify(c[k]).length < 80) parts.push(`${k}=${JSON.stringify(c[k])}`);
  }
  return parts.join(' ');
}
const KNOWN_CLIP_KEYS = new Set(['clip', 'start', 'end', 'startFrame', 'endFrame', 'duration', 'durationFrames', 'name', 'item', 'sourceIn', 'sourceOut', 'speed', 'reverse', 'gainDb', 'enabled', 'link', 'effects', 'label']);

function fmtTrack(kind, t, i, defaults, w, h, opts) {
  const flags = [t.locked && 'LOCKED', t.muted && 'muted', t.solo && 'solo', t.enabled === false && 'off'].filter(Boolean).join(',');
  const lines = [`${kind}${i + 1} #${t.id} "${t.name}"${flags ? ' [' + flags + ']' : ''}${t.items?.length ? '' : ' (empty)'}`];
  for (const c of t.items || []) lines.push('  ' + fmtClip(c, defaults, w, h, opts));
  for (const x of t.transitions || []) {
    const ps = Object.entries(x.params || {}).map(([k, v]) => `${k}=${fmtVal(typeof v === 'object' ? Object.values(v)[0] : v)}`).join(' ');
    lines.push(`  ~T#${x.id} ${x.effect} ${sec(x.start)}+${sec(x.duration)}s ${x.from ?? '∅'}→${x.to ?? '∅'}${x.reverse ? ' rev' : ''}${ps ? ' (' + ps + ')' : ''}`);
  }
  return lines;
}

export function fmtSequence(seq, defaults, opts = {}) {
  if (!seq) return 'no active sequence';
  const s = seq.settings || {};
  const fps = fpsOf(seq);
  const head = [
    `SEQ #${seq.id} "${seq.name}" ${s.width}x${s.height} ${fps ? +fps.toFixed(3) : '?'}fps ${s.sample_rate || ''}Hz`,
    `dur ${sec(seq.duration)}s (${seq.durationFrames}f) playhead ${sec(seq.playhead)}s in ${sec(seq.in)} out ${sec(seq.out)} sel [${(seq.selection || []).join(',')}]`,
  ];
  const lines = [...head];
  const want = (kind, i, t) => !opts.track || opts.track === `${kind}${i + 1}` || String(t.id) === String(opts.track);
  (seq.video || []).forEach((t, i) => want('V', i, t) && lines.push(...fmtTrack('V', t, i, defaults, s.width, s.height, opts)));
  (seq.audio || []).forEach((t, i) => want('A', i, t) && lines.push(...fmtTrack('A', t, i, defaults, s.width, s.height, opts)));
  for (const key of Object.keys(seq)) {
    if (['video', 'audio', 'settings', 'markers', 'id', 'name', 'duration', 'durationFrames', 'playhead', 'in', 'out', 'selection', 'split'].includes(key)) continue;
    const v = seq[key];
    if (Array.isArray(v) && v.length) lines.push(`${key}: ${JSON.stringify(v).slice(0, 1500)}`);
  }
  if (seq.markers?.length && opts.markers !== false) {
    lines.push('markers: ' + seq.markers.map((m) => `${sec(m.start)}${m.duration ? '+' + sec(m.duration) : ''} "${m.name}"${m.color ? ' ' + m.color : ''}${m.kind && m.kind !== 'Comment' ? ' ' + m.kind : ''}#${m.id}`).join('; '));
  }
  return lines.join('\n');
}

// ---------- project ----------

export function fmtProject(p, opts = {}) {
  const lines = [`PROJECT "${p.name}"${p.dirty ? ' *unsaved*' : ''} path=${p.path ?? '-'} activeSeq=${p.activeSequence ?? '-'} source=${p.sourceItem ?? '-'}`];
  const walk = (n, d) => {
    const pad = '  '.repeat(d);
    if (n.children) {
      if (d > 0) lines.push(`${pad}[bin#${n.id}] ${n.name}`);
      for (const c of n.children) walk(c, d + (d > 0 || n.children ? 1 : 0));
    } else {
      const extra = Object.entries(n)
        .filter(([k, v]) => !['item', 'name', 'type', 'duration', 'label', 'children'].includes(k) && v != null && (opts.paths || k !== 'path'))
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      lines.push(`${pad}i${n.item} ${JSON.stringify(n.name)} ${n.type}${n.duration ? ' ' + sec(n.duration) + 's' : ''}${extra ? ' ' + extra : ''}`);
    }
  };
  if (p.root) for (const c of p.root.children || []) walk(c, 0);
  return lines.join('\n');
}

// ---------- generic ----------

/** Minified JSON with tick fields annotated, truncated. */
export function compactJson(v, max = 3000) {
  let s;
  try { s = JSON.stringify(v); } catch { s = String(v); }
  if (s === undefined) s = 'null';
  if (s.length > max) s = s.slice(0, max) + `… [+${s.length - max} chars; pass max_chars to see more]`;
  return s;
}

export function fmtElements(els, { q, limit = 120 } = {}) {
  let list = els || [];
  if (q) {
    const ql = q.toLowerCase();
    list = list.filter((e) => e.id.toLowerCase().includes(ql) || (e.label || '').toLowerCase().includes(ql));
  }
  const out = list.slice(0, limit).map((e) => {
    const r = e.rect || [];
    return `${e.id}${e.label && e.label !== e.id ? ` "${e.label}"` : ''} @${r.map((x) => Math.round(x)).join(',')}`;
  });
  if (list.length > limit) out.push(`… ${list.length - limit} more (narrow with prefix/q)`);
  return out.join('\n') || '(no elements)';
}
