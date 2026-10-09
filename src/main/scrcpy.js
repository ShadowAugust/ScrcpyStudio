// scrcpy process/session manager plus parsers for its --list-* queries.
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { run, tools, scrcpyEnv, IS_WIN } = require('./tools');

const MAX_LOG_LINES = 2000;

class ScrcpyService extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.seq = 0;
    this.appCache = new Map();
  }

  list() {
    return [...this.sessions.values()].map(s => this.publicSession(s));
  }

  publicSession(s) {
    const { child, logs, stopTimer, stopFn, ...pub } = s;
    return { ...pub, logCount: logs.length };
  }

  getLogs(id) {
    return this.sessions.get(id)?.logs || [];
  }

  start({ serial, args = [], label, mode = 'mirror', profileName, recordPath, env }) {
    if (!tools.scrcpy) return { ok: false, error: 'scrcpy was not found. Set its path in Settings.' };
    const id = `session-${++this.seq}`;
    const fullArgs = serial ? ['-s', serial, ...args] : args;
    if (recordPath) fs.mkdirSync(path.dirname(recordPath), { recursive: true });

    let child;
    try {
      child = spawn(tools.scrcpy, fullArgs, { env: { ...scrcpyEnv(), ...(env || {}) }, windowsHide: true, cwd: path.dirname(tools.scrcpy) });
    } catch (e) {
      return { ok: false, error: e.message };
    }
    const session = {
      id, serial, label: label || serial, mode, profileName: profileName || null,
      args: fullArgs, command: [path.basename(tools.scrcpy), ...fullArgs],
      pid: child.pid, status: 'starting', studio: !!env?.SCRCPY_SERVER_PATH, startedAt: Date.now(), endedAt: null,
      exitCode: null, recordPath: recordPath || null, error: null,
      info: {}, logs: [], child, stopTimer: null, stopping: false,
    };
    this.sessions.set(id, session);

    const onLine = (line, stream) => {
      if (!line.trim()) return;
      const entry = { t: Date.now(), line, stream, level: levelOf(line) };
      session.logs.push(entry);
      if (session.logs.length > MAX_LOG_LINES) session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
      this.parseInfo(session, line);
      if (entry.level === 'error' && !session.error) session.error = line.replace(/^.*?ERROR:\s*/, '');
      this.emit('event', { type: 'log', id, entry });
    };
    lineReader(child.stdout, (l) => onLine(l, 'out'));
    lineReader(child.stderr, (l) => onLine(l, 'err'));

    child.on('error', (e) => {
      session.status = 'failed';
      session.error = e.message;
      this.emit('event', { type: 'update', session: this.publicSession(session) });
    });
    child.on('close', (code) => {
      clearTimeout(session.stopTimer);
      session.exitCode = code;
      session.endedAt = Date.now();
      session.status = session.stopping || code === 0 ? 'stopped' : 'failed';
      if (session.status === 'failed' && !session.error) {
        session.error = code === 2 ? 'Device disconnected' : `scrcpy exited with code ${code}`;
      }
      if (session.recordPath && !fs.existsSync(session.recordPath)) session.recordPath = null;
      this.emit('event', { type: 'update', session: this.publicSession(session) });
      this.emit('ended', this.publicSession(session));
    });

    // Headless modes may never print a window/texture line; assume healthy after a few seconds.
    setTimeout(() => {
      if (session.status === 'starting' && !session.endedAt) {
        session.status = 'running';
        this.emit('event', { type: 'update', session: this.publicSession(session) });
      }
    }, 3500);
    this.emit('event', { type: 'update', session: this.publicSession(session) });
    return { ok: true, session: this.publicSession(session) };
  }

  /**
   * Register a session driven by something other than the scrcpy client (e.g. the
   * virtual webcam bridge) so it shows up in Sessions with logs and a Stop button.
   */
  adopt({ serial, label, mode, profileName, command = [], stopFn }) {
    const id = `session-${++this.seq}`;
    const session = {
      id, serial, label: label || serial, mode, profileName: profileName || null,
      args: command, command, pid: null, status: 'starting', studio: true, startedAt: Date.now(), endedAt: null,
      exitCode: null, recordPath: null, error: null, info: {}, logs: [], child: null, stopTimer: null, stopping: false, stopFn,
    };
    this.sessions.set(id, session);
    const emitUpdate = () => this.emit('event', { type: 'update', session: this.publicSession(session) });
    emitUpdate();
    return {
      id,
      log: (line, level = levelOf(line)) => {
        const entry = { t: Date.now(), line, stream: 'out', level };
        session.logs.push(entry);
        if (session.logs.length > MAX_LOG_LINES) session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
        if (level === 'error' && !session.error) session.error = line;
        this.emit('event', { type: 'log', id, entry });
      },
      update: (patch) => { Object.assign(session, patch); if (patch.info) session.info = { ...session.info, ...patch.info }; emitUpdate(); },
      end: (code, error) => {
        if (session.endedAt) return;
        session.exitCode = code;
        session.endedAt = Date.now();
        session.status = session.stopping || (!error && code === 0) ? 'stopped' : 'failed';
        if (error && !session.stopping) session.error = error;
        emitUpdate();
        this.emit('ended', this.publicSession(session));
      },
      get stopping() { return session.stopping; },
    };
  }

  parseInfo(s, line) {
    let m;
    let changed = false;
    if ((m = line.match(/Device:\s*\[([^\]]+)\]\s*(.+?)\s*\(Android\s*([\d.]+)\)/))) { s.info.device = `${m[1]} ${m[2]}`; s.info.android = m[3]; changed = true; }
    if ((m = line.match(/Renderer:\s*(\S+)/))) { s.info.renderer = m[1]; changed = true; }
    if ((m = line.match(/Texture:\s*(\d+x\d+)/))) { s.info.texture = m[1]; changed = true; }
    if ((m = line.match(/(\d+) fps/))) { s.info.fps = parseInt(m[1], 10); changed = true; }
    if ((m = line.match(/Recording started to (\S+) file:\s*(.+)$/))) { s.info.recording = m[2]; changed = true; }
    if (s.status === 'starting' && /Texture:|Renderer:|Device:|Recording started|audio|INFO: Audio/i.test(line)) { s.status = 'running'; changed = true; }
    if (changed) this.emit('event', { type: 'update', session: this.publicSession(s) });
  }

  /**
   * Stop gracefully so recordings are finalized: on Windows `taskkill` without
   * /F posts WM_CLOSE to the SDL window; elsewhere SIGTERM is handled by SDL.
   */
  stop(id, force = false) {
    const s = this.sessions.get(id);
    if (!s || s.endedAt) return false;
    s.stopping = true;
    if (s.stopFn) { s.stopFn(force); return true; }
    const hard = () => {
      if (s.endedAt) return;
      if (IS_WIN) spawn('taskkill', ['/PID', String(s.pid), '/T', '/F'], { windowsHide: true });
      else try { s.child.kill('SIGKILL'); } catch {}
    };
    if (force) { hard(); return true; }
    if (IS_WIN) spawn('taskkill', ['/PID', String(s.pid), '/T'], { windowsHide: true });
    else try { s.child.kill('SIGTERM'); } catch {}
    s.stopTimer = setTimeout(hard, 4000);
    return true;
  }

  stopAll() {
    for (const s of this.sessions.values()) if (!s.endedAt) this.stop(s.id);
  }

  running() { return [...this.sessions.values()].filter(s => !s.endedAt); }

  remove(id) {
    const s = this.sessions.get(id);
    if (s && s.endedAt) { this.sessions.delete(id); return true; }
    return false;
  }

  clearEnded() {
    for (const [id, s] of this.sessions) if (s.endedAt) this.sessions.delete(id);
  }

  // ---------------------------------------------------------------- queries
  async query(serial, kind) {
    if (!tools.scrcpy) return { ok: false, error: 'scrcpy not found' };
    const flags = {
      encoders: ['--list-encoders'],
      displays: ['--list-displays'],
      cameras: ['--list-cameras'],
      'camera-sizes': ['--list-camera-sizes'],
      apps: ['--list-apps'],
    }[kind];
    if (!flags) return { ok: false, error: 'Unknown query' };
    if (kind === 'apps' && this.appCache.has(serial)) return { ok: true, items: this.appCache.get(serial) };
    const r = await run(tools.scrcpy, ['-s', serial, ...flags], { timeout: 45000, env: scrcpyEnv(), cwd: path.dirname(tools.scrcpy) });
    const text = `${r.stdout}\n${r.stderr}`;
    let items;
    switch (kind) {
      case 'encoders': items = parseEncoders(text); break;
      case 'displays': items = parseDisplays(text); break;
      case 'cameras': case 'camera-sizes': items = parseCameras(text); break;
      case 'apps': items = parseApps(text); if (items.length) this.appCache.set(serial, items); break;
    }
    const err = (text.match(/ERROR:\s*(.+)/) || [])[1];
    return { ok: items.length > 0 || !err, items, error: items.length ? null : err || r.error };
  }
}

function levelOf(line) {
  if (/\bERROR\b|error:/i.test(line)) return 'error';
  if (/\bWARN(ING)?\b/i.test(line)) return 'warn';
  if (/\bDEBUG\b|\bVERBOSE\b/.test(line)) return 'debug';
  return 'info';
}

function lineReader(stream, cb) {
  let rest = '';
  stream.on('data', (chunk) => {
    const text = rest + chunk.toString('utf8');
    const lines = text.split(/\r?\n/);
    rest = lines.pop();
    lines.forEach(cb);
  });
  stream.on('end', () => { if (rest) cb(rest); });
}

function parseEncoders(text) {
  const out = [];
  const re = /--(video|audio)-codec=(\S+)\s+--\1-encoder=(\S+)\s*(.*)$/gm;
  let m;
  while ((m = re.exec(text))) {
    const extra = m[4].trim();
    out.push({ kind: m[1], codec: m[2], encoder: m[3], hw: /\(hw\)/.test(extra), sw: /\(sw\)/.test(extra), vendor: /\[vendor\]/.test(extra), alias: /\(alias/.test(extra), note: extra });
  }
  return out;
}

function parseDisplays(text) {
  const out = [];
  const re = /--display-id=(\d+)\s*(?:\((\d+x\d+)\))?/g;
  let m;
  while ((m = re.exec(text))) out.push({ id: m[1], size: m[2] || null });
  return out;
}

function parseCameras(text) {
  const cams = [];
  let cur = null;
  let highSpeed = false;
  for (const line of text.split(/\r?\n/)) {
    let m;
    if ((m = line.match(/--camera-id=(\S+)\s*\(([^,)]+)(?:,\s*(\d+x\d+))?(?:,\s*fps=\[([^\]]*)\])?/))) {
      cur = { id: m[1], facing: m[2].trim(), size: m[3] || null, fps: m[4] ? m[4].split(/,\s*/).map(Number).filter(Boolean) : [], sizes: [], highSpeedSizes: [] };
      highSpeed = false;
      cams.push(cur);
    } else if (cur && /High speed/i.test(line)) {
      highSpeed = true;
    } else if (cur && (m = line.match(/^\s*-\s*(\d+x\d+)(?:\s*\(fps=\[([^\]]*)\]\))?/))) {
      (highSpeed ? cur.highSpeedSizes : cur.sizes).push(m[2] ? `${m[1]} @ ${m[2]}` : m[1]);
    }
  }
  return cams;
}

function parseApps(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([*-])\s+(.+?)\s{2,}(\S+)\s*$/);
    if (m && /^[\w.]+$/.test(m[3])) out.push({ system: m[1] === '*', name: m[2].trim(), package: m[3] });
  }
  return out;
}

module.exports = { ScrcpyService, parseApps, parseEncoders, parseCameras, parseDisplays };
