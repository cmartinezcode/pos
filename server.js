import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

import {
  db,
  DB_PATH,
  getSettings,
  saveSettings,
  tx,
  nextCounter,
  peekCounter,
  nowLocal,
  dateLocal,
  addDaysLocal,
  round2,
  roundQty,
  norm,
  buildSearchText,
  formatMoney,
  PAYMENT_METHODS
} from './db.js';
import { seedDatabase } from './seed.js';
import { buildReceipt, buildQuote, buildTest, totalsFromItems, wrapText } from './lib/receipt.js';
import { printText, deviceExists } from './lib/printer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 3000;

seedDatabase();

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJSON(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendText(res, status, text, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

function readBody(req, limit = 4 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new ApiError(413, 'La petición es demasiado grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJSON(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new ApiError(400, 'JSON inválido.');
  }
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asPositive(value, field) {
  const n = asNumber(value, NaN);
  if (!Number.isFinite(n) || n <= 0) throw new ApiError(400, `${field} debe ser mayor que cero.`);
  return n;
}

function asMoney(value, field, fallback = 0) {
  const n = value === undefined || value === '' ? fallback : asNumber(value, NaN);
  if (!Number.isFinite(n) || n < 0) throw new ApiError(400, `${field} no puede ser negativo.`);
  return round2(n);
}

function asQty(value, field, { allowZero = false } = {}) {
  const n = asNumber(value, NaN);
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) {
    throw new ApiError(400, `${field} debe ser un número ${allowZero ? 'igual o mayor' : 'mayor'} que cero.`);
  }
  return roundQty(n);
}

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function getProduct(id) {
  const row = db
    .prepare(
      `SELECT p.*, c.name AS category_name, u.abbr AS unit_abbr, u.name AS unit_name
       FROM products p
       LEFT JOIN categories c ON c.id = p.category_id
       LEFT JOIN units u ON u.id = p.unit_id
       WHERE p.id = ?`
    )
    .get(Number(id));
  if (!row) return null;
  row.presentations = db
    .prepare('SELECT * FROM presentations WHERE product_id = ? ORDER BY sort, id')
    .all(row.id);
  return row;
}

function getProductLite(id) {
  return db
    .prepare(
      `SELECT p.*, u.abbr AS unit_abbr
       FROM products p LEFT JOIN units u ON u.id = p.unit_id
       WHERE p.id = ?`
    )
    .get(Number(id));
}

function getSale(id) {
  const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(Number(id));
  if (!sale) return null;
  sale.items = db.prepare('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id').all(sale.id);
  return sale;
}

function getQuote(id) {
  const quote = db.prepare('SELECT * FROM quotes WHERE id = ?').get(Number(id));
  if (!quote) return null;
  quote.items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id').all(quote.id);
  return quote;
}

function searchParts(q) {
  const nq = norm(q);
  return { nq, like: `%${nq}%` };
}

function assertUniqueProduct({ sku, barcode, excludeId = null }) {
  if (sku) {
    const row = db
      .prepare(
        `SELECT id, name FROM products WHERE sku = ? COLLATE NOCASE AND active = 1 AND id <> ?`
      )
      .get(sku, excludeId || 0);
    if (row) throw new ApiError(409, `El código ${sku} ya lo usa "${row.name}".`);
  }
  if (barcode) {
    const row = db
      .prepare(`SELECT id, name FROM products WHERE barcode = ? AND active = 1 AND id <> ?`)
      .get(barcode, excludeId || 0);
    if (row) throw new ApiError(409, `El código de barras ${barcode} ya lo usa "${row.name}".`);
  }
}

function savePresentations(productId, list) {
  db.prepare('DELETE FROM presentations WHERE product_id = ?').run(productId);
  const arr = Array.isArray(list) ? list : [];
  const stmt = db.prepare(
    'INSERT INTO presentations (product_id, label, qty, price, barcode, sort) VALUES (?, ?, ?, ?, ?, ?)'
  );
  arr.forEach((p, index) => {
    const label = text(p.label, 60);
    const qty = asQty(p.qty, 'La cantidad de la presentación');
    const price = asMoney(p.price, 'El precio de la presentación');
    if (!label) return;
    stmt.run(productId, label, qty, price, text(p.barcode, 60), index);
  });
}

function getStats() {
  const today = dateLocal();
  const month = today.slice(0, 7);
  const todayRow = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total,
              COALESCE(SUM(subtotal - cost_total),0) AS profit
       FROM sales WHERE status = 'ok' AND date(created_at) = ?`
    )
    .get(today);
  const monthRow = db
    .prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total,
              COALESCE(SUM(subtotal - cost_total),0) AS profit
       FROM sales WHERE status = 'ok' AND substr(created_at,1,7) = ?`
    )
    .get(month);
  const lowStock = db
    .prepare('SELECT COUNT(*) AS c FROM products WHERE active = 1 AND stock <= min_stock')
    .get().c;
  const products = db.prepare('SELECT COUNT(*) AS c FROM products WHERE active = 1').get().c;
  const quotes = db
    .prepare(
      `SELECT COUNT(*) AS c FROM quotes WHERE status IN ('borrador','enviada','aceptada')`
    )
    .get().c;
  const lastSale = db
    .prepare(
      `SELECT id, number, total, created_at FROM sales WHERE status = 'ok' ORDER BY id DESC LIMIT 1`
    )
    .get();
  return { today, todaySales: todayRow, monthSales: monthRow, lowStock, products, pendingQuotes: quotes, lastSale };
}

function stockError(product, available, needed) {
  return new ApiError(
    409,
    `Stock insuficiente de "${product.name}". Disponible: ${available}, necesario: ${needed}.`
  );
}

/**
 * Inserta una venta y descuenta stock. Debe llamarse dentro de una transacción.
 */
function insertSale(payload) {
  const settings = getSettings();
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (!rawItems.length) throw new ApiError(400, 'La venta no tiene productos.');

  const neededByProduct = new Map();
  const built = rawItems.map((raw) => {
    const product = getProductLite(raw.product_id);
    if (!product || !product.active) {
      throw new ApiError(400, `Producto no encontrado o inactivo (id ${raw.product_id}).`);
    }
    let factor = 1;
    let unitLabel = product.unit_abbr || 'UND';
    let unitPrice = raw.unit_price === undefined || raw.unit_price === '' ? product.sale_price : raw.unit_price;
    let name = product.name;
    let measure = product.measure || '';
    let presentationId = null;

    if (raw.presentation_id) {
      const pres = db
        .prepare('SELECT * FROM presentations WHERE id = ? AND product_id = ?')
        .get(Number(raw.presentation_id), product.id);
      if (!pres) throw new ApiError(400, `Presentación no encontrada para "${product.name}".`);
      factor = Number(pres.qty) || 1;
      presentationId = pres.id;
      unitLabel = String(pres.label || 'CAJA').split(/\s+/)[0].toUpperCase().slice(0, 10);
      if (raw.unit_price === undefined || raw.unit_price === '') unitPrice = pres.price;
    }

    const qty = asQty(raw.qty, `Cantidad de "${name}"`);
    const price = asMoney(unitPrice, `Precio de "${name}"`);
    const discount = asMoney(raw.discount || 0, `Descuento de "${name}"`);
    const baseQty = roundQty(qty * factor);
    const prev = neededByProduct.get(product.id) || 0;
    neededByProduct.set(product.id, roundQty(prev + baseQty));

    return {
      product,
      presentationId,
      name,
      code: product.sku || '',
      measure,
      unitLabel,
      qty,
      factor,
      baseQty,
      unitPrice: price,
      discount,
      taxRate: Number(product.tax_rate) || 0,
      unitCost: Number(product.cost_price) || 0
    };
  });

  if (!settings.allow_negative_stock) {
    for (const [productId, needed] of neededByProduct) {
      const p = built.find((b) => b.product.id === productId).product;
      if (Number(p.stock) < needed) throw stockError(p, Number(p.stock), needed);
    }
  }

  const calc = totalsFromItems(
    built.map((b) => ({
      qty: b.qty,
      unit_price: b.unitPrice,
      discount: b.discount,
      tax_rate: b.taxRate
    })),
    settings
  );

  const globalDiscount = asMoney(payload.discount || 0, 'El descuento');
  if (globalDiscount > calc.gross + 0.001) {
    throw new ApiError(400, 'El descuento no puede superar el total de la venta.');
  }
  const total = round2(calc.gross - globalDiscount);
  const ratio = calc.gross > 0 ? total / calc.gross : 0;
  const subtotal = round2(calc.base * ratio);
  const tax = round2(total - subtotal);

  const method = PAYMENT_METHODS.includes(payload.payment_method)
    ? payload.payment_method
    : 'efectivo';
  let received = total;
  let change = 0;
  if (method === 'efectivo') {
    received = round2(asNumber(payload.received, total));
    if (received + 0.001 < total) {
      throw new ApiError(400, 'El efectivo recibido es menor que el total.');
    }
    change = round2(received - total);
  } else if (method === 'credito') {
    received = 0;
  }

  let customerId = null;
  let customerName = text(payload.customer_name, 120) || 'Consumidor final';
  if (payload.customer_id) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(payload.customer_id));
    if (customer) {
      customerId = customer.id;
      customerName = customer.name;
    }
  }

  const number = nextCounter(
    'ticket',
    settings.ticket_prefix || 'T-',
    settings.ticket_pad || 6
  );
  const created = nowLocal();
  const costTotal = round2(built.reduce((sum, b) => sum + b.baseQty * b.unitCost, 0));
  const itemsCount = built.length;

  const result = db
    .prepare(
      `INSERT INTO sales
       (number, customer_id, customer_name, created_at, subtotal, discount, tax, total,
        payment_method, received, change_due, cost_total, items_count, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)`
    )
    .run(
      number,
      customerId,
      customerName,
      created,
      subtotal,
      globalDiscount,
      tax,
      total,
      method,
      received,
      change,
      costTotal,
      itemsCount,
      text(payload.note, 300)
    );
  const saleId = Number(result.lastInsertRowid);

  const insertItem = db.prepare(
    `INSERT INTO sale_items
     (sale_id, product_id, presentation_id, name, code, measure, unit_label, qty, factor,
      base_qty, unit_price, discount, subtotal, unit_cost, tax_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertMovement = db.prepare(
    `INSERT INTO stock_movements
     (product_id, type, qty, stock_after, cost, note, ref_type, ref_id, created_at)
     VALUES (?, 'venta', ?, ?, ?, ?, 'venta', ?, ?)`
  );
  const updateStock = db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?');

  const stockNow = new Map();
  for (const b of built) {
    if (!stockNow.has(b.product.id)) stockNow.set(b.product.id, Number(b.product.stock));
    const line = calc.items[built.indexOf(b)];
    insertItem.run(
      saleId,
      b.product.id,
      b.presentationId,
      b.name,
      b.code,
      b.measure,
      b.unitLabel,
      b.qty,
      b.factor,
      b.baseQty,
      b.unitPrice,
      b.discount,
      line.subtotal,
      b.unitCost,
      b.taxRate
    );
    const after = roundQty((stockNow.get(b.product.id) || 0) - b.baseQty);
    stockNow.set(b.product.id, after);
    insertMovement.run(
      b.product.id,
      -b.baseQty,
      after,
      b.unitCost,
      `Venta ${number}`,
      saleId,
      created
    );
    updateStock.run(after, created, b.product.id);
  }

  return getSale(saleId);
}

function insertQuote(payload) {
  const settings = getSettings();
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (!rawItems.length) throw new ApiError(400, 'La cotización no tiene productos.');

  const built = rawItems.map((raw) => {
    const product = getProductLite(raw.product_id);
    if (!product || !product.active) {
      throw new ApiError(400, `Producto no encontrado o inactivo (id ${raw.product_id}).`);
    }
    let factor = 1;
    let unitLabel = product.unit_abbr || 'UND';
    let unitPrice = raw.unit_price === undefined || raw.unit_price === '' ? product.sale_price : raw.unit_price;
    let presentationId = null;
    if (raw.presentation_id) {
      const pres = db
        .prepare('SELECT * FROM presentations WHERE id = ? AND product_id = ?')
        .get(Number(raw.presentation_id), product.id);
      if (!pres) throw new ApiError(400, `Presentación no encontrada para "${product.name}".`);
      factor = Number(pres.qty) || 1;
      presentationId = pres.id;
      unitLabel = String(pres.label || 'CAJA').split(/\s+/)[0].toUpperCase().slice(0, 10);
      if (raw.unit_price === undefined || raw.unit_price === '') unitPrice = pres.price;
    }
    const qty = asQty(raw.qty, `Cantidad de "${product.name}"`);
    const price = asMoney(unitPrice, `Precio de "${product.name}"`);
    const discount = asMoney(raw.discount || 0, `Descuento de "${product.name}"`);
    return {
      product,
      presentationId,
      qty,
      factor,
      baseQty: roundQty(qty * factor),
      unitPrice: price,
      discount,
      unitCost: Number(product.cost_price) || 0,
      taxRate: Number(product.tax_rate) || 0,
      unitLabel
    };
  });

  const calc = totalsFromItems(
    built.map((b) => ({
      qty: b.qty,
      unit_price: b.unitPrice,
      discount: b.discount,
      tax_rate: b.taxRate
    })),
    settings
  );
  const globalDiscount = asMoney(payload.discount || 0, 'El descuento');
  if (globalDiscount > calc.gross + 0.001) {
    throw new ApiError(400, 'El descuento no puede superar el total de la cotización.');
  }
  const total = round2(calc.gross - globalDiscount);
  const ratio = calc.gross > 0 ? total / calc.gross : 0;
  const subtotal = round2(calc.base * ratio);
  const tax = round2(total - subtotal);

  let customerId = null;
  let customerName = text(payload.customer_name, 120) || 'Cliente';
  if (payload.customer_id) {
    const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(payload.customer_id));
    if (customer) {
      customerId = customer.id;
      customerName = customer.name;
    }
  }

  const number = nextCounter('quote', settings.quote_prefix || 'COT-', settings.quote_pad || 6);
  const created = nowLocal();
  const validUntil = text(payload.valid_until, 10) || addDaysLocal(settings.quote_valid_days || 15);
  const status = ['borrador', 'enviada', 'aceptada'].includes(payload.status)
    ? payload.status
    : 'borrador';

  const result = db
    .prepare(
      `INSERT INTO quotes
       (number, customer_id, customer_name, created_at, valid_until, status, notes,
        subtotal, discount, tax, total)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      number,
      customerId,
      customerName,
      created,
      validUntil,
      status,
      text(payload.notes, 500),
      subtotal,
      globalDiscount,
      tax,
      total
    );
  const quoteId = Number(result.lastInsertRowid);
  const insertItem = db.prepare(
    `INSERT INTO quote_items
     (quote_id, product_id, presentation_id, name, code, measure, unit_label, qty, factor,
      base_qty, unit_price, discount, subtotal, unit_cost, tax_rate)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  built.forEach((b, index) => {
    insertItem.run(
      quoteId,
      b.product.id,
      b.presentationId,
      b.product.name,
      b.product.sku || '',
      b.product.measure || '',
      b.unitLabel,
      b.qty,
      b.factor,
      b.baseQty,
      b.unitPrice,
      b.discount,
      calc.items[index].subtotal,
      b.unitCost,
      b.taxRate
    );
  });

  return getQuote(quoteId);
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csv(rows) {
  return '\uFEFF' + rows.map((r) => r.map(csvEscape).join(';')).join('\r\n') + '\r\n';
}

function productInput(body, existing = null) {
  const settings = getSettings();
  const name = text(body.name ?? existing?.name, 200);
  if (!name) throw new ApiError(400, 'El nombre del producto es obligatorio.');
  const sku = text(body.sku ?? existing?.sku, 60);
  const barcode = text(body.barcode ?? existing?.barcode, 60);
  const stock = body.stock === undefined || body.stock === null || body.stock === ''
    ? Number(existing?.stock ?? 0)
    : asQty(body.stock, 'El stock inicial', { allowZero: true });
  const categoryId = body.category_id === '' || body.category_id === null || body.category_id === undefined
    ? existing?.category_id ?? null
    : Number(body.category_id) || null;
  const unitId = body.unit_id === '' || body.unit_id === null || body.unit_id === undefined
    ? existing?.unit_id ?? db.prepare('SELECT id FROM units WHERE active = 1 ORDER BY id LIMIT 1').get()?.id
    : Number(body.unit_id) || null;
  if (!unitId) throw new ApiError(400, 'Debes crear al menos una unidad de medida.');
  if (categoryId) {
    const cat = db.prepare('SELECT id FROM categories WHERE id = ? AND active = 1').get(categoryId);
    if (!cat) throw new ApiError(400, 'La categoría seleccionada no existe.');
  }
  return {
    name,
    sku,
    barcode,
    categoryId,
    unitId,
    measure: text(body.measure ?? existing?.measure, 80),
    material: text(body.material ?? existing?.material, 80),
    brand: text(body.brand ?? existing?.brand, 80),
    location: text(body.location ?? existing?.location, 80),
    costPrice: asMoney(body.cost_price, 'El costo', existing?.cost_price ?? 0),
    salePrice: asMoney(body.sale_price, 'El precio', existing?.sale_price ?? 0),
    wholesalePrice: asMoney(body.wholesale_price, 'El precio mayorista', existing?.wholesale_price ?? 0),
    minStock: asQty(body.min_stock, 'El stock mínimo', { allowZero: true }),
    taxRate: asMoney(body.tax_rate ?? settings.default_tax_rate, 'El IVA', settings.default_tax_rate),
    stock
  };
}

async function handleApi(req, res, url) {
  const { pathname } = url;
  const method = req.method || 'GET';
  const params = url.searchParams;

  if (method === 'GET' && pathname === '/api/health') {
    return sendJSON(res, 200, { ok: true, app: 'mostrador', node: process.version });
  }

  if (method === 'GET' && pathname === '/api/bootstrap') {
    const settings = getSettings();
    return sendJSON(res, 200, {
      settings,
      categories: db
        .prepare(
          `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS products
           FROM categories c WHERE c.active = 1 ORDER BY c.sort, c.name COLLATE NOCASE`
        )
        .all(),
      units: db
        .prepare(
          `SELECT u.*, (SELECT COUNT(*) FROM products p WHERE p.unit_id = u.id AND p.active = 1) AS products
           FROM units u WHERE u.active = 1 ORDER BY u.id`
        )
        .all(),
      stats: getStats(),
      next_ticket: peekCounter('ticket', settings.ticket_prefix || 'T-', settings.ticket_pad || 6),
      next_quote: peekCounter('quote', settings.quote_prefix || 'COT-', settings.quote_pad || 6),
      printer: {
        method: settings.print_method,
        device: settings.print_device,
        device_exists: deviceExists(settings.print_device)
      }
    });
  }

  if (pathname === '/api/settings') {
    if (method === 'GET') return sendJSON(res, 200, getSettings());
    if (method === 'PUT') {
      const body = await readJSON(req);
      if (!body || typeof body !== 'object') throw new ApiError(400, 'Configuración inválida.');
      const allowed = new Set([
        'store_name', 'store_doc', 'store_address', 'store_city', 'store_phone',
        'store_footer', 'receipt_note', 'currency', 'locale', 'doc_title', 'quote_title',
        'ticket_prefix', 'ticket_pad', 'quote_prefix', 'quote_pad', 'quote_valid_days',
        'default_tax_rate', 'prices_include_tax', 'print_method', 'print_device',
        'print_host', 'print_port', 'print_cols', 'cut_paper', 'auto_print',
        'allow_negative_stock', 'accent', 'scanlines'
      ]);
      const patch = {};
      for (const [k, v] of Object.entries(body)) {
        if (allowed.has(k)) patch[k] = v;
      }
      saveSettings(patch);
      return sendJSON(res, 200, getSettings());
    }
  }

  /* ---------- Categorías ---------- */
  if (pathname === '/api/categories') {
    if (method === 'GET') {
      return sendJSON(
        res,
        200,
        db
          .prepare(
            `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS products
             FROM categories c WHERE c.active = 1 ORDER BY c.sort, c.name COLLATE NOCASE`
          )
          .all()
      );
    }
    if (method === 'POST') {
      const body = await readJSON(req);
      const name = text(body.name, 80);
      if (!name) throw new ApiError(400, 'El nombre de la categoría es obligatorio.');
      const dup = db.prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND active = 1').get(name);
      if (dup) throw new ApiError(409, 'Ya existe una categoría con ese nombre.');
      const parentId = body.parent_id ? Number(body.parent_id) : null;
      const r = db.prepare('INSERT INTO categories (name, parent_id) VALUES (?, ?)').run(name, parentId);
      return sendJSON(res, 201, db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(r.lastInsertRowid)));
    }
  }

  let m = pathname.match(/^\/api\/categories\/(\d+)$/);
  if (m && (method === 'PUT' || method === 'DELETE')) {
    const id = Number(m[1]);
    const row = db.prepare('SELECT * FROM categories WHERE id = ? AND active = 1').get(id);
    if (!row) throw new ApiError(404, 'Categoría no encontrada.');
    if (method === 'PUT') {
      const body = await readJSON(req);
      const name = text(body.name, 80);
      if (!name) throw new ApiError(400, 'El nombre es obligatorio.');
      const dup = db
        .prepare('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND active = 1 AND id <> ?')
        .get(name, id);
      if (dup) throw new ApiError(409, 'Ya existe una categoría con ese nombre.');
      db.prepare('UPDATE categories SET name = ? WHERE id = ?').run(name, id);
      return sendJSON(res, 200, db.prepare('SELECT * FROM categories WHERE id = ?').get(id));
    }
    const used = db.prepare('SELECT COUNT(*) AS c FROM products WHERE category_id = ? AND active = 1').get(id).c;
    const children = db.prepare('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ? AND active = 1').get(id).c;
    if (used > 0 || children > 0) {
      throw new ApiError(409, 'No se puede borrar: la categoría tiene productos o subcategorías.');
    }
    db.prepare('UPDATE categories SET active = 0 WHERE id = ?').run(id);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---------- Unidades ---------- */
  if (pathname === '/api/units') {
    if (method === 'GET') {
      return sendJSON(
        res,
        200,
        db
          .prepare(
            `SELECT u.*, (SELECT COUNT(*) FROM products p WHERE p.unit_id = u.id AND p.active = 1) AS products
             FROM units u WHERE u.active = 1 ORDER BY u.id`
          )
          .all()
      );
    }
    if (method === 'POST') {
      const body = await readJSON(req);
      const name = text(body.name, 60);
      const abbr = text(body.abbr, 12).toUpperCase();
      if (!name || !abbr) throw new ApiError(400, 'Nombre y abreviatura son obligatorios.');
      const dup = db.prepare('SELECT id FROM units WHERE abbr = ? COLLATE NOCASE AND active = 1').get(abbr);
      if (dup) throw new ApiError(409, 'Ya existe una unidad con esa abreviatura.');
      const decimals = ['1', 1, true].includes(body.decimals) ? 2 : 0;
      const r = db
        .prepare('INSERT INTO units (name, abbr, decimals) VALUES (?, ?, ?)')
        .run(name, abbr, decimals);
      return sendJSON(res, 201, db.prepare('SELECT * FROM units WHERE id = ?').get(Number(r.lastInsertRowid)));
    }
  }

  m = pathname.match(/^\/api\/units\/(\d+)$/);
  if (m && (method === 'PUT' || method === 'DELETE')) {
    const id = Number(m[1]);
    const row = db.prepare('SELECT * FROM units WHERE id = ? AND active = 1').get(id);
    if (!row) throw new ApiError(404, 'Unidad no encontrada.');
    if (method === 'PUT') {
      const body = await readJSON(req);
      const name = text(body.name ?? row.name, 60);
      const abbr = text(body.abbr ?? row.abbr, 12).toUpperCase();
      const decimals = body.decimals === undefined ? row.decimals : ['1', 1, true, 'true'].includes(body.decimals) ? 2 : 0;
      const dup = db
        .prepare('SELECT id FROM units WHERE abbr = ? COLLATE NOCASE AND active = 1 AND id <> ?')
        .get(abbr, id);
      if (dup) throw new ApiError(409, 'Ya existe una unidad con esa abreviatura.');
      db.prepare('UPDATE units SET name = ?, abbr = ?, decimals = ? WHERE id = ?').run(name, abbr, decimals, id);
      return sendJSON(res, 200, db.prepare('SELECT * FROM units WHERE id = ?').get(id));
    }
    const used = db.prepare('SELECT COUNT(*) AS c FROM products WHERE unit_id = ? AND active = 1').get(id).c;
    if (used > 0) throw new ApiError(409, 'No se puede borrar: hay productos usando esta unidad.');
    if (db.prepare('SELECT COUNT(*) AS c FROM units WHERE active = 1').get().c <= 1) {
      throw new ApiError(409, 'Debe quedar al menos una unidad de medida.');
    }
    db.prepare('UPDATE units SET active = 0 WHERE id = ?').run(id);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---------- Búsqueda de venta ---------- */
  if (method === 'GET' && pathname === '/api/search') {
    const q = text(params.get('q'), 100);
    const settings = getSettings();
    const results = [];
    const seen = new Set();

    const baseSelect = `SELECT p.*, c.name AS category_name, u.abbr AS unit_abbr
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      LEFT JOIN units u ON u.id = p.unit_id
      WHERE p.active = 1`;

    let products;
    if (!q) {
      products = db.prepare(`${baseSelect} ORDER BY p.name COLLATE NOCASE LIMIT 8`).all();
    } else {
      const { nq, like } = searchParts(q);
      products = db
        .prepare(
          `${baseSelect} AND (p.search_text LIKE ? OR p.barcode = ? OR p.sku = ?)
           ORDER BY
             CASE WHEN p.barcode = ? THEN 0 WHEN p.sku = ? COLLATE NOCASE THEN 0
                  WHEN p.search_text LIKE ? THEN 1 ELSE 2 END,
             p.name COLLATE NOCASE
           LIMIT 10`
        )
        .all(like, q, q, q, q, `${nq}%`);
    }

    const pushProduct = (p) => {
      const key = `p:${p.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push({
        kind: 'product',
        key,
        product_id: p.id,
        presentation_id: null,
        presentation_label: '',
        name: p.name,
        sku: p.sku,
        barcode: p.barcode,
        measure: p.measure,
        category_name: p.category_name || '',
        material: p.material,
        brand: p.brand,
        stock: Number(p.stock),
        price: Number(p.sale_price),
        wholesale_price: Number(p.wholesale_price),
        cost_price: Number(p.cost_price),
        unit_label: p.unit_abbr || 'UND',
        factor: 1,
        tax_rate: Number(p.tax_rate) || 0
      });
    };

    const pushPresentation = (p, pres) => {
      const key = `r:${pres.id}`;
      if (seen.has(key)) return;
      seen.add(key);
      results.push({
        kind: 'presentation',
        key,
        product_id: p.id,
        presentation_id: pres.id,
        presentation_label: pres.label,
        name: p.name,
        sku: p.sku,
        barcode: pres.barcode,
        measure: p.measure,
        category_name: p.category_name || '',
        material: p.material,
        brand: p.brand,
        stock: Number(p.stock),
        price: Number(p.price),
        wholesale_price: Number(p.price),
        cost_price: Number(p.cost_price),
        unit_label: String(pres.label || 'CAJA').split(/\s+/)[0].toUpperCase().slice(0, 10),
        factor: Number(pres.qty) || 1,
        tax_rate: Number(p.tax_rate) || 0
      });
    };

    /* Código de barras exacto de una presentación. */
    if (q) {
      const exactPres = db
        .prepare(
          `SELECT pr.*, p.name, p.sku, p.measure, p.material, p.brand, p.stock, p.cost_price,
                  p.tax_rate, c.name AS category_name, u.abbr AS unit_abbr
           FROM presentations pr
           JOIN products p ON p.id = pr.product_id
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN units u ON u.id = p.unit_id
           WHERE pr.barcode = ? AND p.active = 1
           LIMIT 1`
        )
        .get(q);
      if (exactPres) {
        pushPresentation(
          {
            ...exactPres,
            id: exactPres.product_id,
            sale_price: exactPres.price
          },
          exactPres
        );
      }
    }

    for (const p of products) {
      pushProduct(p);
      const presentations = db
        .prepare('SELECT * FROM presentations WHERE product_id = ? ORDER BY sort, id')
        .all(p.id);
      for (const pres of presentations) pushPresentation(p, pres);
    }

    const sliced = results.slice(0, 14);
    for (const r of sliced) {
      if (r.kind === 'product' && r.stock <= 0 && settings.allow_negative_stock === false) {
        r.disabled = true;
      }
      if (r.kind === 'presentation' && settings.allow_negative_stock === false && r.stock < r.factor) {
        r.disabled = true;
      }
    }
    return sendJSON(res, 200, sliced);
  }

  /* ---------- Productos ---------- */
  if (pathname === '/api/products') {
    if (method === 'GET') {
      const q = text(params.get('q'), 100);
      const low = params.get('low') === '1';
      const includeInactive = params.get('inactive') === '1';
      const categoryId = params.get('category') ? Number(params.get('category')) : null;
      const limit = Math.min(2000, Math.max(1, Number(params.get('limit')) || 300));
      const offset = Math.max(0, Number(params.get('offset')) || 0);
      const where = [];
      const args = [];
      if (!includeInactive) where.push('p.active = 1');
      if (low) where.push('p.stock <= p.min_stock');
      if (categoryId) {
        where.push('p.category_id = ?');
        args.push(categoryId);
      }
      if (q) {
        const { like } = searchParts(q);
        where.push('(p.search_text LIKE ? OR p.barcode = ? OR p.sku = ?)');
        args.push(like, q, q);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const total = db
        .prepare(`SELECT COUNT(*) AS c FROM products p ${whereSql}`)
        .get(...args).c;
      const items = db
        .prepare(
          `SELECT p.*, c.name AS category_name, u.abbr AS unit_abbr, u.name AS unit_name
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN units u ON u.id = p.unit_id
           ${whereSql}
           ORDER BY p.name COLLATE NOCASE
           LIMIT ? OFFSET ?`
        )
        .all(...args, limit, offset);
      return sendJSON(res, 200, { items, total });
    }

    if (method === 'POST') {
      const body = await readJSON(req);
      const data = productInput(body);
      const created = tx(() => {
        if (!data.sku) data.sku = nextCounter('product', 'P-', 6);
        assertUniqueProduct({ sku: data.sku, barcode: data.barcode });
        const categories = db.prepare('SELECT name FROM categories WHERE id = ?').get(data.categoryId);
        const unit = db.prepare('SELECT abbr FROM units WHERE id = ?').get(data.unitId);
        const searchText = buildSearchText(data, categories?.name || '', unit?.abbr || '');
        const r = db
          .prepare(
            `INSERT INTO products
             (sku, barcode, name, search_text, category_id, unit_id, measure, material, brand,
              cost_price, sale_price, wholesale_price, stock, min_stock, location, tax_rate, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            data.sku,
            data.barcode,
            data.name,
            searchText,
            data.categoryId,
            data.unitId,
            data.measure,
            data.material,
            data.brand,
            data.costPrice,
            data.salePrice,
            data.wholesalePrice,
            data.stock,
            data.minStock,
            data.location,
            data.taxRate,
            nowLocal()
          );
        const id = Number(r.lastInsertRowid);
        savePresentations(id, body.presentations);
        if (data.stock !== 0) {
          db.prepare(
            `INSERT INTO stock_movements
             (product_id, type, qty, stock_after, cost, note, created_at)
             VALUES (?, 'inicial', ?, ?, ?, 'Stock inicial', ?)`
          ).run(id, data.stock, data.stock, data.costPrice, nowLocal());
        }
        return getProduct(id);
      });
      return sendJSON(res, 201, created);
    }
  }

  m = pathname.match(/^\/api\/products\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const product = getProduct(id);
    if (!product) throw new ApiError(404, 'Producto no encontrado.');
    if (method === 'GET') return sendJSON(res, 200, product);
    if (method === 'PUT') {
      const body = await readJSON(req);
      const data = productInput(body, product);
      const updated = tx(() => {
        if (!data.sku) data.sku = product.sku || nextCounter('product', 'P-', 6);
        assertUniqueProduct({ sku: data.sku, barcode: data.barcode, excludeId: id });
        const categories = db.prepare('SELECT name FROM categories WHERE id = ?').get(data.categoryId);
        const unit = db.prepare('SELECT abbr FROM units WHERE id = ?').get(data.unitId);
        const searchText = buildSearchText(data, categories?.name || '', unit?.abbr || '');
        db.prepare(
          `UPDATE products SET
             sku = ?, barcode = ?, name = ?, search_text = ?, category_id = ?, unit_id = ?,
             measure = ?, material = ?, brand = ?, cost_price = ?, sale_price = ?,
             wholesale_price = ?, min_stock = ?, location = ?, tax_rate = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          data.sku,
          data.barcode,
          data.name,
          searchText,
          data.categoryId,
          data.unitId,
          data.measure,
          data.material,
          data.brand,
          data.costPrice,
          data.salePrice,
          data.wholesalePrice,
          data.minStock,
          data.location,
          data.taxRate,
          nowLocal(),
          id
        );
        if (body.presentations !== undefined) savePresentations(id, body.presentations);
        return getProduct(id);
      });
      return sendJSON(res, 200, updated);
    }
    if (method === 'DELETE') {
      db.prepare('UPDATE products SET active = 0, updated_at = ? WHERE id = ?').run(nowLocal(), id);
      return sendJSON(res, 200, { ok: true });
    }
  }

  m = pathname.match(/^\/api\/products\/(\d+)\/adjust$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const body = await readJSON(req);
    const result = tx(() => {
      const product = getProductLite(id);
      if (!product) throw new ApiError(404, 'Producto no encontrado.');
      const type = String(body.type || 'entrada');
      let qty;
      let delta;
      let after;
      if (type === 'entrada') {
        qty = asQty(body.qty, 'La cantidad de entrada');
        delta = qty;
        after = roundQty(Number(product.stock) + qty);
      } else if (type === 'salida') {
        qty = asQty(body.qty, 'La cantidad de salida');
        delta = -qty;
        after = roundQty(Number(product.stock) - qty);
        const settings = getSettings();
        if (!settings.allow_negative_stock && after < 0) {
          throw new ApiError(409, `El stock de "${product.name}" quedaría negativo.`);
        }
      } else if (type === 'ajuste') {
        qty = asQty(body.qty, 'El conteo', { allowZero: true });
        after = qty;
        delta = roundQty(qty - Number(product.stock));
      } else {
        throw new ApiError(400, 'Tipo de ajuste inválido.');
      }
      db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(after, nowLocal(), id);
      db.prepare(
        `INSERT INTO stock_movements
         (product_id, type, qty, stock_after, cost, note, ref_type, ref_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'ajuste', NULL, ?)`
      ).run(id, type, delta, after, Number(product.cost_price) || 0, text(body.note, 200), nowLocal());
      return { product: getProduct(id), delta, stock_after: after };
    });
    return sendJSON(res, 200, result);
  }

  if (method === 'GET' && pathname === '/api/movements') {
    const q = text(params.get('q'), 100);
    const productId = params.get('product_id') ? Number(params.get('product_id')) : null;
    const limit = Math.min(500, Math.max(1, Number(params.get('limit')) || 100));
    const where = [];
    const args = [];
    if (productId) {
      where.push('m.product_id = ?');
      args.push(productId);
    }
    if (q) {
      where.push('(p.search_text LIKE ? OR p.sku = ?)');
      args.push(`%${norm(q)}%`, q);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const items = db
      .prepare(
        `SELECT m.*, p.name AS product_name, p.sku, u.abbr AS unit_abbr
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN units u ON u.id = p.unit_id
         ${whereSql}
         ORDER BY m.id DESC LIMIT ?`
      )
      .all(...args, limit);
    return sendJSON(res, 200, items);
  }

  /* ---------- Clientes ---------- */
  if (pathname === '/api/customers') {
    if (method === 'GET') {
      const q = text(params.get('q'), 100);
      const limit = Math.min(500, Math.max(1, Number(params.get('limit')) || 100));
      const where = ['active = 1'];
      const args = [];
      if (q) {
        where.push('(name LIKE ? OR doc LIKE ? OR phone LIKE ?)');
        args.push(`%${q}%`, `%${q}%`, `%${q}%`);
      }
      return sendJSON(
        res,
        200,
        db
          .prepare(`SELECT * FROM customers WHERE ${where.join(' AND ')} ORDER BY name COLLATE NOCASE LIMIT ?`)
          .all(...args, limit)
      );
    }
    if (method === 'POST') {
      const body = await readJSON(req);
      const name = text(body.name, 120);
      if (!name) throw new ApiError(400, 'El nombre del cliente es obligatorio.');
      const r = db
        .prepare('INSERT INTO customers (doc, name, phone, address, email, notes) VALUES (?, ?, ?, ?, ?, ?)')
        .run(
          text(body.doc, 40),
          name,
          text(body.phone, 40),
          text(body.address, 160),
          text(body.email, 120),
          text(body.notes, 300)
        );
      return sendJSON(res, 201, db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(r.lastInsertRowid)));
    }
  }

  m = pathname.match(/^\/api\/customers\/(\d+)$/);
  if (m && (method === 'PUT' || method === 'DELETE')) {
    const id = Number(m[1]);
    const row = db.prepare('SELECT * FROM customers WHERE id = ? AND active = 1').get(id);
    if (!row) throw new ApiError(404, 'Cliente no encontrado.');
    if (method === 'PUT') {
      const body = await readJSON(req);
      const name = text(body.name ?? row.name, 120);
      if (!name) throw new ApiError(400, 'El nombre es obligatorio.');
      db.prepare(
        'UPDATE customers SET doc = ?, name = ?, phone = ?, address = ?, email = ?, notes = ? WHERE id = ?'
      ).run(
        text(body.doc ?? row.doc, 40),
        name,
        text(body.phone ?? row.phone, 40),
        text(body.address ?? row.address, 160),
        text(body.email ?? row.email, 120),
        text(body.notes ?? row.notes, 300),
        id
      );
      return sendJSON(res, 200, db.prepare('SELECT * FROM customers WHERE id = ?').get(id));
    }
    db.prepare('UPDATE customers SET active = 0 WHERE id = ?').run(id);
    return sendJSON(res, 200, { ok: true });
  }

  /* ---------- Ventas ---------- */
  if (pathname === '/api/sales') {
    if (method === 'GET') {
      const from = text(params.get('from'), 10);
      const to = text(params.get('to'), 10);
      const q = text(params.get('q'), 100);
      const status = text(params.get('status'), 20);
      const limit = Math.min(1000, Math.max(1, Number(params.get('limit')) || 200));
      const where = [];
      const args = [];
      if (from) {
        where.push('date(created_at) >= ?');
        args.push(from);
      }
      if (to) {
        where.push('date(created_at) <= ?');
        args.push(to);
      }
      if (status) {
        where.push('status = ?');
        args.push(status);
      }
      if (q) {
        where.push('(number LIKE ? OR customer_name LIKE ?)');
        args.push(`%${q}%`, `%${q}%`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const items = db
        .prepare(`SELECT * FROM sales ${whereSql} ORDER BY id DESC LIMIT ?`)
        .all(...args, limit);
      return sendJSON(res, 200, items);
    }
    if (method === 'POST') {
      const body = await readJSON(req);
      const sale = tx(() => insertSale(body));
      const settings = getSettings();
      return sendJSON(res, 201, { ...sale, receipt: buildReceipt(sale, settings) });
    }
  }

  m = pathname.match(/^\/api\/sales\/(\d+)$/);
  if (m && method === 'GET') {
    const sale = getSale(Number(m[1]));
    if (!sale) throw new ApiError(404, 'Venta no encontrada.');
    return sendJSON(res, 200, sale);
  }

  m = pathname.match(/^\/api\/sales\/(\d+)\/void$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const sale = tx(() => {
      const current = getSale(id);
      if (!current) throw new ApiError(404, 'Venta no encontrada.');
      if (current.status !== 'ok') throw new ApiError(409, 'Esta venta ya fue anulada.');
      const now = nowLocal();
      for (const item of current.items) {
        if (!item.product_id) continue;
        const product = getProductLite(item.product_id);
        if (!product) continue;
        const after = roundQty(Number(product.stock) + Number(item.base_qty));
        db.prepare('UPDATE products SET stock = ?, updated_at = ? WHERE id = ?').run(after, now, product.id);
        db.prepare(
          `INSERT INTO stock_movements
           (product_id, type, qty, stock_after, cost, note, ref_type, ref_id, created_at)
           VALUES (?, 'anulacion', ?, ?, ?, ?, 'venta', ?, ?)`
        ).run(
          product.id,
          Number(item.base_qty),
          after,
          Number(item.unit_cost) || 0,
          `Anulación ${current.number}`,
          current.id,
          now
        );
      }
      db.prepare(`UPDATE sales SET status = 'anulada' WHERE id = ?`).run(id);
      return getSale(id);
    });
    return sendJSON(res, 200, sale);
  }

  m = pathname.match(/^\/api\/sales\/(\d+)\/receipt$/);
  if (m && method === 'GET') {
    const sale = getSale(Number(m[1]));
    if (!sale) throw new ApiError(404, 'Venta no encontrada.');
    return sendJSON(res, 200, { text: buildReceipt(sale, getSettings()) });
  }

  /* ---------- Cotizaciones ---------- */
  if (pathname === '/api/quotes') {
    if (method === 'GET') {
      const q = text(params.get('q'), 100);
      const status = text(params.get('status'), 20);
      const limit = Math.min(1000, Math.max(1, Number(params.get('limit')) || 200));
      const where = [];
      const args = [];
      if (status) {
        where.push('status = ?');
        args.push(status);
      }
      if (q) {
        where.push('(number LIKE ? OR customer_name LIKE ?)');
        args.push(`%${q}%`, `%${q}%`);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return sendJSON(
        res,
        200,
        db.prepare(`SELECT * FROM quotes ${whereSql} ORDER BY id DESC LIMIT ?`).all(...args, limit)
      );
    }
    if (method === 'POST') {
      const body = await readJSON(req);
      const quote = tx(() => insertQuote(body));
      return sendJSON(res, 201, { ...quote, receipt: buildQuote(quote, getSettings()) });
    }
  }

  m = pathname.match(/^\/api\/quotes\/(\d+)$/);
  if (m) {
    const id = Number(m[1]);
    const quote = getQuote(id);
    if (!quote) throw new ApiError(404, 'Cotización no encontrada.');
    if (method === 'GET') return sendJSON(res, 200, quote);
    if (method === 'PUT') {
      if (['convertida', 'anulada'].includes(quote.status)) {
        throw new ApiError(409, 'Esta cotización ya no se puede editar.');
      }
      const body = await readJSON(req);
      const updated = tx(() => {
        const rawItems = Array.isArray(body.items) ? body.items : [];
        if (!rawItems.length) throw new ApiError(400, 'La cotización no tiene productos.');
        const built = rawItems.map((raw) => {
          const product = getProductLite(raw.product_id);
          if (!product || !product.active) throw new ApiError(400, 'Producto no encontrado.');
          let factor = 1;
          let unitLabel = product.unit_abbr || 'UND';
          let unitPrice = raw.unit_price ?? product.sale_price;
          let presentationId = null;
          if (raw.presentation_id) {
            const pres = db
              .prepare('SELECT * FROM presentations WHERE id = ? AND product_id = ?')
              .get(Number(raw.presentation_id), product.id);
            if (!pres) throw new ApiError(400, 'Presentación no encontrada.');
            factor = Number(pres.qty) || 1;
            unitLabel = String(pres.label || 'CAJA').split(/\s+/)[0].toUpperCase().slice(0, 10);
            presentationId = pres.id;
            if (raw.unit_price === undefined || raw.unit_price === '') unitPrice = pres.price;
          }
          const qty = asQty(raw.qty, 'Cantidad');
          const discount = asMoney(raw.discount || 0, 'Descuento');
          return {
            product,
            presentationId,
            qty,
            factor,
            baseQty: roundQty(qty * factor),
            unitPrice: asMoney(unitPrice, 'Precio'),
            discount,
            unitCost: Number(product.cost_price) || 0,
            taxRate: Number(product.tax_rate) || 0,
            unitLabel
          };
        });
        const settings = getSettings();
        const calc = totalsFromItems(
          built.map((b) => ({ qty: b.qty, unit_price: b.unitPrice, discount: b.discount, tax_rate: b.taxRate })),
          settings
        );
        const globalDiscount = asMoney(body.discount || 0, 'El descuento');
        if (globalDiscount > calc.gross + 0.001) {
          throw new ApiError(400, 'El descuento no puede superar el total.');
        }
        const total = round2(calc.gross - globalDiscount);
        const ratio = calc.gross > 0 ? total / calc.gross : 0;
        const subtotal = round2(calc.base * ratio);
        const tax = round2(total - subtotal);
        let customerId = null;
        let customerName = text(body.customer_name, 120) || quote.customer_name || 'Cliente';
        if (body.customer_id) {
          const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(Number(body.customer_id));
          if (c) {
            customerId = c.id;
            customerName = c.name;
          }
        }
        const validUntil = text(body.valid_until, 10) || quote.valid_until;
        const status = ['borrador', 'enviada', 'aceptada'].includes(body.status)
          ? body.status
          : quote.status;
        db.prepare(
          `UPDATE quotes SET customer_id = ?, customer_name = ?, valid_until = ?, status = ?,
             notes = ?, subtotal = ?, discount = ?, tax = ?, total = ?, updated_at = ?
           WHERE id = ?`
        ).run(
          customerId,
          customerName,
          validUntil,
          status,
          text(body.notes ?? quote.notes, 500),
          subtotal,
          globalDiscount,
          tax,
          total,
          nowLocal(),
          id
        );
        db.prepare('DELETE FROM quote_items WHERE quote_id = ?').run(id);
        const insertItem = db.prepare(
          `INSERT INTO quote_items
           (quote_id, product_id, presentation_id, name, code, measure, unit_label, qty, factor,
            base_qty, unit_price, discount, subtotal, unit_cost, tax_rate)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        );
        built.forEach((b, index) => {
          insertItem.run(
            id,
            b.product.id,
            b.presentationId,
            b.product.name,
            b.product.sku || '',
            b.product.measure || '',
            b.unitLabel,
            b.qty,
            b.factor,
            b.baseQty,
            b.unitPrice,
            b.discount,
            calc.items[index].subtotal,
            b.unitCost,
            b.taxRate
          );
        });
        return getQuote(id);
      });
      return sendJSON(res, 200, { ...updated, receipt: buildQuote(updated, getSettings()) });
    }
  }

  m = pathname.match(/^\/api\/quotes\/(\d+)\/status$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const body = await readJSON(req);
    const status = String(body.status || '');
    const allowed = ['borrador', 'enviada', 'aceptada', 'vencida', 'anulada'];
    if (!allowed.includes(status)) throw new ApiError(400, 'Estado inválido.');
    const quote = getQuote(id);
    if (!quote) throw new ApiError(404, 'Cotización no encontrada.');
    if (quote.status === 'convertida') throw new ApiError(409, 'La cotización ya fue convertida en venta.');
    db.prepare('UPDATE quotes SET status = ?, updated_at = ? WHERE id = ?').run(status, nowLocal(), id);
    return sendJSON(res, 200, getQuote(id));
  }

  m = pathname.match(/^\/api\/quotes\/(\d+)\/convert$/);
  if (m && method === 'POST') {
    const id = Number(m[1]);
    const body = await readJSON(req);
    const result = tx(() => {
      const quote = getQuote(id);
      if (!quote) throw new ApiError(404, 'Cotización no encontrada.');
      if (quote.status === 'convertida') throw new ApiError(409, 'Esta cotización ya fue convertida.');
      if (quote.status === 'anulada') throw new ApiError(409, 'Esta cotización está anulada.');
      const sale = insertSale({
        items: quote.items.map((it) => ({
          product_id: it.product_id,
          presentation_id: it.presentation_id,
          qty: it.qty,
          unit_price: it.unit_price,
          discount: it.discount
        })),
        discount: quote.discount,
        payment_method: body.payment_method || 'efectivo',
        received: body.received,
        customer_id: quote.customer_id,
        customer_name: quote.customer_name,
        note: `Cotización ${quote.number}`
      });
      db.prepare(`UPDATE quotes SET status = 'convertida', sale_id = ?, updated_at = ? WHERE id = ?`).run(
        sale.id,
        nowLocal(),
        id
      );
      return { sale, quote: getQuote(id) };
    });
    return sendJSON(res, 201, {
      ...result,
      receipt: buildReceipt(result.sale, getSettings())
    });
  }

  m = pathname.match(/^\/api\/quotes\/(\d+)\/receipt$/);
  if (m && method === 'GET') {
    const quote = getQuote(Number(m[1]));
    if (!quote) throw new ApiError(404, 'Cotización no encontrada.');
    return sendJSON(res, 200, { text: buildQuote(quote, getSettings()) });
  }

  /* ---------- Reportes ---------- */
  if (method === 'GET' && pathname === '/api/reports') {
    const today = dateLocal();
    const from = text(params.get('from'), 10) || `${today.slice(0, 7)}-01`;
    const to = text(params.get('to'), 10) || today;
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total,
                COALESCE(SUM(subtotal),0) AS base, COALESCE(SUM(tax),0) AS tax,
                COALESCE(SUM(cost_total),0) AS cost,
                COALESCE(SUM(subtotal - cost_total),0) AS profit
         FROM sales WHERE status = 'ok' AND date(created_at) BETWEEN ? AND ?`
      )
      .get(from, to);
    const byDay = db
      .prepare(
        `SELECT date(created_at) AS day, COUNT(*) AS count,
                SUM(total) AS total, SUM(subtotal - cost_total) AS profit
         FROM sales WHERE status = 'ok' AND date(created_at) BETWEEN ? AND ?
         GROUP BY date(created_at) ORDER BY day DESC`
      )
      .all(from, to);
    const topProducts = db
      .prepare(
        `SELECT si.product_id, si.name, si.code,
                SUM(si.base_qty) AS qty, SUM(si.subtotal) AS amount,
                SUM(si.base_qty * si.unit_cost) AS cost
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.status = 'ok' AND date(s.created_at) BETWEEN ? AND ?
         GROUP BY si.product_id, si.name, si.code
         ORDER BY amount DESC LIMIT 15`
      )
      .all(from, to);
    const payments = db
      .prepare(
        `SELECT payment_method, COUNT(*) AS count, SUM(total) AS total
         FROM sales WHERE status = 'ok' AND date(created_at) BETWEEN ? AND ?
         GROUP BY payment_method`
      )
      .all(from, to);
    const lowStock = db
      .prepare(
        `SELECT p.id, p.sku, p.name, p.stock, p.min_stock, u.abbr AS unit_abbr
         FROM products p LEFT JOIN units u ON u.id = p.unit_id
         WHERE p.active = 1 AND p.stock <= p.min_stock
         ORDER BY (p.stock - p.min_stock) ASC, p.name LIMIT 30`
      )
      .all();
    const avg = totals.count ? round2(totals.total / totals.count) : 0;
    return sendJSON(res, 200, { from, to, totals: { ...totals, avg }, byDay, topProducts, payments, lowStock });
  }

  /* ---------- Impresión ---------- */
  if (pathname === '/api/print' && method === 'POST') {
    const body = await readJSON(req);
    const settings = getSettings();
    let content = text(body.text, 100000);
    if (body.sale_id) {
      const sale = getSale(body.sale_id);
      if (!sale) throw new ApiError(404, 'Venta no encontrada.');
      content = buildReceipt(sale, settings);
    } else if (body.quote_id) {
      const quote = getQuote(body.quote_id);
      if (!quote) throw new ApiError(404, 'Cotización no encontrada.');
      content = buildQuote(quote, settings);
    }
    if (!content) throw new ApiError(400, 'No hay contenido para imprimir.');
    const result = await printText(content, settings);
    return sendJSON(res, 200, { ok: true, ...result });
  }

  if (pathname === '/api/print/test' && method === 'POST') {
    const settings = getSettings();
    const result = await printText(buildTest(settings), settings);
    return sendJSON(res, 200, { ok: true, ...result });
  }

  if (pathname === '/api/print/sample' && method === 'GET') {
    return sendJSON(res, 200, { text: buildTest(getSettings()) });
  }

  if (pathname === '/api/print/status' && method === 'GET') {
    const settings = getSettings();
    return sendJSON(res, 200, {
      method: settings.print_method,
      device: settings.print_device,
      device_exists: deviceExists(settings.print_device),
      host: settings.print_host,
      port: settings.print_port
    });
  }

  /* ---------- Respaldo y exportación ---------- */
  if (pathname === '/api/backup' && method === 'GET') {
    const tmp = path.join(os.tmpdir(), `mostrador-${crypto.randomUUID()}.db`);
    db.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
    const stat = fs.statSync(tmp);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="mostrador-${dateLocal()}.db"`,
      'Content-Length': stat.size,
      'Cache-Control': 'no-store'
    });
    const stream = fs.createReadStream(tmp);
    stream.pipe(res);
    stream.on('close', () => {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* ignore */
      }
    });
    return;
  }

  if (pathname === '/api/export/products.csv' && method === 'GET') {
    const rows = db
      .prepare(
        `SELECT p.sku, p.barcode, p.name, c.name AS category, u.abbr AS unit, p.measure,
                p.material, p.brand, p.cost_price, p.sale_price, p.wholesale_price,
                p.stock, p.min_stock, p.location, p.tax_rate, p.active
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN units u ON u.id = p.unit_id
         ORDER BY p.name COLLATE NOCASE`
      )
      .all();
    const data = [
      ['CODIGO', 'BARRAS', 'PRODUCTO', 'CATEGORIA', 'UNIDAD', 'MEDIDA', 'MATERIAL', 'MARCA', 'COSTO', 'PRECIO', 'MAYORISTA', 'STOCK', 'MINIMO', 'UBICACION', 'IVA', 'ACTIVO'],
      ...rows.map((r) => [
        r.sku, r.barcode, r.name, r.category, r.unit, r.measure, r.material, r.brand,
        r.cost_price, r.sale_price, r.wholesale_price, r.stock, r.min_stock, r.location,
        r.tax_rate, r.active ? 'SI' : 'NO'
      ])
    ];
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="productos-${dateLocal()}.csv"`,
      'Cache-Control': 'no-store'
    });
    return res.end(csv(data));
  }

  if (pathname === '/api/export/movements.csv' && method === 'GET') {
    const rows = db
      .prepare(
        `SELECT m.created_at, p.sku, p.name, u.abbr AS unit, m.type, m.qty, m.stock_after, m.note
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN units u ON u.id = p.unit_id
         ORDER BY m.id DESC LIMIT 5000`
      )
      .all();
    const data = [
      ['FECHA', 'CODIGO', 'PRODUCTO', 'UNIDAD', 'TIPO', 'CANTIDAD', 'SALDO', 'NOTA'],
      ...rows.map((r) => [r.created_at, r.sku, r.name, r.unit, r.type, r.qty, r.stock_after, r.note])
    ];
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="kardex-${dateLocal()}.csv"`,
      'Cache-Control': 'no-store'
    });
    return res.end(csv(data));
  }

  throw new ApiError(404, 'Ruta no encontrada.');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    return sendText(res, 403, 'Prohibido');
  }
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) return sendText(res, 404, 'No encontrado');
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (err) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    const status = err instanceof ApiError ? err.status : 500;
    if (status >= 500) console.error(err);
    sendJSON(res, status, { error: err.message || 'Error interno.' });
  }
});

function lanIP() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function start(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 8) {
      start(port + 1, attempt + 1);
      return;
    }
    console.error('No se pudo iniciar el servidor:', err.message);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const settings = getSettings();
    const ip = lanIP();
    console.log('');
    console.log('  ▣  MOSTRADOR POS · 80 mm');
    console.log(`  Local      >  http://localhost:${port}`);
    if (HOST === '0.0.0.0' && ip) console.log(`  En la red  >  http://${ip}:${port}`);
    console.log(`  Datos      >  ${DB_PATH}`);
    console.log(
      `  Impresora  >  ${settings.print_method === 'usb'
        ? `USB ${settings.print_device}${deviceExists(settings.print_device) ? '' : ' (no detectada)'}`
        : settings.print_method === 'tcp'
          ? `Red ${settings.print_host}:${settings.print_port}`
          : 'Navegador / CUPS'}`
    );
    console.log('');
  });
}

process.on('SIGINT', () => {
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
});

start(BASE_PORT);
