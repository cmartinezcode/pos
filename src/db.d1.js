function normalizeParams(params) {
  return (params || []).map((v) => {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  });
}

/**
 * Adaptador D1. `batch()` es atómico y cuenta como una sola consulta
 * contra el límite de 50 por invocación del plan Free.
 */
export function createD1Db(d1) {
  const bind = (sql, params) => {
    const stmt = d1.prepare(sql);
    const list = normalizeParams(params);
    return list.length ? stmt.bind(...list) : stmt;
  };

  return {
    kind: 'd1',
    async all(sql, params = []) {
      const r = await bind(sql, params).all();
      return r.results || [];
    },
    async get(sql, params = []) {
      const r = await bind(sql, params).first();
      return r ?? null;
    },
    async run(sql, params = []) {
      const r = await bind(sql, params).run();
      return { changes: Number(r.meta?.changes || 0), lastRowId: r.meta?.last_row_id ?? null };
    },
    async batch(statements = []) {
      const results = await d1.batch(statements.map((s) => bind(s.sql, s.params)));
      return results.map((r) => ({ changes: Number(r.meta?.changes || 0) }));
    },
    async exec(sql) {
      await d1.exec(sql);
    },
    close() {}
  };
}
