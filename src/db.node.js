import { DatabaseSync } from 'node:sqlite';

function normalizeParams(params) {
  return (params || []).map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

/**
 * Adaptador local: misma interfaz asíncrona que D1, sobre node:sqlite.
 */
export function createNodeDb(filePath) {
  const raw = new DatabaseSync(filePath);
  raw.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA synchronous = NORMAL;
  `);

  const db = {
    kind: 'node',
    raw,
    async all(sql, params = []) {
      return raw.prepare(sql).all(...normalizeParams(params));
    },
    async get(sql, params = []) {
      return raw.prepare(sql).get(...normalizeParams(params)) ?? null;
    },
    async run(sql, params = []) {
      const r = raw.prepare(sql).run(...normalizeParams(params));
      return { changes: Number(r.changes || 0), lastRowId: Number(r.lastInsertRowid || 0) };
    },
    /** Ejecuta todas las sentencias en una sola transacción. */
    async batch(statements = []) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = [];
        for (const s of statements) {
          const r = raw.prepare(s.sql).run(...normalizeParams(s.params));
          out.push({ changes: Number(r.changes || 0) });
        }
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        try {
          raw.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw err;
      }
    },
    async exec(sql) {
      raw.exec(sql);
    },
    close() {
      try {
        raw.close();
      } catch {
        /* ignore */
      }
    }
  };
  return db;
}
