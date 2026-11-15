/* Genera migrations/0002_seed.sql a partir de la base local.
   Uso: node scripts/export-seed.mjs [ruta-db] */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbPath = process.argv[2] || path.join(root, 'data', 'mostrador.db');
const outPath = path.join(root, 'migrations', '0002_seed.sql');

if (!fs.existsSync(dbPath)) {
  console.error(`No existe la base: ${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath, { readOnly: true });

const tables = [
  'settings',
  'categories',
  'units',
  'products',
  'presentations',
  'customers',
  'quotes',
  'quote_items',
  'sales',
  'sale_items',
  'stock_movements'
];

const seqTables = [
  'products',
  'presentations',
  'customers',
  'categories',
  'units',
  'sales',
  'sale_items',
  'quotes',
  'quote_items',
  'stock_movements'
];

function sqlValue(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'boolean') return value ? '1' : '0';
  return `'${String(value).replace(/'/g, "''")}'`;
}

function columnsOf(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

const lines = [
  '-- =========================================================',
  '-- MOSTRADOR · datos iniciales exportados de la base local',
  `-- Origen: ${dbPath}`,
  `-- Generado: ${new Date().toISOString()}`,
  '-- Aplicar después de 0001_init.sql',
  '-- =========================================================',
  ''
];

let total = 0;
for (const table of tables) {
  const columns = columnsOf(table);
  if (!columns.length) continue;
  let rows = db.prepare(`SELECT * FROM ${table}`).all();
  if (table === 'settings') rows = rows.filter((r) => !String(r.key).startsWith('auth_'));
  if (!rows.length) continue;
  lines.push(`-- ${table}: ${rows.length} fila(s)`);
  for (const row of rows) {
    lines.push(
      `INSERT OR REPLACE INTO ${table} (${columns.join(', ')}) VALUES (${columns
        .map((c) => sqlValue(row[c]))
        .join(', ')});`
    );
    total += 1;
  }
  lines.push('');
}

/* Contadores: conserva ticket/product y calcula las secuencias de ids. */
const counters = new Map();
for (const row of db.prepare('SELECT name, value FROM counters').all()) {
  if (!String(row.name).startsWith('seq_')) counters.set(row.name, Number(row.value) || 0);
}
for (const table of seqTables) {
  const row = db.prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM ${table}`).get();
  counters.set(`seq_${table}`, Number(row.max_id) || 0);
}
lines.push(`-- counters: ${counters.size} fila(s)`);
for (const [name, value] of [...counters.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`INSERT OR REPLACE INTO counters (name, value) VALUES (${sqlValue(name)}, ${sqlValue(value)});`);
}
lines.push('');
lines.push('');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
db.close();

console.log(`Listo: ${total} filas -> ${outPath}`);
