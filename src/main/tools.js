// Process helpers and scrcpy/adb binary resolution.
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const IS_WIN = process.platform === 'win32';
const EXE = IS_WIN ? '.exe' : '';

/**
 * Run a command and collect its output. Never rejects: failures are reported
 * through `code`/`error` so callers can surface friendly messages.
 */
function run(cmd, args, { timeout = 30000, encoding = 'utf8', env, cwd, maxBuffer = 64 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding, env, cwd, maxBuffer, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
        stdout: stdout ?? (encoding === 'buffer' ? Buffer.alloc(0) : ''),
        stderr: stderr ? stderr.toString() : '',
        error: err ? (err.killed ? 'Timed out' : err.code === 'ENOENT' ? `Executable not found: ${cmd}` : err.message) : null,
      });
    });
  });
}

/** Quote a string for the Android (mksh/toybox) shell. */
function shQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function exists(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch { return false; }
}

async function which(name) {
  const r = await run(IS_WIN ? 'where' : 'which', [name], { timeout: 5000 });
  if (!r.ok) return null;
  const first = r.stdout.split(/\r?\n/).map(s => s.trim()).find(Boolean);
  return first && exists(first) ? first : null;
}

/** Well-known install locations checked when a binary isn't on PATH. */
function candidateDirs() {
  const home = os.homedir();
  const dirs = [];
  if (IS_WIN) {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const winget = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(winget)) {
        if (!/scrcpy/i.test(d)) continue;
        const base = path.join(winget, d);
        dirs.push(base);
        try { for (const sub of fs.readdirSync(base)) dirs.push(path.join(base, sub)); } catch {}
      }
    } catch {}
    dirs.push(path.join(home, 'scoop', 'shims'), path.join(home, 'scoop', 'apps', 'scrcpy', 'current'),
      'C:\\ProgramData\\chocolatey\\bin', path.join(local, 'Android', 'Sdk', 'platform-tools'),
      'C:\\scrcpy', 'C:\\Program Files\\scrcpy');
  } else {
    dirs.push('/usr/local/bin', '/usr/bin', '/opt/homebrew/bin', '/snap/bin',
      path.join(home, 'Android', 'Sdk', 'platform-tools'), path.join(home, 'Library', 'Android', 'sdk', 'platform-tools'));
  }
  return dirs;
}

async function locate(name, preferredDir) {
  if (preferredDir) {
    const p = path.join(preferredDir, name + EXE);
    if (exists(p)) return p;
  }
  const onPath = await which(name);
  if (onPath) return onPath;
  for (const d of candidateDirs()) {
    const p = path.join(d, name + EXE);
    if (exists(p)) return p;
  }
  return null;
}

const tools = {
  scrcpy: null,
  adb: null,
  scrcpyVersion: null,
  adbVersion: null,
};

/**
 * Resolve scrcpy and adb. Explicit settings win; otherwise adb next to scrcpy
 * is preferred so both always agree on the adb server version.
 */
async function resolveTools(settings = {}) {
  tools.scrcpy = exists(settings.scrcpyPath) ? settings.scrcpyPath : await locate('scrcpy');
  const scrcpyDir = tools.scrcpy ? path.dirname(tools.scrcpy) : null;
  tools.adb = exists(settings.adbPath) ? settings.adbPath : await locate('adb', scrcpyDir);

  tools.scrcpyVersion = null;
  tools.adbVersion = null;
  const [sv, av] = await Promise.all([
    tools.scrcpy ? run(tools.scrcpy, ['--version'], { timeout: 8000 }) : null,
    tools.adb ? run(tools.adb, ['version'], { timeout: 8000 }) : null,
  ]);
  if (sv) tools.scrcpyVersion = (sv.stdout.match(/scrcpy\s+v?([\d.]+\S*)/i) || [])[1] || null;
  if (av) tools.adbVersion = (av.stdout.match(/version\s+([\d.]+)/i) || [])[1] || null;
  return getToolsInfo();
}

function getToolsInfo() {
  return { ...tools, platform: process.platform };
}

function scrcpyEnv() {
  const env = { ...process.env };
  if (tools.adb) env.ADB = tools.adb;
  return env;
}

module.exports = { run, spawn, shQuote, resolveTools, getToolsInfo, tools, scrcpyEnv, IS_WIN, exists };
