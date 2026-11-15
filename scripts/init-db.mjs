/* Crea una base local nueva aplicando el esquema y los datos iniciales.
   Uso: node scripts/init-db.mjs [ruta-db] [--force] */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dbPath = process.argv.find((a) => a.endsWith('.db')) || path.join(root, 'data', 'mostrador.db');
const force = process.argv.includes('--force');

if (fs.existsSync(dbPath) && !force) {
  console.error(`Ya existe ${dbPath}. Usa --force para recrearla (se sobrescribe).`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(dbPath), { recursive: true });
if (force && fs.existsSync(dbPath)) fs.rmSync(dbPath);

const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = OFF;');
for (const file of ['0001_init.sql', '0002_seed.sql']) {
  const sql = fs.readFileSync(path.join(root, 'migrations', file), 'utf8');
  db.exec(sql);
  console.log(`Aplicado: ${file}`);
}
db.exec('PRAGMA foreign_keys = ON; PRAGMA wal_checkpoint(TRUNCATE);');
const count = db.prepare('SELECT COUNT(*) AS c FROM products').get().c;
db.close();
console.log(`Base creada: ${dbPath} (${count} productos)`);
