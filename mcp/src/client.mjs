// JSON-lines client for FilmCraft's control channel (`FilmCraft --control <port>`).
// One persistent connection, requests matched by id, reconnect + optional app auto-launch.

import net from 'node:net';
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const DEFAULT_APP = '/Applications/FilmCraft.app/Contents/MacOS/FilmCraft';

export class FcClient {
  constructor({ host = '127.0.0.1', port = 9876, appPath = DEFAULT_APP, autoLaunch = true } = {}) {
    this.host = host;
    this.port = port;
    this.appPath = appPath;
    this.autoLaunch = autoLaunch;
    this.sock = null;
    this.buf = '';
    this.pending = new Map();
    this.nextId = 1;
    this.connecting = null;
  }

  appRunning() {
    try {
      execFileSync('pgrep', ['-x', 'FilmCraft'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  #open() {
    return new Promise((resolve, reject) => {
      const s = net.createConnection({ host: this.host, port: this.port });
      const onErr = (e) => { s.destroy(); reject(e); };
      s.once('error', onErr);
      s.setTimeout(5000, () => onErr(new Error('connect timeout')));
      s.once('connect', () => {
        s.setTimeout(0);
        s.off('error', onErr);
        s.setEncoding('utf8');
        s.on('data', (d) => this.#onData(d));
        s.on('error', () => {});
        s.on('close', () => this.#onClose());
        resolve(s);
      });
    });
  }

  #onData(d) {
    this.buf += d;
    let nl;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; }
      // the server answers in order; fall back to the oldest request when the id is missing
      const key = this.pending.has(msg.id) ? msg.id : this.pending.keys().next().value;
      const p = this.pending.get(key);
      if (!p) continue;
      this.pending.delete(key);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result ?? null);
      else p.reject(new Error(msg.error || 'error'));
    }
  }

  #onClose() {
    this.sock = null;
    this.buf = '';
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('connection to FilmCraft closed'));
    }
    this.pending.clear();
  }

  async launch() {
    if (!existsSync(this.appPath)) throw new Error(`FilmCraft not found at ${this.appPath} (set FILMCRAFT_APP)`);
    const child = spawn(this.appPath, ['--control', String(this.port)], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, FILMCRAFT_CONTROL_PORT: String(this.port) },
    });
    child.unref();
    const until = Date.now() + 45000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 500));
      try { return await this.#open(); } catch { /* not up yet */ }
    }
    throw new Error('FilmCraft started but the control port never opened');
  }

  async ensure() {
    if (this.sock) return this.sock;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      try {
        this.sock = await this.#open();
      } catch (e) {
        if (!this.autoLaunch) throw new Error(`cannot reach FilmCraft on ${this.host}:${this.port} (${e.message}); start it with --control ${this.port}`);
        if (this.appRunning()) {
          throw new Error(`FilmCraft is running without the control port. Save your work and quit it, or call fc_app {action:"restart"} (it relaunches with --control ${this.port}).`);
        }
        this.sock = await this.launch();
      }
      return this.sock;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  async call(method, params = {}, timeoutMs = 90000) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const sock = await this.ensure();
      const id = this.nextId++;
      try {
        return await new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`timeout after ${timeoutMs} ms waiting for ${method}`));
          }, timeoutMs);
          this.pending.set(id, { resolve, reject, timer });
          sock.write(JSON.stringify({ id, method, params }) + '\n');
        });
      } catch (e) {
        if (attempt === 0 && /connection to FilmCraft closed/.test(e.message)) continue;
        throw e;
      }
    }
    throw new Error('unreachable');
  }

  exec(command, params = {}, timeoutMs) {
    return this.call('engine.execute', { command, params }, timeoutMs);
  }

  close() {
    this.sock?.destroy();
  }
}
