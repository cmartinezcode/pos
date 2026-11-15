/* =========================================================
   MOSTRADOR · API portable (Workers + Node)
   Recibe una petición ya normalizada y devuelve una respuesta
   plana { status, body, contentType, headers }.
   ========================================================= */

import {
  DEFAULT_SETTINGS,
  dateLocal,
  nowLocal,
  norm,
  round2
} from '../db.js';
import { ApiError } from './errors.js';
import {
  buildBackupSql,
  convertQuote,
  createProduct,
  getProduct,
  getQuote,
  getSale,
  getSettings,
  getStats,
  insertQuote,
  insertSale,
  nextSeq,
  peekCounter,
  saveSettings,
  updateProduct,
  updateQuote,
  adjustStock,
  voidSale,
  getAuthRow
} from './store.js';
import { buildQuote, buildReceipt, buildTest } from '../lib/receipt.js';
import {
  changePassword,
  clearCookie,
  clearFailures,
  ensureAuth,
  isRateLimited,
  recordFailure,
  sessionCookie,
  sessionTokenFrom,
  verifyPassword,
  verifySession,
  signSession
} from './auth.js';

/* ---------------- utilidades ---------------- */

const JSON_TYPE = 'application/json; charset=utf-8';
const NO_STORE = { 'Cache-Control': 'no-store' };

function json(status, data, headers = {}) {
  return { status, body: JSON.stringify(data), contentType: JSON_TYPE, headers: { ...NO_STORE, ...headers } };
}

function textResponse(status, body, contentType = 'text/plain; charset=utf-8', headers = {}) {
  return { status, body, contentType, headers: { ...NO_STORE, ...headers } };
}

function attachment(filename) {
  return { 'Content-Disposition': `attachment; filename="${filename}"` };
}

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

function likePattern(q, max = 40) {
  return `%${norm(q).slice(0, max)}%`;
}

function rawLike(q, max = 40) {
  /* D1 limita el patrón LIKE a 50 bytes: recorta sin romper UTF-8. */
  const encoder = new TextEncoder();
  let inner = text(q, max);
  while (inner.length && encoder.encode(`%${inner}%`).length > 50) inner = inner.slice(0, -1);
  return `%${inner}%`;
}

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[;"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csv(rows) {
  return '\uFEFF' + rows.map((r) => r.map(csvEscape).join(';')).join('\r\n') + '\r\n';
}

/* ---------------- autenticación ---------------- */

function authEnabled(env) {
  return Boolean(env?.AUTH_SECRET);
}

async function currentSession(ctx) {
  if (!authEnabled(ctx.env)) return { local: true, session: null };
  const token = sessionTokenFrom(ctx.headers);
  const session = await verifySession(ctx.env.AUTH_SECRET, token);
  return { local: false, session };
}

async function handleLogin(ctx) {
  const { db, env } = ctx;
  if (!authEnabled(env)) return json(200, { ok: true, auth: false });

  const ip = text(ctx.ip, 80) || 'desconocida';
  if (await isRateLimited(db, ip)) {
    throw new ApiError(429, 'Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.');
  }

  const password = text(ctx.body?.password, 300);
  if (!password) throw new ApiError(400, 'Escribe la clave de acceso.');

  await ensureAuth(db, env);
  const record = await getAuthRow(db);
  if (!(await verifyPassword(record, password))) {
    await recordFailure(db, ip);
    throw new ApiError(401, 'Clave incorrecta.');
  }

  await clearFailures(db, ip);
  const token = await sessionCookieToken(env);
  return json(200, { ok: true, auth: true }, { 'Set-Cookie': token });
}

async function sessionCookieToken(env) {
  const token = await signSession(env.AUTH_SECRET);
  return sessionCookie(token, { secure: env.COOKIE_SECURE !== '0' });
}

/* ---------------- ruta principal ---------------- */

export async function handleApi(ctx) {
  const { db, env = {}, method = 'GET', pathname, params } = ctx;

  try {
    /* Rutas públicas */
    if (method === 'GET' && pathname === '/api/health') {
      return json(200, { ok: true, app: 'mostrador', runtime: db.kind || 'desconocido' });
    }

    if (pathname === '/api/session' && method === 'GET') {
      const { local, session } = await currentSession(ctx);
      return json(200, { authenticated: local || Boolean(session), local });
    }

    if (pathname === '/api/login' && method === 'POST') {
      return await handleLogin(ctx);
    }

    if (pathname === '/api/logout' && method === 'POST') {
      return json(200, { ok: true }, { 'Set-Cookie': clearCookie({ secure: env.COOKIE_SECURE !== '0' }) });
    }

    /* Todo lo demás requiere sesión cuando hay AUTH_SECRET. */
    const { session } = await currentSession(ctx);
    if (authEnabled(env) && !session) {
      return json(401, { error: 'Sesión expirada. Vuelve a entrar.' });
    }

    if (pathname === '/api/password' && method === 'PUT') {
      if (!authEnabled(env)) throw new ApiError(400, 'El cambio de clave solo aplica en la nube.');
      await changePassword(db, text(ctx.body?.current, 300), text(ctx.body?.next, 300), env);
      return json(200, { ok: true });
    }

    const settings = await getSettings(db);
    const tz = settings.timezone || DEFAULT_SETTINGS.timezone;

    if (method === 'GET' && pathname === '/api/bootstrap') {
      const categories = await db.all(
        `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS products
         FROM categories c WHERE c.active = 1 ORDER BY c.sort, c.name COLLATE NOCASE`
      );
      const units = await db.all(
        `SELECT u.*, (SELECT COUNT(*) FROM products p WHERE p.unit_id = u.id AND p.active = 1) AS products
         FROM units u WHERE u.active = 1 ORDER BY u.id`
      );
      return json(200, {
        settings,
        categories,
        units,
        stats: await getStats(db),
        next_ticket: await peekCounter(db, 'ticket', settings.ticket_prefix || 'T-', settings.ticket_pad || 6),
        next_quote: await peekCounter(db, 'quote', settings.quote_prefix || 'COT-', settings.quote_pad || 6),
        printer: { method: 'browser', device: '', device_exists: false }
      });
    }

    /* ---------- Configuración ---------- */
    if (pathname === '/api/settings') {
      if (method === 'GET') return json(200, settings);
      if (method === 'PUT') {
        const body = ctx.body;
        if (!body || typeof body !== 'object') throw new ApiError(400, 'Configuración inválida.');
        const allowed = new Set([
          'store_name', 'store_doc', 'store_address', 'store_city', 'store_phone',
          'store_footer', 'receipt_note', 'currency', 'locale', 'timezone',
          'doc_title', 'quote_title', 'ticket_prefix', 'ticket_pad', 'quote_prefix',
          'quote_pad', 'quote_valid_days', 'default_tax_rate', 'prices_include_tax',
          'print_method', 'print_device', 'print_host', 'print_port', 'print_cols',
          'cut_paper', 'auto_print', 'allow_negative_stock', 'accent', 'scanlines'
        ]);
        const patch = {};
        for (const [k, v] of Object.entries(body)) {
          if (allowed.has(k)) patch[k] = v;
        }
        if (patch.timezone !== undefined) {
          try {
            new Intl.DateTimeFormat('en-CA', { timeZone: String(patch.timezone) });
          } catch {
            throw new ApiError(400, 'Zona horaria inválida.');
          }
        }
        /* En la nube solo se imprime desde el navegador. */
        if (patch.print_method !== undefined) patch.print_method = 'browser';
        return json(200, await saveSettings(db, patch));
      }
    }

    /* ---------- Categorías ---------- */
    if (pathname === '/api/categories') {
      if (method === 'GET') {
        return json(
          200,
          await db.all(
            `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.active = 1) AS products
             FROM categories c WHERE c.active = 1 ORDER BY c.sort, c.name COLLATE NOCASE`
          )
        );
      }
      if (method === 'POST') {
        const name = text(ctx.body?.name, 80);
        if (!name) throw new ApiError(400, 'El nombre de la categoría es obligatorio.');
        const dup = await db.get('SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND active = 1', [name]);
        if (dup) throw new ApiError(409, 'Ya existe una categoría con ese nombre.');
        const id = await nextSeq(db, 'categories');
        await db.run('INSERT INTO categories (id, name, parent_id) VALUES (?, ?, ?)', [
          id,
          name,
          ctx.body?.parent_id ? Number(ctx.body.parent_id) : null
        ]);
        return json(201, await db.get('SELECT * FROM categories WHERE id = ?', [id]));
      }
    }

    let m = pathname.match(/^\/api\/categories\/(\d+)$/);
    if (m && (method === 'PUT' || method === 'DELETE')) {
      const id = Number(m[1]);
      const row = await db.get('SELECT * FROM categories WHERE id = ? AND active = 1', [id]);
      if (!row) throw new ApiError(404, 'Categoría no encontrada.');
      if (method === 'PUT') {
        const name = text(ctx.body?.name, 80);
        if (!name) throw new ApiError(400, 'El nombre es obligatorio.');
        const dup = await db.get(
          'SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND active = 1 AND id <> ?',
          [name, id]
        );
        if (dup) throw new ApiError(409, 'Ya existe una categoría con ese nombre.');
        await db.run('UPDATE categories SET name = ? WHERE id = ?', [name, id]);
        return json(200, await db.get('SELECT * FROM categories WHERE id = ?', [id]));
      }
      const used = await db.get('SELECT COUNT(*) AS c FROM products WHERE category_id = ? AND active = 1', [id]);
      const children = await db.get('SELECT COUNT(*) AS c FROM categories WHERE parent_id = ? AND active = 1', [id]);
      if (Number(used.c) > 0 || Number(children.c) > 0) {
        throw new ApiError(409, 'No se puede borrar: la categoría tiene productos o subcategorías.');
      }
      await db.run('UPDATE categories SET active = 0 WHERE id = ?', [id]);
      return json(200, { ok: true });
    }

    /* ---------- Unidades ---------- */
    if (pathname === '/api/units') {
      if (method === 'GET') {
        return json(
          200,
          await db.all(
            `SELECT u.*, (SELECT COUNT(*) FROM products p WHERE p.unit_id = u.id AND p.active = 1) AS products
             FROM units u WHERE u.active = 1 ORDER BY u.id`
          )
        );
      }
      if (method === 'POST') {
        const name = text(ctx.body?.name, 60);
        const abbr = text(ctx.body?.abbr, 12).toUpperCase();
        if (!name || !abbr) throw new ApiError(400, 'Nombre y abreviatura son obligatorios.');
        const dup = await db.get('SELECT id FROM units WHERE abbr = ? COLLATE NOCASE AND active = 1', [abbr]);
        if (dup) throw new ApiError(409, 'Ya existe una unidad con esa abreviatura.');
        const decimals = ['1', 1, true].includes(ctx.body?.decimals) ? 2 : 0;
        const id = await nextSeq(db, 'units');
        await db.run('INSERT INTO units (id, name, abbr, decimals) VALUES (?, ?, ?, ?)', [
          id,
          name,
          abbr,
          decimals
        ]);
        return json(201, await db.get('SELECT * FROM units WHERE id = ?', [id]));
      }
    }

    m = pathname.match(/^\/api\/units\/(\d+)$/);
    if (m && (method === 'PUT' || method === 'DELETE')) {
      const id = Number(m[1]);
      const row = await db.get('SELECT * FROM units WHERE id = ? AND active = 1', [id]);
      if (!row) throw new ApiError(404, 'Unidad no encontrada.');
      if (method === 'PUT') {
        const name = text(ctx.body?.name ?? row.name, 60);
        const abbr = text(ctx.body?.abbr ?? row.abbr, 12).toUpperCase();
        const decimals =
          ctx.body?.decimals === undefined ? row.decimals : ['1', 1, true, 'true'].includes(ctx.body.decimals) ? 2 : 0;
        const dup = await db.get(
          'SELECT id FROM units WHERE abbr = ? COLLATE NOCASE AND active = 1 AND id <> ?',
          [abbr, id]
        );
        if (dup) throw new ApiError(409, 'Ya existe una unidad con esa abreviatura.');
        await db.run('UPDATE units SET name = ?, abbr = ?, decimals = ? WHERE id = ?', [name, abbr, decimals, id]);
        return json(200, await db.get('SELECT * FROM units WHERE id = ?', [id]));
      }
      const used = await db.get('SELECT COUNT(*) AS c FROM products WHERE unit_id = ? AND active = 1', [id]);
      if (Number(used.c) > 0) throw new ApiError(409, 'No se puede borrar: hay productos usando esta unidad.');
      const total = await db.get('SELECT COUNT(*) AS c FROM units WHERE active = 1');
      if (Number(total.c) <= 1) throw new ApiError(409, 'Debe quedar al menos una unidad de medida.');
      await db.run('UPDATE units SET active = 0 WHERE id = ?', [id]);
      return json(200, { ok: true });
    }

    /* ---------- Búsqueda de venta ---------- */
    if (method === 'GET' && pathname === '/api/search') {
      const q = text(params.get('q'), 100);
      const results = [];
      const seen = new Set();

      const baseSelect = `SELECT p.*, c.name AS category_name, u.abbr AS unit_abbr
        FROM products p
        LEFT JOIN categories c ON c.id = p.category_id
        LEFT JOIN units u ON u.id = p.unit_id
        WHERE p.active = 1`;

      let products;
      if (!q) {
        products = await db.all(`${baseSelect} ORDER BY p.name COLLATE NOCASE LIMIT 8`);
      } else {
        products = await db.all(
          `${baseSelect} AND (p.search_text LIKE ? OR p.barcode = ? OR p.sku = ?)
           ORDER BY
             CASE WHEN p.barcode = ? THEN 0 WHEN p.sku = ? COLLATE NOCASE THEN 0
                  WHEN p.search_text LIKE ? THEN 1 ELSE 2 END,
             p.name COLLATE NOCASE
           LIMIT 10`,
          [likePattern(q), q, q, q, q, `${norm(q).slice(0, 40)}%`]
        );
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

      if (q) {
        const exactPres = await db.get(
          `SELECT pr.*, p.name, p.sku, p.measure, p.material, p.brand, p.stock, p.cost_price,
                  p.tax_rate, c.name AS category_name, u.abbr AS unit_abbr
           FROM presentations pr
           JOIN products p ON p.id = pr.product_id
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN units u ON u.id = p.unit_id
           WHERE pr.barcode = ? AND p.active = 1
           LIMIT 1`,
          [q]
        );
        if (exactPres) pushPresentation({ ...exactPres, id: exactPres.product_id, sale_price: exactPres.price }, exactPres);
      }

      for (const p of products) {
        pushProduct(p);
        const presentations = await db.all('SELECT * FROM presentations WHERE product_id = ? ORDER BY sort, id', [
          p.id
        ]);
        for (const pres of presentations) pushPresentation(p, pres);
      }

      const sliced = results.slice(0, 14);
      for (const r of sliced) {
        if (r.kind === 'product' && r.stock <= 0 && settings.allow_negative_stock === false) r.disabled = true;
        if (r.kind === 'presentation' && settings.allow_negative_stock === false && r.stock < r.factor) {
          r.disabled = true;
        }
      }
      return json(200, sliced);
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
          where.push('(p.search_text LIKE ? OR p.barcode = ? OR p.sku = ?)');
          args.push(likePattern(q), q, q);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const total = await db.get(`SELECT COUNT(*) AS c FROM products p ${whereSql}`, args);
        const items = await db.all(
          `SELECT p.*, c.name AS category_name, u.abbr AS unit_abbr, u.name AS unit_name
           FROM products p
           LEFT JOIN categories c ON c.id = p.category_id
           LEFT JOIN units u ON u.id = p.unit_id
           ${whereSql}
           ORDER BY p.name COLLATE NOCASE
           LIMIT ? OFFSET ?`,
          [...args, limit, offset]
        );
        return json(200, { items, total: Number(total.c) });
      }

      if (method === 'POST') {
        return json(201, await createProduct(db, ctx.body || {}));
      }
    }

    m = pathname.match(/^\/api\/products\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const product = await getProduct(db, id);
      if (!product) throw new ApiError(404, 'Producto no encontrado.');
      if (method === 'GET') return json(200, product);
      if (method === 'PUT') return json(200, await updateProduct(db, id, ctx.body || {}, product));
      if (method === 'DELETE') {
        await db.run('UPDATE products SET active = 0, updated_at = ? WHERE id = ?', [nowLocal(tz), id]);
        return json(200, { ok: true });
      }
    }

    m = pathname.match(/^\/api\/products\/(\d+)\/adjust$/);
    if (m && method === 'POST') {
      return json(200, await adjustStock(db, Number(m[1]), ctx.body || {}));
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
        args.push(likePattern(q), q);
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
      return json(
        200,
        await db.all(
          `SELECT m.*, p.name AS product_name, p.sku, u.abbr AS unit_abbr
           FROM stock_movements m
           JOIN products p ON p.id = m.product_id
           LEFT JOIN units u ON u.id = p.unit_id
           ${whereSql}
           ORDER BY m.id DESC LIMIT ?`,
          [...args, limit]
        )
      );
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
          const like = rawLike(q);
          args.push(like, like, like);
        }
        return json(
          200,
          await db.all(`SELECT * FROM customers WHERE ${where.join(' AND ')} ORDER BY name COLLATE NOCASE LIMIT ?`, [
            ...args,
            limit
          ])
        );
      }
      if (method === 'POST') {
        const name = text(ctx.body?.name, 120);
        if (!name) throw new ApiError(400, 'El nombre del cliente es obligatorio.');
        const id = await nextSeq(db, 'customers');
        await db.run(
          'INSERT INTO customers (id, doc, name, phone, address, email, notes) VALUES (?, ?, ?, ?, ?, ?, ?)',
          [
            id,
            text(ctx.body?.doc, 40),
            name,
            text(ctx.body?.phone, 40),
            text(ctx.body?.address, 160),
            text(ctx.body?.email, 120),
            text(ctx.body?.notes, 300)
          ]
        );
        return json(201, await db.get('SELECT * FROM customers WHERE id = ?', [id]));
      }
    }

    m = pathname.match(/^\/api\/customers\/(\d+)$/);
    if (m && (method === 'PUT' || method === 'DELETE')) {
      const id = Number(m[1]);
      const row = await db.get('SELECT * FROM customers WHERE id = ? AND active = 1', [id]);
      if (!row) throw new ApiError(404, 'Cliente no encontrado.');
      if (method === 'PUT') {
        const name = text(ctx.body?.name ?? row.name, 120);
        if (!name) throw new ApiError(400, 'El nombre es obligatorio.');
        await db.run(
          'UPDATE customers SET doc = ?, name = ?, phone = ?, address = ?, email = ?, notes = ? WHERE id = ?',
          [
            text(ctx.body?.doc ?? row.doc, 40),
            name,
            text(ctx.body?.phone ?? row.phone, 40),
            text(ctx.body?.address ?? row.address, 160),
            text(ctx.body?.email ?? row.email, 120),
            text(ctx.body?.notes ?? row.notes, 300),
            id
          ]
        );
        return json(200, await db.get('SELECT * FROM customers WHERE id = ?', [id]));
      }
      await db.run('UPDATE customers SET active = 0 WHERE id = ?', [id]);
      return json(200, { ok: true });
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
          const like = rawLike(q);
          args.push(like, like);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        return json(
          200,
          await db.all(`SELECT * FROM sales ${whereSql} ORDER BY id DESC LIMIT ?`, [...args, limit])
        );
      }
      if (method === 'POST') {
        const sale = await insertSale(db, ctx.body || {});
        return json(201, { ...sale, receipt: buildReceipt(sale, await getSettings(db)) });
      }
    }

    m = pathname.match(/^\/api\/sales\/(\d+)$/);
    if (m && method === 'GET') {
      const sale = await getSale(db, Number(m[1]));
      if (!sale) throw new ApiError(404, 'Venta no encontrada.');
      return json(200, sale);
    }

    m = pathname.match(/^\/api\/sales\/(\d+)\/void$/);
    if (m && method === 'POST') {
      return json(200, await voidSale(db, Number(m[1])));
    }

    m = pathname.match(/^\/api\/sales\/(\d+)\/receipt$/);
    if (m && method === 'GET') {
      const sale = await getSale(db, Number(m[1]));
      if (!sale) throw new ApiError(404, 'Venta no encontrada.');
      return json(200, { text: buildReceipt(sale, await getSettings(db)) });
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
          const like = rawLike(q);
          args.push(like, like);
        }
        const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
        return json(
          200,
          await db.all(`SELECT * FROM quotes ${whereSql} ORDER BY id DESC LIMIT ?`, [...args, limit])
        );
      }
      if (method === 'POST') {
        const quote = await insertQuote(db, ctx.body || {});
        return json(201, { ...quote, receipt: buildQuote(quote, await getSettings(db)) });
      }
    }

    m = pathname.match(/^\/api\/quotes\/(\d+)$/);
    if (m) {
      const id = Number(m[1]);
      const quote = await getQuote(db, id);
      if (!quote) throw new ApiError(404, 'Cotización no encontrada.');
      if (method === 'GET') return json(200, quote);
      if (method === 'PUT') {
        const updated = await updateQuote(db, id, ctx.body || {});
        return json(200, { ...updated, receipt: buildQuote(updated, await getSettings(db)) });
      }
    }

    m = pathname.match(/^\/api\/quotes\/(\d+)\/status$/);
    if (m && method === 'POST') {
      const id = Number(m[1]);
      const status = String(ctx.body?.status || '');
      const allowed = ['borrador', 'enviada', 'aceptada', 'vencida', 'anulada'];
      if (!allowed.includes(status)) throw new ApiError(400, 'Estado inválido.');
      const quote = await getQuote(db, id);
      if (!quote) throw new ApiError(404, 'Cotización no encontrada.');
      if (quote.status === 'convertida') throw new ApiError(409, 'La cotización ya fue convertida en venta.');
      const stmts = [
        {
          sql: "INSERT INTO guards (ok) SELECT CASE WHEN (SELECT status FROM quotes WHERE id = ?) <> 'convertida' THEN 1 ELSE 0 END",
          params: [id]
        },
        {
          sql: "UPDATE quotes SET status = ?, updated_at = ? WHERE id = ? AND status <> 'convertida'",
          params: [status, nowLocal(tz), id]
        },
        { sql: 'DELETE FROM guards', params: [] }
      ];
      try {
        await db.batch(stmts);
      } catch (err) {
        if (/CHECK constraint/i.test(err.message || '')) {
          throw new ApiError(409, 'La cotización ya fue convertida por otra sesión.');
        }
        throw err;
      }
      return json(200, await getQuote(db, id));
    }

    m = pathname.match(/^\/api\/quotes\/(\d+)\/convert$/);
    if (m && method === 'POST') {
      const id = Number(m[1]);
      const result = await convertQuote(db, id, ctx.body || {});
      return json(201, { ...result, receipt: buildReceipt(result.sale, await getSettings(db)) });
    }

    m = pathname.match(/^\/api\/quotes\/(\d+)\/receipt$/);
    if (m && method === 'GET') {
      const quote = await getQuote(db, Number(m[1]));
      if (!quote) throw new ApiError(404, 'Cotización no encontrada.');
      return json(200, { text: buildQuote(quote, await getSettings(db)) });
    }

    /* ---------- Reportes ---------- */
    if (method === 'GET' && pathname === '/api/reports') {
      const today = dateLocal(tz);
      const from = text(params.get('from'), 10) || `${today.slice(0, 7)}-01`;
      const to = text(params.get('to'), 10) || today;
      const totals = await db.get(
        `SELECT COUNT(*) AS count, COALESCE(SUM(total),0) AS total,
                COALESCE(SUM(subtotal),0) AS base, COALESCE(SUM(tax),0) AS tax,
                COALESCE(SUM(cost_total),0) AS cost,
                COALESCE(SUM(subtotal - cost_total),0) AS profit
         FROM sales WHERE status = 'ok' AND date(created_at) BETWEEN ? AND ?`,
        [from, to]
      );
      const byDay = await db.all(
        `SELECT date(created_at) AS day, COUNT(*) AS count,
                SUM(total) AS total, SUM(subtotal - cost_total) AS profit
         FROM sales WHERE status = 'ok' AND date(created_at) BETWEEN ? AND ?
         GROUP BY date(created_at) ORDER BY day DESC`,
        [from, to]
      );
      const topProducts = await db.all(
        `SELECT si.product_id, si.name, si.code,
                SUM(si.base_qty) AS qty, SUM(si.subtotal) AS amount,
                SUM(si.base_qty * si.unit_cost) AS cost
         FROM sale_items si
         JOIN sales s ON s.id = si.sale_id
         WHERE s.status = 'ok' AND date(s.created_at) BETWEEN ? AND ?
         GROUP BY si.product_id, si.name, si.code
         ORDER BY amount DESC LIMIT 15`,
        [from, to]
      );
      const payments = await db.all(
        `SELECT payment_method, COUNT(*) AS count, SUM(total) AS total
         FROM sales WHERE status = 'ok' AND date(created_at) BETWEEN ? AND ?
         GROUP BY payment_method`,
        [from, to]
      );
      const lowStock = await db.all(
        `SELECT p.id, p.sku, p.name, p.stock, p.min_stock, u.abbr AS unit_abbr
         FROM products p LEFT JOIN units u ON u.id = p.unit_id
         WHERE p.active = 1 AND p.stock <= p.min_stock
         ORDER BY (p.stock - p.min_stock) ASC, p.name LIMIT 30`
      );
      const avg = Number(totals.count) ? round2(Number(totals.total) / Number(totals.count)) : 0;
      return json(200, { from, to, totals: { ...totals, avg }, byDay, topProducts, payments, lowStock });
    }

    /* ---------- Impresión (solo navegador) ---------- */
    if (pathname === '/api/print/status' && method === 'GET') {
      return json(200, { method: 'browser', device: '', device_exists: false, host: '', port: 0 });
    }

    if (pathname === '/api/print/sample' && method === 'GET') {
      return json(200, { text: buildTest(settings) });
    }

    if (pathname === '/api/print/test' && method === 'POST') {
      return json(200, { ok: true, browser: true, text: buildTest(settings) });
    }

    if (pathname === '/api/print' && method === 'POST') {
      throw new ApiError(400, 'En la nube el ticket se imprime desde el navegador (diálogo del sistema).');
    }

    /* ---------- Respaldo y exportación ---------- */
    if (pathname === '/api/backup' && method === 'GET') {
      const sql = await buildBackupSql(db);
      return textResponse(200, sql, 'application/sql; charset=utf-8', attachment(`mostrador-${today(tz)}.sql`));
    }

    if (pathname === '/api/export/products.csv' && method === 'GET') {
      const rows = await db.all(
        `SELECT p.sku, p.barcode, p.name, c.name AS category, u.abbr AS unit, p.measure,
                p.material, p.brand, p.cost_price, p.sale_price, p.wholesale_price,
                p.stock, p.min_stock, p.location, p.tax_rate, p.active
         FROM products p
         LEFT JOIN categories c ON c.id = p.category_id
         LEFT JOIN units u ON u.id = p.unit_id
         ORDER BY p.name COLLATE NOCASE`
      );
      const header = [
        'CODIGO', 'BARRAS', 'PRODUCTO', 'CATEGORIA', 'UNIDAD', 'MEDIDA', 'MATERIAL', 'MARCA',
        'COSTO', 'PRECIO', 'MAYORISTA', 'STOCK', 'MINIMO', 'UBICACION', 'IVA', 'ACTIVO'
      ];
      const data = [
        header,
        ...rows.map((r) => [
          r.sku, r.barcode, r.name, r.category, r.unit, r.measure, r.material, r.brand,
          r.cost_price, r.sale_price, r.wholesale_price, r.stock, r.min_stock, r.location,
          r.tax_rate, r.active ? 'SI' : 'NO'
        ])
      ];
      return textResponse(200, csv(data), 'text/csv; charset=utf-8', attachment(`productos-${today(tz)}.csv`));
    }

    if (pathname === '/api/export/movements.csv' && method === 'GET') {
      const rows = await db.all(
        `SELECT m.created_at, p.sku, p.name, u.abbr AS unit, m.type, m.qty, m.stock_after, m.note
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN units u ON u.id = p.unit_id
         ORDER BY m.id DESC LIMIT 5000`
      );
      const header = ['FECHA', 'CODIGO', 'PRODUCTO', 'UNIDAD', 'TIPO', 'CANTIDAD', 'SALDO', 'NOTA'];
      const data = [
        header,
        ...rows.map((r) => [r.created_at, r.sku, r.name, r.unit, r.type, r.qty, r.stock_after, r.note])
      ];
      return textResponse(200, csv(data), 'text/csv; charset=utf-8', attachment(`kardex-${today(tz)}.csv`));
    }

    throw new ApiError(404, 'Ruta no encontrada.');
  } catch (err) {
    if (err instanceof ApiError) return json(err.status, { error: err.message });
    console.error('API', err);
    const message = /UNIQUE/i.test(err.message || '')
      ? 'Ya existe un registro con esos datos.'
      : 'Error interno del servidor.';
    return json(500, { error: message });
  }
}

/* Alias local para no repetir la expresión en los encabezados. */
function today(tz) {
  return dateLocal(tz);
}
