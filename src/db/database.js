'use strict';

const { DatabaseSync } = require('node:sqlite');
const { LruCache } = require('../util/lru');
const { MIGRATIONS } = require('./migrations');

function bindable(v) {
  if (v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  return v;
}

function bindArgs(params) {
  if (params.length === 1 && params[0] && typeof params[0] === 'object' && !Array.isArray(params[0])) {
    const out = {};
    for (const [k, v] of Object.entries(params[0])) out[k] = bindable(v);
    return [out];
  }
  return params.map(bindable);
}

/** Envoltorio fino sobre node:sqlite con caché de sentencias y transacciones anidadas. */
class Database {
  constructor(file) {
    this.file = file;
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA synchronous = NORMAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec('PRAGMA busy_timeout = 5000;');
    this.stmts = new LruCache({ max: 400, ttlMs: 24 * 3600_000 });
    this.depth = 0;
    this.closed = false;
  }

  prepare(sql) {
    let stmt = this.stmts.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.stmts.set(sql, stmt);
    }
    return stmt;
  }

  run(sql, ...params) {
    return this.prepare(sql).run(...bindArgs(params));
  }

  get(sql, ...params) {
    return this.prepare(sql).get(...bindArgs(params));
  }

  all(sql, ...params) {
    return this.prepare(sql).all(...bindArgs(params));
  }

  exec(sql) {
    this.db.exec(sql);
  }

  /** Ejecuta `fn` en una transacción (admite anidamiento con SAVEPOINT). */
  transaction(fn) {
    const sp = `sp_${this.depth}`;
    this.db.exec(this.depth === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
    this.depth += 1;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new Error('Las transacciones deben ser síncronas');
      }
      this.depth -= 1;
      this.db.exec(this.depth === 0 ? 'COMMIT' : `RELEASE ${sp}`);
      return result;
    } catch (err) {
      this.depth -= 1;
      try {
        this.db.exec(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`);
      } catch {
        /* ya revertida */
      }
      throw err;
    }
  }

  migrate() {
    const current = this.get('PRAGMA user_version').user_version;
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.transaction(() => {
        this.db.exec(MIGRATIONS[v]);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
    return MIGRATIONS.length;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stmts.clear();
    try {
      this.db.exec('PRAGMA optimize;');
    } catch {
      /* opcional */
    }
    this.db.close();
  }
}

function openDatabase(file) {
  const db = new Database(file);
  db.migrate();
  return db;
}

module.exports = { Database, openDatabase };
