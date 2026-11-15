-- =========================================================
-- MOSTRADOR · esquema inicial (Cloudflare D1 / SQLite)
-- =========================================================

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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
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
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
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
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name);

  CREATE TABLE IF NOT EXISTS quotes (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    number        TEXT NOT NULL UNIQUE,
    customer_id   INTEGER REFERENCES customers(id),
    customer_name TEXT NOT NULL DEFAULT '',
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    valid_until   TEXT NOT NULL DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'borrador',
    notes         TEXT NOT NULL DEFAULT '',
    subtotal      REAL NOT NULL DEFAULT 0,
    discount      REAL NOT NULL DEFAULT 0,
    tax           REAL NOT NULL DEFAULT 0,
    total         REAL NOT NULL DEFAULT 0,
    sale_id       INTEGER,
    request_id    TEXT,
    updated_at    TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_quotes_created ON quotes(created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_quotes_request ON quotes(request_id) WHERE request_id IS NOT NULL AND request_id <> '';

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
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
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
    note           TEXT NOT NULL DEFAULT '',
    request_id     TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sales_created ON sales(created_at);
  CREATE INDEX IF NOT EXISTS idx_sales_status ON sales(status);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_request ON sales(request_id) WHERE request_id IS NOT NULL AND request_id <> '';

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
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_movements_product ON stock_movements(product_id);
  CREATE INDEX IF NOT EXISTS idx_movements_created ON stock_movements(created_at);

  CREATE TABLE IF NOT EXISTS counters (
    name  TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );

  /* Guardia atómica: si una condición falla, el batch completo se revierte. */
  CREATE TABLE IF NOT EXISTS guards (
    ok INTEGER NOT NULL CHECK (ok = 1)
  );

  /* Intentos de acceso, para limitar fuerza bruta. */
  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ip TEXT NOT NULL,
    at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts(ip, at);

  /* Secuencias explícitas de id, para no depender de lastInsertRowid. */
  INSERT OR IGNORE INTO counters (name, value)
    SELECT 'seq_products', COALESCE(MAX(id), 0) FROM products;
  INSERT OR IGNORE INTO counters (name, value)
    SELECT 'seq_presentations', COALESCE(MAX(id), 0) FROM presentations;
  INSERT OR IGNORE INTO counters (name, value)
    SELECT 'seq_customers', COALESCE(MAX(id), 0) FROM customers;
  INSERT OR IGNORE INTO counters (name, value)
    SELECT 'seq_categories', COALESCE(MAX(id), 0) FROM categories;
  INSERT OR IGNORE INTO counters (name, value)
    SELECT 'seq_units', COALESCE(MAX(id), 0) FROM units;
  INSERT OR IGNORE INTO counters (name, value)
    SELECT 'seq_sales', COALESCE(MAX(id), 0) FROM sales;
  INSERT OR IGNORE INTO counters (name, value)
    SELECT 'seq_sale_items', COALESCE(MAX(id), 0) FROM sale_items;
  INSERT OR IGNORE INTO counters (name, value)
    SELECT 'seq_quotes', COALESCE(MAX(id), 0) FROM quotes;
  INSERT OR IGNORE INTO counters (name, value)
    SELECT 'seq_quote_items', COALESCE(MAX(id), 0) FROM quote_items;
  INSERT OR IGNORE INTO counters (name, value)
    SELECT 'seq_stock_movements', COALESCE(MAX(id), 0) FROM stock_movements;
