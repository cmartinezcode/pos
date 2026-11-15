/* =========================================================
   MOSTRADOR · capa de datos portable (Node y D1)
   Todas las escrituras críticas usan db.batch() atómico.
   ========================================================= */

import {
  DEFAULT_SETTINGS,
  PAYMENT_METHODS,
  buildSearchText,
  norm,
  nowLocal,
  dateLocal,
  addDaysLocal,
  round2,
  roundQty,
  parseSetting
} from '../db.js';
import { ApiError } from './errors.js';
import { totalsFromItems } from '../lib/receipt.js';

/* ---------------- utilidades ---------------- */

function text(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function asNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
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

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

function ph(count) {
  return new Array(count).fill('?').join(', ');
}

async function selectIn(db, table, ids, orderBy = 'id') {
  if (!ids.length) return [];
  const rows = [];
  for (const part of chunk(ids, 80)) {
    rows.push(...(await db.all(`SELECT * FROM ${table} WHERE id IN (${ph(part.length)})`, part)));
  }
  if (orderBy) rows.sort((a, b) => Number(a[orderBy]) - Number(b[orderBy]));
  return rows;
}

/* ---------------- ajustes ---------------- */

export async function getSettings(db) {
  const out = { ...DEFAULT_SETTINGS };
  const rows = await db.all('SELECT key, value FROM settings');
  for (const r of rows) {
    if (String(r.key).startsWith('auth_')) continue;
    out[r.key] = parseSetting(r.value);
  }
  /* En la nube (y en el servidor nuevo) solo se imprime desde el navegador. */
  out.print_method = 'browser';
  return out;
}

export async function saveSettings(db, patch) {
  const stmts = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === undefined) continue;
    stmts.push({
      sql: 'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      params: [String(k), JSON.stringify(v)]
    });
  }
  if (stmts.length) await db.batch(stmts);
  return getSettings(db);
}

/* ---------------- secuencias ---------------- */

export async function nextSeq(db, table) {
  const row = await db.get(
    `INSERT INTO counters (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1
     RETURNING value`,
    [`seq_${table}`]
  );
  return Number(row?.value || 1);
}

export async function nextCounter(db, name, prefix = '', pad = 6) {
  const row = await db.get(
    `INSERT INTO counters (name, value) VALUES (?, 1)
     ON CONFLICT(name) DO UPDATE SET value = value + 1
     RETURNING value`,
    [name]
  );
  const value = Number(row?.value || 1);
  return String(prefix ?? '') + String(value).padStart(Number(pad) || 6, '0');
}

export async function peekCounter(db, name, prefix = '', pad = 6) {
  const row = await db.get('SELECT value FROM counters WHERE name = ?', [name]);
  const value = Number(row?.value || 0) + 1;
  return String(prefix ?? '') + String(value).padStart(Number(pad) || 6, '0');
}

export async function getAuthRow(db) {
  const row = await db.get("SELECT value FROM settings WHERE key = 'auth_password'");
  return row ? parseSetting(row.value) : null;
}

export async function saveAuthRow(db, value) {
  await saveSettings(db, { auth_password: value });
}

/* ---------------- lecturas ---------------- */

export async function getProduct(db, id) {
  const row = await db.get(
    `SELECT p.*, c.name AS category_name, u.abbr AS unit_abbr, u.name AS unit_name
     FROM products p
     LEFT JOIN categories c ON c.id = p.category_id
     LEFT JOIN units u ON u.id = p.unit_id
     WHERE p.id = ?`,
    [Number(id)]
  );
  if (!row) return null;
  row.presentations = await db.all('SELECT * FROM presentations WHERE product_id = ? ORDER BY sort, id', [row.id]);
  return row;
}

export async function getProductLite(db, id) {
  return db.get(
    `SELECT p.*, u.abbr AS unit_abbr
     FROM products p LEFT JOIN units u ON u.id = p.unit_id
     WHERE p.id = ?`,
    [Number(id)]
  );
}

export async function getSale(db, id) {
  const sale = await db.get('SELECT * FROM sales WHERE id = ?', [Number(id)]);
  if (!sale) return null;
  sale.items = await db.all('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id', [sale.id]);
  return sale;
}

export async function getQuote(db, id) {
  const quote = await db.get('SELECT * FROM quotes WHERE id = ?', [Number(id)]);
  if (!quote) return null;
  quote.items = await db.all('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY id', [quote.id]);
  return quote;
}

function searchParts(q) {
  const nq = norm(q);
  return { nq, like: `%${nq}%` };
}

async function assertUniqueProduct(db, { sku, barcode, excludeId = null }) {
  if (sku) {
    const row = await db.get(
      'SELECT id, name FROM products WHERE sku = ? COLLATE NOCASE AND active = 1 AND id <> ?',
      [sku, excludeId || 0]
    );
    if (row) throw new ApiError(409, `El código ${sku} ya lo usa "${row.name}".`);
  }
  if (barcode) {
    const row = await db.get('SELECT id, name FROM products WHERE barcode = ? AND active = 1 AND id <> ?', [
      barcode,
      excludeId || 0
    ]);
    if (row) throw new ApiError(409, `El código de barras ${barcode} ya lo usa "${row.name}".`);
  }
}

export async function getStats(db) {
  const settings = await getSettings(db);
  const today = dateLocal(settings.timezone);
  const month = today.slice(0, 7);
  const todayRow = await db.get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total,
            COALESCE(SUM(subtotal - cost_total),0) AS profit
     FROM sales WHERE status = 'ok' AND date(created_at) = ?`,
    [today]
  );
  const monthRow = await db.get(
    `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total,
            COALESCE(SUM(subtotal - cost_total),0) AS profit
     FROM sales WHERE status = 'ok' AND substr(created_at,1,7) = ?`,
    [month]
  );
  const lowStock = (await db.get('SELECT COUNT(*) AS c FROM products WHERE active = 1 AND stock <= min_stock')).c;
  const products = (await db.get('SELECT COUNT(*) AS c FROM products WHERE active = 1')).c;
  const quotes = (
    await db.get("SELECT COUNT(*) AS c FROM quotes WHERE status IN ('borrador','enviada','aceptada')")
  ).c;
  const lastSale = await db.get(
    "SELECT id, number, total, created_at FROM sales WHERE status = 'ok' ORDER BY id DESC LIMIT 1"
  );
  return { today, todaySales: todayRow, monthSales: monthRow, lowStock, products, pendingQuotes: quotes, lastSale };
}

/* ---------------- ventas ---------------- */

function stockError(product, available, needed) {
  return new ApiError(
    409,
    `Stock insuficiente de "${product.name}". Disponible: ${available}, necesario: ${needed}.`
  );
}

async function loadSaleContext(db, rawItems) {
  const ids = [...new Set(rawItems.map((r) => Number(r.product_id)).filter((n) => Number.isFinite(n) && n > 0))];
  const presIds = [
    ...new Set(rawItems.map((r) => Number(r.presentation_id)).filter((n) => Number.isFinite(n) && n > 0))
  ];
  const products = await selectIn(db, 'products', ids);
  const units = await db.all('SELECT id, abbr FROM units');
  const unitsMap = new Map(units.map((u) => [u.id, u]));
  for (const p of products) p.unit_abbr = unitsMap.get(p.unit_id)?.abbr || '';
  const presentations = await selectIn(db, 'presentations', presIds);
  return { products: new Map(products.map((p) => [p.id, p])), presentations: new Map(presentations.map((p) => [p.id, p])) };
}

async function buildSaleLines(db, rawItems) {
  const { products, presentations } = await loadSaleContext(db, rawItems);
  return rawItems.map((raw) => {
    const product = products.get(Number(raw.product_id));
    if (!product || !product.active) {
      throw new ApiError(400, `Producto no encontrado o inactivo (id ${raw.product_id}).`);
    }
    let factor = 1;
    let unitLabel = product.unit_abbr || 'UND';
    let unitPrice = raw.unit_price === undefined || raw.unit_price === '' ? product.sale_price : raw.unit_price;
    let presentationId = null;

    if (raw.presentation_id) {
      const pres = presentations.get(Number(raw.presentation_id));
      if (!pres || Number(pres.product_id) !== Number(product.id)) {
        throw new ApiError(400, `Presentación no encontrada para "${product.name}".`);
      }
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
      name: product.name,
      code: product.sku || '',
      measure: product.measure || '',
      unitLabel,
      qty,
      factor,
      baseQty: roundQty(qty * factor),
      unitPrice: price,
      discount,
      taxRate: Number(product.tax_rate) || 0,
      unitCost: Number(product.cost_price) || 0
    };
  });
}

/**
 * Prepara la venta completa (lecturas + sentencias) sin escribir.
 * Devuelve las sentencias para poder combinarlas con otras (p. ej. convertir cotización).
 */
async function prepareSale(db, payload) {
  const settings = await getSettings(db);
  const tz = settings.timezone;
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (!rawItems.length) throw new ApiError(400, 'La venta no tiene productos.');

  const built = await buildSaleLines(db, rawItems);

  const neededByProduct = new Map();
  for (const b of built) {
    neededByProduct.set(b.product.id, roundQty((neededByProduct.get(b.product.id) || 0) + b.baseQty));
  }

  if (!settings.allow_negative_stock) {
    for (const [productId, needed] of neededByProduct) {
      const p = built.find((b) => b.product.id === productId).product;
      if (Number(p.stock) < needed) throw stockError(p, Number(p.stock), needed);
    }
  }

  const calc = totalsFromItems(
    built.map((b) => ({ qty: b.qty, unit_price: b.unitPrice, discount: b.discount, tax_rate: b.taxRate })),
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

  const method = PAYMENT_METHODS.includes(payload.payment_method) ? payload.payment_method : 'efectivo';
  let received = total;
  let change = 0;
  if (method === 'efectivo') {
    received = round2(asNumber(payload.received, total));
    if (received + 0.001 < total) throw new ApiError(400, 'El efectivo recibido es menor que el total.');
    change = round2(received - total);
  } else if (method === 'credito') {
    received = 0;
  }

  let customerId = null;
  let customerName = text(payload.customer_name, 120) || 'Consumidor final';
  if (payload.customer_id) {
    const customer = await db.get('SELECT * FROM customers WHERE id = ?', [Number(payload.customer_id)]);
    if (customer) {
      customerId = customer.id;
      customerName = customer.name;
    }
  }

  const number = await nextCounter(db, 'ticket', settings.ticket_prefix || 'T-', settings.ticket_pad || 6);
  const saleId = await nextSeq(db, 'sales');
  const created = nowLocal(tz);
  const costTotal = round2(built.reduce((sum, b) => sum + b.baseQty * b.unitCost, 0));
  const itemsCount = built.length;
  const requestId = text(payload.request_id, 80) || null;

  const stmts = [];

  if (!settings.allow_negative_stock) {
    for (const [productId, needed] of neededByProduct) {
      stmts.push({
        sql: 'INSERT INTO guards (ok) SELECT CASE WHEN (SELECT stock FROM products WHERE id = ?) >= ? THEN 1 ELSE 0 END',
        params: [productId, needed]
      });
    }
  }

  for (const [productId, needed] of neededByProduct) {
    stmts.push({
      sql: 'UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ?',
      params: [needed, created, productId]
    });
  }

  stmts.push({
    sql: `INSERT INTO sales
      (id, number, request_id, customer_id, customer_name, created_at, subtotal, discount, tax, total,
       payment_method, received, change_due, cost_total, items_count, status, note)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok', ?)`,
    params: [
      saleId,
      number,
      requestId,
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
    ]
  });

  built.forEach((b, index) => {
    stmts.push({
      sql: `INSERT INTO sale_items
        (sale_id, product_id, presentation_id, name, code, measure, unit_label, qty, factor,
         base_qty, unit_price, discount, subtotal, unit_cost, tax_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
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
        calc.items[index].subtotal,
        b.unitCost,
        b.taxRate
      ]
    });
  });

  for (const [productId, needed] of neededByProduct) {
    const line = built.find((b) => b.product.id === productId);
    stmts.push({
      sql: `INSERT INTO stock_movements
        (product_id, type, qty, stock_after, cost, note, ref_type, ref_id, created_at)
        VALUES (?, 'venta', ?, (SELECT stock FROM products WHERE id = ?), ?, ?, 'venta', ?, ?)`,
      params: [productId, -needed, productId, line.unitCost, `Venta ${number}`, saleId, created]
    });
  }

  stmts.push({ sql: 'DELETE FROM guards' });

  return { settings, saleId, number, created, built, stmts, neededByProduct, requestId };
}

async function mapStockFailure(db, err, built, neededByProduct) {
  if (!/CHECK constraint/i.test(err.message || '')) return null;
  for (const [productId, needed] of neededByProduct) {
    const fresh = await db.get('SELECT id, name, stock FROM products WHERE id = ?', [productId]);
    if (fresh && Number(fresh.stock) < needed) return stockError(fresh, Number(fresh.stock), needed);
  }
  return null;
}

export async function insertSale(db, payload) {
  const requestId = text(payload.request_id, 80);
  if (requestId) {
    const existing = await db.get('SELECT id FROM sales WHERE request_id = ?', [requestId]);
    if (existing) return getSale(db, existing.id);
  }

  const prepared = await prepareSale(db, payload);
  try {
    await db.batch(prepared.stmts);
  } catch (err) {
    if (requestId && /UNIQUE/i.test(err.message || '')) {
      const existing = await db.get('SELECT id FROM sales WHERE request_id = ?', [requestId]);
      if (existing) return getSale(db, existing.id);
    }
    const friendly = await mapStockFailure(db, err, prepared.built, prepared.neededByProduct);
    if (friendly) throw friendly;
    throw err;
  }
  return getSale(db, prepared.saleId);
}

export async function voidSale(db, id) {
  const current = await getSale(db, id);
  if (!current) throw new ApiError(404, 'Venta no encontrada.');
  if (current.status !== 'ok') throw new ApiError(409, 'Esta venta ya fue anulada.');

  const settings = await getSettings(db);
  const now = nowLocal(settings.timezone);
  const stmts = [
    {
      sql: "INSERT INTO guards (ok) SELECT CASE WHEN (SELECT status FROM sales WHERE id = ?) = 'ok' THEN 1 ELSE 0 END",
      params: [current.id]
    },
    {
      sql: "UPDATE sales SET status = 'anulada' WHERE id = ? AND status = 'ok'",
      params: [current.id]
    }
  ];

  for (const item of current.items) {
    if (!item.product_id) continue;
    stmts.push({
      sql: 'UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?',
      params: [Number(item.base_qty), now, item.product_id]
    });
    stmts.push({
      sql: `INSERT INTO stock_movements
        (product_id, type, qty, stock_after, cost, note, ref_type, ref_id, created_at)
        VALUES (?, 'anulacion', ?, (SELECT stock FROM products WHERE id = ?), ?, ?, 'venta', ?, ?)`,
      params: [
        item.product_id,
        Number(item.base_qty),
        item.product_id,
        Number(item.unit_cost) || 0,
        `Anulación ${current.number}`,
        current.id,
        now
      ]
    });
  }
  stmts.push({ sql: 'DELETE FROM guards' });

  try {
    await db.batch(stmts);
  } catch (err) {
    if (/CHECK constraint/i.test(err.message || '')) {
      throw new ApiError(409, 'Esta venta ya fue anulada por otra sesión.');
    }
    throw err;
  }
  return getSale(db, current.id);
}

/* ---------------- cotizaciones ---------------- */

async function buildQuoteLines(db, rawItems) {
  const { products, presentations } = await loadSaleContext(db, rawItems);
  return rawItems.map((raw) => {
    const product = products.get(Number(raw.product_id));
    if (!product || !product.active) throw new ApiError(400, 'Producto no encontrado.');
    let factor = 1;
    let unitLabel = product.unit_abbr || 'UND';
    let unitPrice = raw.unit_price === undefined || raw.unit_price === '' ? product.sale_price : raw.unit_price;
    let presentationId = null;
    if (raw.presentation_id) {
      const pres = presentations.get(Number(raw.presentation_id));
      if (!pres || Number(pres.product_id) !== Number(product.id)) {
        throw new ApiError(400, 'Presentación no encontrada.');
      }
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
}

function quoteTotals(built, payload, settings, label) {
  const calc = totalsFromItems(
    built.map((b) => ({ qty: b.qty, unit_price: b.unitPrice, discount: b.discount, tax_rate: b.taxRate })),
    settings
  );
  const globalDiscount = asMoney(payload.discount || 0, 'El descuento');
  if (globalDiscount > calc.gross + 0.001) {
    throw new ApiError(400, `El descuento no puede superar el total de la ${label}.`);
  }
  const total = round2(calc.gross - globalDiscount);
  const ratio = calc.gross > 0 ? total / calc.gross : 0;
  return { calc, globalDiscount, total, subtotal: round2(calc.base * ratio), tax: round2(total - round2(calc.base * ratio)) };
}

export async function insertQuote(db, payload) {
  const requestId = text(payload.request_id, 80);
  if (requestId) {
    const existing = await db.get('SELECT id FROM quotes WHERE request_id = ?', [requestId]);
    if (existing) return getQuote(db, existing.id);
  }

  const settings = await getSettings(db);
  const rawItems = Array.isArray(payload.items) ? payload.items : [];
  if (!rawItems.length) throw new ApiError(400, 'La cotización no tiene productos.');
  const built = await buildQuoteLines(db, rawItems);
  const { calc, globalDiscount, total, subtotal, tax } = quoteTotals(built, payload, settings, 'cotización');

  let customerId = null;
  let customerName = text(payload.customer_name, 120) || 'Cliente';
  if (payload.customer_id) {
    const customer = await db.get('SELECT * FROM customers WHERE id = ?', [Number(payload.customer_id)]);
    if (customer) {
      customerId = customer.id;
      customerName = customer.name;
    }
  }

  const number = await nextCounter(db, 'quote', settings.quote_prefix || 'COT-', settings.quote_pad || 6);
  const quoteId = await nextSeq(db, 'quotes');
  const created = nowLocal(settings.timezone);
  const validUntil = text(payload.valid_until, 10) || addDaysLocal(settings.quote_valid_days || 15, settings.timezone);
  const status = ['borrador', 'enviada', 'aceptada'].includes(payload.status) ? payload.status : 'borrador';

  const stmts = [
    {
      sql: `INSERT INTO quotes
        (id, number, request_id, customer_id, customer_name, created_at, valid_until, status, notes,
         subtotal, discount, tax, total)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        quoteId,
        number,
        requestId || null,
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
      ]
    }
  ];

  built.forEach((b, index) => {
    stmts.push({
      sql: `INSERT INTO quote_items
        (quote_id, product_id, presentation_id, name, code, measure, unit_label, qty, factor,
         base_qty, unit_price, discount, subtotal, unit_cost, tax_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
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
      ]
    });
  });

  try {
    await db.batch(stmts);
  } catch (err) {
    if (requestId && /UNIQUE/i.test(err.message || '')) {
      const existing = await db.get('SELECT id FROM quotes WHERE request_id = ?', [requestId]);
      if (existing) return getQuote(db, existing.id);
    }
    throw err;
  }
  return getQuote(db, quoteId);
}

export async function updateQuote(db, id, body) {
  const quote = await getQuote(db, id);
  if (!quote) throw new ApiError(404, 'Cotización no encontrada.');
  if (['convertida', 'anulada'].includes(quote.status)) {
    throw new ApiError(409, 'Esta cotización ya no se puede editar.');
  }

  const settings = await getSettings(db);
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (!rawItems.length) throw new ApiError(400, 'La cotización no tiene productos.');
  const built = await buildQuoteLines(db, rawItems);
  const { calc, globalDiscount, total, subtotal, tax } = quoteTotals(built, body, settings, 'cotización');

  let customerId = null;
  let customerName = text(body.customer_name, 120) || quote.customer_name || 'Cliente';
  if (body.customer_id) {
    const c = await db.get('SELECT * FROM customers WHERE id = ?', [Number(body.customer_id)]);
    if (c) {
      customerId = c.id;
      customerName = c.name;
    }
  }
  const validUntil = text(body.valid_until, 10) || quote.valid_until;
  const status = ['borrador', 'enviada', 'aceptada'].includes(body.status) ? body.status : quote.status;
  const now = nowLocal(settings.timezone);

  const stmts = [
    {
      sql: `INSERT INTO guards (ok) SELECT CASE WHEN
            (SELECT status FROM quotes WHERE id = ?) NOT IN ('convertida','anulada')
            THEN 1 ELSE 0 END`,
      params: [id]
    },
    {
      sql: `UPDATE quotes SET customer_id = ?, customer_name = ?, valid_until = ?, status = ?,
              notes = ?, subtotal = ?, discount = ?, tax = ?, total = ?, updated_at = ?
            WHERE id = ? AND status NOT IN ('convertida','anulada')`,
      params: [
        customerId,
        customerName,
        validUntil,
        status,
        text(body.notes ?? quote.notes, 500),
        subtotal,
        globalDiscount,
        tax,
        total,
        now,
        id
      ]
    },
    { sql: 'DELETE FROM quote_items WHERE quote_id = ?', params: [id] }
  ];

  built.forEach((b, index) => {
    stmts.push({
      sql: `INSERT INTO quote_items
        (quote_id, product_id, presentation_id, name, code, measure, unit_label, qty, factor,
         base_qty, unit_price, discount, subtotal, unit_cost, tax_rate)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
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
      ]
    });
  });
  stmts.push({ sql: 'DELETE FROM guards' });

  try {
    await db.batch(stmts);
  } catch (err) {
    if (/CHECK constraint/i.test(err.message || '')) {
      throw new ApiError(409, 'Esta cotización ya no se puede editar.');
    }
    throw err;
  }
  return getQuote(db, id);
}

export async function convertQuote(db, id, body = {}) {
  const quote = await getQuote(db, id);
  if (!quote) throw new ApiError(404, 'Cotización no encontrada.');
  /* Si ya se convirtió, devolver la misma venta: los reintentos no duplican. */
  if (quote.status === 'convertida' && quote.sale_id) {
    const sale = await getSale(db, quote.sale_id);
    if (sale) return { sale, quote };
  }
  if (quote.status === 'convertida') throw new ApiError(409, 'Esta cotización ya fue convertida.');
  if (quote.status === 'anulada') throw new ApiError(409, 'Esta cotización está anulada.');

  const prepared = await prepareSale(db, {
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

  const now = nowLocal(prepared.settings.timezone);
  prepared.stmts.splice(prepared.stmts.length - 1, 0,
    {
      sql: `INSERT INTO guards (ok) SELECT CASE WHEN
            (SELECT status FROM quotes WHERE id = ?) NOT IN ('convertida','anulada')
            THEN 1 ELSE 0 END`,
      params: [id]
    },
    {
      sql: `UPDATE quotes SET status = 'convertida', sale_id = ?, updated_at = ?
            WHERE id = ? AND status NOT IN ('convertida','anulada')`,
      params: [prepared.saleId, now, id]
    }
  );

  try {
    await db.batch(prepared.stmts);
  } catch (err) {
    if (/CHECK constraint/i.test(err.message || '')) {
      throw new ApiError(409, 'Esta cotización ya fue convertida por otra sesión.');
    }
    const friendly = await mapStockFailure(db, err, prepared.built, prepared.neededByProduct);
    if (friendly) throw friendly;
    throw err;
  }

  return { sale: await getSale(db, prepared.saleId), quote: await getQuote(db, id) };
}

/* ---------------- productos ---------------- */

export async function productInput(db, body, existing = null) {
  const settings = await getSettings(db);
  const name = text(body.name ?? existing?.name, 200);
  if (!name) throw new ApiError(400, 'El nombre del producto es obligatorio.');
  const sku = text(body.sku ?? existing?.sku, 60);
  const barcode = text(body.barcode ?? existing?.barcode, 60);
  const stock =
    body.stock === undefined || body.stock === null || body.stock === ''
      ? Number(existing?.stock ?? 0)
      : asQty(body.stock, 'El stock inicial', { allowZero: true });
  const categoryId =
    body.category_id === '' || body.category_id === null || body.category_id === undefined
      ? existing?.category_id ?? null
      : Number(body.category_id) || null;
  let unitId =
    body.unit_id === '' || body.unit_id === null || body.unit_id === undefined
      ? existing?.unit_id ?? null
      : Number(body.unit_id) || null;
  if (!unitId) {
    const firstUnit = await db.get('SELECT id FROM units WHERE active = 1 ORDER BY id LIMIT 1');
    unitId = firstUnit?.id ?? null;
  }
  if (!unitId) throw new ApiError(400, 'Debes crear al menos una unidad de medida.');
  if (categoryId) {
    const cat = await db.get('SELECT id FROM categories WHERE id = ? AND active = 1', [categoryId]);
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
    stock,
    settings
  };
}

function presentationStatements(db, productId, list) {
  const stmts = [{ sql: 'DELETE FROM presentations WHERE product_id = ?', params: [productId] }];
  const arr = Array.isArray(list) ? list : [];
  arr.forEach((p, index) => {
    const label = text(p.label, 60);
    if (!label) return;
    stmts.push({
      sql: 'INSERT INTO presentations (product_id, label, qty, price, barcode, sort) VALUES (?, ?, ?, ?, ?, ?)',
      params: [
        productId,
        label,
        asQty(p.qty, 'La cantidad de la presentación'),
        asMoney(p.price, 'El precio de la presentación'),
        text(p.barcode, 60),
        index
      ]
    });
  });
  return stmts;
}

export async function createProduct(db, body) {
  const data = await productInput(db, body);
  const settings = data.settings;
  if (!data.sku) data.sku = await nextCounter(db, 'product', 'P-', 6);
  await assertUniqueProduct(db, { sku: data.sku, barcode: data.barcode });

  const cat = data.categoryId ? await db.get('SELECT name FROM categories WHERE id = ?', [data.categoryId]) : null;
  const unit = await db.get('SELECT abbr FROM units WHERE id = ?', [data.unitId]);
  const searchText = buildSearchText(data, cat?.name || '', unit?.abbr || '');
  const id = await nextSeq(db, 'products');
  const created = nowLocal(settings.timezone);

  const stmts = [
    {
      sql: `INSERT INTO products
        (id, sku, barcode, name, search_text, category_id, unit_id, measure, material, brand,
         cost_price, sale_price, wholesale_price, stock, min_stock, location, tax_rate, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        id,
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
        created
      ]
    },
    ...presentationStatements(db, id, body.presentations)
  ];

  if (data.stock !== 0) {
    stmts.push({
      sql: `INSERT INTO stock_movements
        (product_id, type, qty, stock_after, cost, note, created_at)
        VALUES (?, 'inicial', ?, ?, ?, 'Stock inicial', ?)`,
      params: [id, data.stock, data.stock, data.costPrice, created]
    });
  }

  await db.batch(stmts);
  return getProduct(db, id);
}

export async function updateProduct(db, id, body, current) {
  const data = await productInput(db, body, current);
  if (!data.sku) data.sku = current.sku || (await nextCounter(db, 'product', 'P-', 6));
  await assertUniqueProduct(db, { sku: data.sku, barcode: data.barcode, excludeId: id });

  const cat = data.categoryId ? await db.get('SELECT name FROM categories WHERE id = ?', [data.categoryId]) : null;
  const unit = await db.get('SELECT abbr FROM units WHERE id = ?', [data.unitId]);
  const searchText = buildSearchText(data, cat?.name || '', unit?.abbr || '');
  const updatedAt = nowLocal(data.settings.timezone);

  const stmts = [
    {
      sql: `UPDATE products SET
              sku = ?, barcode = ?, name = ?, search_text = ?, category_id = ?, unit_id = ?,
              measure = ?, material = ?, brand = ?, cost_price = ?, sale_price = ?,
              wholesale_price = ?, min_stock = ?, location = ?, tax_rate = ?, updated_at = ?
            WHERE id = ?`,
      params: [
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
        updatedAt,
        id
      ]
    }
  ];
  if (body.presentations !== undefined) stmts.push(...presentationStatements(db, id, body.presentations));

  await db.batch(stmts);
  return getProduct(db, id);
}

export async function adjustStock(db, id, body) {
  const product = await getProductLite(db, id);
  if (!product) throw new ApiError(404, 'Producto no encontrado.');
  const settings = await getSettings(db);
  const now = nowLocal(settings.timezone);
  const type = String(body.type || 'entrada');

  let delta;
  let sql;
  let params;

  if (type === 'entrada') {
    const qty = asQty(body.qty, 'La cantidad de entrada');
    delta = qty;
    sql = 'UPDATE products SET stock = stock + ?, updated_at = ? WHERE id = ?';
    params = [qty, now, id];
  } else if (type === 'salida') {
    const qty = asQty(body.qty, 'La cantidad de salida');
    delta = -qty;
    sql = 'UPDATE products SET stock = stock - ?, updated_at = ? WHERE id = ?';
    params = [qty, now, id];
  } else if (type === 'ajuste') {
    const qty = asQty(body.qty, 'El conteo', { allowZero: true });
    delta = roundQty(qty - Number(product.stock));
    sql = 'UPDATE products SET stock = ?, updated_at = ? WHERE id = ?';
    params = [qty, now, id];
  } else {
    throw new ApiError(400, 'Tipo de ajuste inválido.');
  }

  const stmts = [];
  if (!settings.allow_negative_stock && type !== 'ajuste') {
    stmts.push({
      sql: 'INSERT INTO guards (ok) SELECT CASE WHEN (SELECT stock FROM products WHERE id = ?) + ? >= 0 THEN 1 ELSE 0 END',
      params: [id, delta]
    });
  }
  stmts.push({ sql, params });
  stmts.push({
    sql: `INSERT INTO stock_movements
      (product_id, type, qty, stock_after, cost, note, ref_type, ref_id, created_at)
      VALUES (?, ?, ?, (SELECT stock FROM products WHERE id = ?), ?, ?, 'ajuste', NULL, ?)`,
    params: [id, type, delta, id, Number(product.cost_price) || 0, text(body.note, 200), now]
  });
  stmts.push({ sql: 'DELETE FROM guards' });

  try {
    await db.batch(stmts);
  } catch (err) {
    if (/CHECK constraint/i.test(err.message || '')) {
      throw new ApiError(409, `El stock de "${product.name}" quedaría negativo.`);
    }
    throw err;
  }

  const updated = await getProductLite(db, id);
  return { product: await getProduct(db, id), delta, stock_after: Number(updated.stock) };
}

/* ---------------- respaldo ---------------- */

function sqlValue(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

export async function buildBackupSql(db) {
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
    'stock_movements',
    'counters'
  ];
  const out = ['-- Respaldo Mostrador POS', `-- Generado: ${new Date().toISOString()}`];
  for (const table of tables) {
    let rows = await db.all(`SELECT * FROM ${table}`);
    /* Nunca exportar el hash de la clave. */
    if (table === 'settings') rows = rows.filter((r) => !String(r.key).startsWith('auth_'));
    for (const row of rows) {
      const cols = Object.keys(row);
      out.push(
        `INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => sqlValue(row[c])).join(', ')});`
      );
    }
  }
  out.push('');
  return out.join('\n');
}
