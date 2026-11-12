import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.join(__dirname, 'data');
export const DB_PATH = path.join(DATA_DIR, 'mostrador.db');
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;
  PRAGMA busy_timeout = 5000;
  PRAGMA synchronous = NORMAL;
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    parent_id  INTEGER REFERENCES categories(id),
    sort       INTEGER NOT NULL DEFAULT 0,
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_name ON categories(name COLLATE NOCASE) WHERE active = 1;

  CREATE TABLE IF NOT EXISTS units (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    name     TEXT NOT NULL,
    abbr     TEXT NOT NULL,
    decimals INTEGER NOT NULL DEFAULT 0,
    active   INTEGER NOT NULL DEFAULT 1
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_units_abbr ON units(abbr COLLATE NOCASE) WHERE active = 1;

  CREATE TABLE IF NOT EXISTS products (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sku             TEXT NOT NULL DEFAULT '',
    barcode         TEXT NOT NULL DEFAULT '',
    name            TEXT NOT NULL,
    search_text     TEXT NOT NULL DEFAULT '',
    category_id     INTEGER REFERENCES categories(id),
    unit_id         INTEGER REFERENCES units(id),
    measure         TEXT NOT NULL DEFAULT '',
    material        TEXT NOT NULL DEFAULT '',
    brand           TEXT NOT NULL DEFAULT '',
    cost_price      REAL NOT NULL DEFAULT 0,
    sale_price      REAL NOT NULL DEFAULT 0,
    wholesale_price REAL NOT NULL DEFAULT 0,
    stock           REAL NOT NULL DEFAULT 0,
    min_stock       REAL NOT NULL DEFAULT 0,
    location        TEXT NOT NULL DEFAULT '',
    tax_rate        REAL NOT NULL DEFAULT 19,
    active          INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at      TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_products_search ON products(search_text);
  CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_products_sku ON products(sku COLLATE NOCASE) WHERE sku <> '' AND active = 1;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_products_barcode ON products(barcode) WHERE barcode <> '' AND active = 1;

  CREATE TABLE IF NOT EXISTS presentations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    label      TEXT NOT NULL,
    qty        REAL NOT NULL DEFAULT 1,
    price      REAL NOT NULL DEFAULT 0,
    barcode    TEXT NOT NULL DEFAULT '',
    sort       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_presentations_product ON presentations(product_id);

  CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    doc        TEXT NOT NULL DEFAULT '',
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL DEFAULT '',
    address    TEXT NOT NULL DEFAULT '',
    email      TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    active     INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

  CREATE TABLE IF NOT EXISTS quotes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    number        TEXT NOT NULL UNIQUE,
    customer_id   INTEGER REFERENCES customers(id),
    customer_name TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    valid_until   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'borrador',
    notes         TEXT NOT NULL DEFAULT '',
    subtotal      REAL NOT NULL DEFAULT 0,
    discount      REAL NOT NULL DEFAULT 0,
    tax           REAL NOT NULL DEFAULT 0,
    total         REAL NOT NULL DEFAULT 0,
    sale_id       INTEGER,
    updated_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at);

  CREATE TABLE IF NOT EXISTS quote_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    quote_id        INTEGER NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    product_id      INTEGER REFERENCES products(id),
    presentation_id INTEGER,
    name            TEXT NOT NULL,
    code            TEXT NOT NULL DEFAULT '',
    measure         TEXT NOT NULL DEFAULT '',
    unit_label      TEXT NOT NULL DEFAULT 'UND',
    qty             REAL NOT NULL,
    factor          REAL NOT NULL DEFAULT 1,
    base_qty        REAL NOT NULL DEFAULT 0,
    unit_price      REAL NOT NULL,
    discount        REAL NOT NULL DEFAULT 0,
    subtotal        REAL NOT NULL,
    unit_cost       REAL NOT NULL DEFAULT 0,
    tax_rate        REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_quote_items_quote ON quote_items(quote_id);

  CREATE TABLE IF NOT EXISTS sales (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    number         TEXT NOT NULL UNIQUE,
    customer_id    INTEGER REFERENCES customers(id),
    customer_name  TEXT NOT NULL DEFAULT '',
    created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    subtotal       REAL NOT NULL DEFAULT 0,
    discount       REAL NOT NULL DEFAULT 0,
    tax            REAL NOT NULL DEFAULT 0,
    total          REAL NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'efectivo',
    received       REAL NOT NULL DEFAULT 0,
    change_due     REAL NOT NULL DEFAULT 0,
    cost_total     REAL NOT NULL DEFAULT 0,
    items_count    INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'ok',
    note           TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
  CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);

  CREATE TABLE IF NOT EXISTS sale_items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id         INTEGER NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
    product_id      INTEGER REFERENCES products(id),
    presentation_id INTEGER,
    name            TEXT NOT NULL,
    code            TEXT NOT NULL DEFAULT '',
    measure         TEXT NOT NULL DEFAULT '',
    unit_label      TEXT NOT NULL DEFAULT 'UND',
    qty             REAL NOT NULL,
    factor          REAL NOT NULL DEFAULT 1,
    base_qty        REAL NOT NULL DEFAULT 0,
    unit_price      REAL NOT NULL,
    discount        REAL NOT NULL DEFAULT 0,
    subtotal        REAL NOT NULL,
    unit_cost       REAL NOT NULL DEFAULT 0,
    tax_rate        REAL NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sale_items_sale ON sale_items(sale_id);
  CREATE INDEX IF NOT EXISTS idx_sale_items_product ON sale_items(product_id);

  CREATE TABLE IF NOT EXISTS stock_movements (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES products(id),
    type        TEXT NOT NULL,
    qty         REAL NOT NULL,
    stock_after REAL NOT NULL,
    cost        REAL NOT NULL DEFAULT 0,
    note        TEXT NOT NULL DEFAULT '',
    ref_type    TEXT NOT NULL DEFAULT '',
    ref_id      INTEGER,
    created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );
  CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
  CREATE INDEX IF NOT EXISTS idx_movements_created ON stock_movements(created_at);

  CREATE TABLE IF NOT EXISTS counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );
`);

/* Migraciones suaves para versiones futuras. */
function ensureColumn(table, ddl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
  const name = ddl.trim().split(/\s+/)[0];
  if (!cols.includes(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
ensureColumn('products', 'wholesale_price REAL NOT NULL DEFAULT 0');
ensureColumn('products', 'search_text TEXT NOT NULL DEFAULT \'\'');

export const PAYMENT_METHODS = ['efectivo', 'tarjeta', 'transferencia', 'credito'];
export const PAYMENT_LABELS = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  credito: 'Crédito'
};

export const DEFAULT_SETTINGS = {
  store_name: 'Tornillería El Tornillo',
  store_doc: '',
  store_address: '',
  store_city: '',
  store_phone: '',
  store_footer: '¡Gracias por su compra!',
  receipt_note: 'Documento no fiscal. No válido como factura electrónica.',
  currency: '$',
  locale: 'es-CO',
  doc_title: 'TICKET DE VENTA',
  quote_title: 'COTIZACIÓN',
  ticket_prefix: 'T-',
  ticket_pad: 6,
  quote_prefix: 'COT-',
  quote_pad: 6,
  quote_valid_days: 15,
  default_tax_rate: 19,
  prices_include_tax: true,
  print_method: 'usb',
  print_device: '/dev/usb/lp0',
  print_host: '',
  print_port: 9100,
  print_cols: 48,
  cut_paper: true,
  auto_print: true,
  allow_negative_stock: true,
  accent: 'copper',
  scanlines: false
};

export function getSettings() {
  const out = { ...DEFAULT_SETTINGS };
  const rows = db.prepare('SELECT key, value FROM settings').all();
  for (const r of rows) {
    try {
      out[r.key] = JSON.parse(r.value);
    } catch {
      out[r.key] = r.value;
    }
  }
  return out;
}

export function saveSettings(patch) {
  const stmt = db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    stmt.run(String(k), JSON.stringify(v));
  }
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function roundQty(n) {
  return Math.round((Number(n) + Number.EPSILON) * 1000) / 1000;
}

export function norm(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function nowLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function dateLocal(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDaysLocal(days, from = new Date()) {
  const d = new Date(from);
  d.setDate(d.getDate() + Number(days || 0));
  return dateLocal(d);
}

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* ignore */
    }
    throw err;
  }
}

export function nextCounter(name, prefix = '', pad = 6) {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  const value = Number(row?.value || 0) + 1;
  db.prepare(
    'INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value'
  ).run(name, value);
  return String(prefix ?? '') + String(value).padStart(Number(pad) || 6, '0');
}

export function peekCounter(name, prefix = '', pad = 6) {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(name);
  const value = Number(row?.value || 0) + 1;
  return String(prefix ?? '') + String(value).padStart(Number(pad) || 6, '0');
}

export function formatMoney(n, settings = getSettings()) {
  const num = round2(n);
  const nf = new Intl.NumberFormat(settings.locale || 'es-CO', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  return `${settings.currency || '$'} ${nf.format(num)}`;
}

export function buildSearchText(product, categoryName = '', unitAbbr = '') {
  return norm(
    [
      product.name,
      product.sku,
      product.barcode,
      product.measure,
      product.material,
      product.brand,
      product.location,
      categoryName,
      unitAbbr
    ].join(' ')
  );
}
