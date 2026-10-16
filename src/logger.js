'use strict';

const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const COLORS = { debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m' };
const RESET = '\x1b[0m';
const MAX_FILE_BYTES = 5 * 1024 * 1024;

class Logger {
  constructor({ level = 'info', dir = null, scope = 'app', root = null } = {}) {
    this.root = root || this;
    this.scope = scope;
    if (this.root === this) {
      this.level = LEVELS[level] ?? LEVELS.info;
      this.dir = dir;
      this.stream = null;
      this.bytes = 0;
      this.color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
      if (dir) this._openStream();
      /** Últimas líneas en memoria (limitado) para mostrarlas en el panel. */
      this.recent = [];
      this.recentMax = 300;
    }
  }

  _openStream() {
    try {
      const logDir = path.join(this.dir, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      this.file = path.join(logDir, 'app.log');
      try {
        this.bytes = fs.statSync(this.file).size;
      } catch {
        this.bytes = 0;
      }
      this.stream = fs.createWriteStream(this.file, { flags: 'a' });
      this.stream.on('error', () => {
        this.stream = null;
      });
    } catch {
      this.stream = null;
    }
  }

  _rotate() {
    try {
      this.stream.end();
      const old = this.file.replace(/\.log$/, '.1.log');
      fs.rmSync(old, { force: true });
      fs.renameSync(this.file, old);
    } catch {
      /* si falla la rotación seguimos escribiendo */
    }
    this.bytes = 0;
    this._openStream();
  }

  child(scope) {
    return new Logger({ scope, root: this.root });
  }

  setLevel(level) {
    this.root.level = LEVELS[level] ?? this.root.level;
  }

  _write(level, args) {
    const root = this.root;
    if (LEVELS[level] < root.level) return;
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    const msg = args
      .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : util.inspect(a, { depth: 4 })))
      .join(' ');
    const plain = `[${ts}] ${level.toUpperCase().padEnd(5)} [${this.scope}] ${msg}`;
    const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
    out.write((root.color ? `${COLORS[level]}${plain}${RESET}` : plain) + '\n');
    root.recent.push({ t: now.getTime(), level, scope: this.scope, msg: msg.slice(0, 2000) });
    if (root.recent.length > root.recentMax) root.recent.splice(0, root.recent.length - root.recentMax);
    if (root.stream) {
      const line = plain + '\n';
      root.bytes += Buffer.byteLength(line);
      root.stream.write(line);
      if (root.bytes > MAX_FILE_BYTES) root._rotate();
    }
  }

  debug(...a) {
    this._write('debug', a);
  }
  info(...a) {
    this._write('info', a);
  }
  warn(...a) {
    this._write('warn', a);
  }
  error(...a) {
    this._write('error', a);
  }

  close() {
    const root = this.root;
    if (root.stream) {
      root.stream.end();
      root.stream = null;
    }
  }
}

module.exports = { Logger, LEVELS };
