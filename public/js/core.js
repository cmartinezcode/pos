/* =========================================================
   MOSTRADOR · núcleo de interfaz, estado y utilidades
   ========================================================= */

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const S = {
  settings: {},
  categories: [],
  units: [],
  stats: {},
  nextTicket: 'T-000001',
  nextQuote: 'COT-000001',
  printer: {},
  view: 'venta',
  lastSale: null,
  products: [],
  categoriesLoaded: false,
  booted: false
};

export const STATUS_LABELS = {
  borrador: 'Borrador',
  enviada: 'Enviada',
  aceptada: 'Aceptada',
  vencida: 'Vencida',
  convertida: 'Convertida',
  anulada: 'Anulada',
  ok: 'Válida'
};

export const PAY_LABELS = {
  efectivo: 'Efectivo',
  tarjeta: 'Tarjeta',
  transferencia: 'Transferencia',
  credito: 'Crédito'
};

/* ---------------- Utilidades ---------------- */
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[c]);
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

export function parseNum(value) {
  let s = String(value ?? '').trim().replace(/\s/g, '');
  if (!s) return 0;
  if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    s = s.replace(',', '.');
  }
  s = s.replace(/[^0-9.\-]/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export function fmtMoney(n, withSymbol = true) {
  const locale = S.settings.locale || 'es-CO';
  let formatted;
  try {
    formatted = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(round2(Number(n) || 0));
  } catch {
    formatted = (round2(Number(n) || 0)).toFixed(2);
  }
  return withSymbol ? `${S.settings.currency || '$'} ${formatted}` : formatted;
}

export function fmtQty(qty) {
  const n = Number(qty) || 0;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
}

export function fmtDate(value, withTime = true) {
  const s = String(value || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return s || '—';
  const date = `${m[3]}/${m[2]}/${m[1]}`;
  return withTime && m[4] ? `${date} ${m[4]}:${m[5]}` : date;
}

export function todayLocal() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function monthStartLocal() {
  return `${todayLocal().slice(0, 7)}-01`;
}

export function stockClass(stock, min) {
  const s = Number(stock) || 0;
  const m = Number(min) || 0;
  if (s <= 0) return 'stock-zero';
  if (s <= m) return 'stock-low';
  return 'stock-ok';
}

/* ---------------- API ---------------- */
export async function api(path, { method = 'GET', body, headers = {} } = {}) {
  const opts = { method, headers: { ...headers } };
  if (body !== undefined) {
    opts.body = JSON.stringify(body);
    opts.headers['Content-Type'] = 'application/json';
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    throw new Error('No hay conexión con el servidor. Verifica que Mostrador siga abierto.');
  }
  const type = res.headers.get('content-type') || '';
  let data = null;
  if (type.includes('application/json')) {
    data = await res.json().catch(() => null);
  } else {
    data = await res.text().catch(() => '');
  }
  if (!res.ok) {
    const message = data && typeof data === 'object' ? data.error : String(data || '');
    throw new Error(message || `Error ${res.status}`);
  }
  return data;
}

/* ---------------- Avisos y barra de estado ---------------- */
export function toast(message, type = 'ok', timeout = 3200) {
  const root = $('#toasts');
  if (!root) return;
  const box = document.createElement('div');
  box.className = `toast ${type}`;
  box.textContent = message;
  root.appendChild(box);
  setTimeout(() => {
    box.style.opacity = '0';
    box.style.transform = 'translateY(4px)';
    box.style.transition = 'opacity .2s, transform .2s';
    setTimeout(() => box.remove(), 220);
  }, timeout);
}

export function setStatus(message) {
  const el = $('#statusMsg');
  if (el) el.textContent = message || 'Listo.';
}

export function setStatusKeys(html) {
  const el = $('#statusKeys');
  if (el) el.innerHTML = html;
}

/* ---------------- Modales ---------------- */
const modalStack = [];

export function closeModal(runCallback = true) {
  const root = $('#modalRoot');
  if (!root) return;
  const top = modalStack[modalStack.length - 1];
  if (!top) {
    root.classList.remove('open');
    root.innerHTML = '';
    return;
  }
  if (runCallback && top.onClose) {
    try { top.onClose(); } catch { /* ignore */ }
  }
  top.overlay.remove();
  modalStack.pop();
  if (!modalStack.length) {
    root.classList.remove('open');
    root.innerHTML = '';
  }
}

export function openModal({ title, html = '', className = '', actions = '', onMount, onClose, closeLabel = 'Cerrar' }) {
  const root = $('#modalRoot');
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.dataset.modalOverlay = '';
  overlay.style.zIndex = String(1000 + modalStack.length * 10);
  overlay.innerHTML = `
      <div class="modal ${className}" role="dialog" aria-modal="true" aria-label="${esc(title)}">
        <div class="modal-head">
          <span>${esc(title)}</span>
          <div class="mh-actions">
            ${actions}
            <button type="button" class="modal-close" data-modal-close title="${esc(closeLabel)}">×</button>
          </div>
        </div>
        <div class="modal-body">${html}</div>
      </div>`;
  root.appendChild(overlay);
  root.classList.add('open');
  modalStack.push({ overlay, onClose: onClose || null });
  const modalEl = $('.modal', overlay);
  const close = () => closeModal(true);
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) close();
  });
  $('[data-modal-close]', overlay).addEventListener('click', close);
  if (onMount) onMount(modalEl, close);
  return { root: modalEl, close };
}

export function modalIsOpen() {
  return $('#modalRoot')?.classList.contains('open');
}

export function confirmDialog(message, { title = 'Confirmar', okLabel = 'Sí, continuar', cancelLabel = 'Cancelar', danger = false } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    openModal({
      title,
      className: 'small',
      html: `<div style="color:var(--fg);font-size:12px;line-height:1.7">${message}</div>
        <div class="form-actions">
          <button type="button" class="btn" data-cancel>${esc(cancelLabel)}</button>
          <button type="button" class="btn ${danger ? '' : 'primary'}" data-ok
            style="${danger ? 'border-color:var(--red);color:var(--red)' : ''}">${esc(okLabel)}</button>
        </div>`,
      onMount(modal, close) {
        $('[data-ok]', modal).addEventListener('click', () => { finish(true); close(); });
        $('[data-cancel]', modal).addEventListener('click', () => { finish(false); close(); });
        setTimeout(() => $('[data-ok]', modal)?.focus(), 20);
      },
      onClose() { finish(false); }
    });
  });
}

export function formDialog({ title, fields = [], submitLabel = 'Guardar', className = 'small', help = '' }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      resolve(value);
    };
    const fieldHtml = fields.map((f) => {
      const id = `fd-${f.name}`;
      const label = `<label for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>`;
      if (f.type === 'select') {
        const opts = (f.options || []).map((o) =>
          `<option value="${esc(o.value)}" ${String(o.value) === String(f.value ?? '') ? 'selected' : ''}>${esc(o.label)}</option>`
        ).join('');
        return `<div>${label}<select id="${id}" name="${esc(f.name)}">${opts}</select></div>`;
      }
      if (f.type === 'checkbox') {
        return `<label class="check" style="flex-direction:row;text-transform:none;letter-spacing:0">
          <input type="checkbox" id="${id}" name="${esc(f.name)}" ${f.value ? 'checked' : ''}> ${esc(f.label)}
        </label>`;
      }
      return `<div>${label}<input id="${id}" name="${esc(f.name)}" type="${esc(f.type || 'text')}"
        value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder || '')}"
        ${f.step ? `step="${esc(f.step)}"` : ''} ${f.min !== undefined ? `min="${esc(f.min)}"` : ''}
        ${f.required ? 'required' : ''} autocomplete="off"></div>`;
    }).join('');
    openModal({
      title,
      className,
      html: `${help ? `<div class="mini-note" style="margin:0 0 10px">${help}</div>` : ''}
        <form data-dialog-form class="form-grid">${fieldHtml}
          <div class="form-actions f2">
            <button type="button" class="btn" data-cancel>Cancelar</button>
            <button type="submit" class="btn primary">${esc(submitLabel)}</button>
          </div>
        </form>`,
      onMount(modal, close) {
        const form = $('[data-dialog-form]', modal);
        $('[data-cancel]', modal).addEventListener('click', () => { finish(null); close(); });
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const out = {};
          for (const f of fields) {
            const el = form.elements[f.name];
            if (!el) continue;
            out[f.name] = f.type === 'checkbox' ? el.checked : el.value;
          }
          finish(out);
          close();
        });
        setTimeout(() => {
          const first = $('input,select', form);
          if (first) { first.focus(); if (first.select) first.select(); }
        }, 30);
      },
      onClose() { finish(null); }
    });
  });
}

/* ---------------- Receipt / impresión ---------------- */
export function browserPrint(text) {
  const area = $('#printArea');
  area.innerHTML = `<div class="receipt-paper">${esc(text)}</div>`;
  setTimeout(() => {
    window.print();
    setTimeout(() => { area.innerHTML = ''; }, 800);
  }, 40);
}

export async function printServer(payload) {
  return api('/api/print', { method: 'POST', body: payload });
}

export function showReceipt({ text, title = 'Ticket', saleId = null, quoteId = null }) {
  let printed = false;
  const { close } = openModal({
    title,
    className: 'small',
    html: `<div class="receipt-paper" data-receipt-text>${esc(text)}</div>
      <div class="receipt-actions">
        <button type="button" class="btn primary" data-print-server>Imprimir 80 mm</button>
        <button type="button" class="btn" data-print-browser>Navegador / PDF</button>
        <button type="button" class="btn" data-receipt-close>Cerrar</button>
      </div>
      <div class="mini-note" data-print-note style="text-align:center">Puedes reimprimirlo desde Ventas cuando quieras.</div>`,
    onMount(modal, closeFn) {
      const note = $('[data-print-note]', modal);
      $('[data-print-browser]', modal).addEventListener('click', () => browserPrint(text));
      $('[data-print-server]', modal).addEventListener('click', async () => {
        const btn = $('[data-print-server]', modal);
        btn.disabled = true;
        btn.textContent = 'Enviando...';
        try {
          await printServer(saleId ? { sale_id: saleId } : quoteId ? { quote_id: quoteId } : { text });
          printed = true;
          note.textContent = 'Enviado a la impresora.';
          note.style.color = 'var(--accent)';
          toast('Ticket enviado a la impresora.', 'ok');
        } catch (err) {
          note.textContent = err.message;
          note.style.color = 'var(--amber)';
          toast(err.message, 'error', 5000);
        } finally {
          btn.disabled = false;
          btn.textContent = 'Imprimir 80 mm';
        }
      });
      $('[data-receipt-close]', modal).addEventListener('click', () => closeFn());
      setTimeout(() => $('[data-print-server]', modal)?.focus(), 30);
    },
    onClose() {
      return printed;
    }
  });
  return close;
}

/* ---------------- Cabecera / tema ---------------- */
const THEMES = ['copper', 'slate', 'amber', 'paper'];
const LEGACY_THEMES = { green: 'copper', white: 'paper' };

export function normalizeTheme(value) {
  const key = String(value || '').trim().toLowerCase();
  return THEMES.includes(key) ? key : LEGACY_THEMES[key] || 'copper';
}

export function applyTheme() {
  const settings = S.settings || {};
  document.body.dataset.accent = normalizeTheme(settings.accent);
  document.body.classList.toggle('scanlines', Boolean(settings.scanlines));
  const store = $('#topStore');
  if (store) store.textContent = String(settings.store_name || 'MOSTRADOR POS').toUpperCase();
  document.title = `${settings.store_name || 'Mostrador'} · POS 80 mm`;
  renderPrinterStatus();
}

export function renderPrinterStatus() {
  const el = $('#statusPrinter');
  if (!el) return;
  const method = S.printer?.method || S.settings?.print_method || 'usb';
  if (method === 'browser') {
    el.textContent = 'IMPRESORA: NAVEGADOR / CUPS';
    el.className = 'bad';
    return;
  }
  if (method === 'tcp') {
    el.textContent = `IMPRESORA: RED ${S.settings?.print_host || ''}:${S.settings?.print_port || 9100}`;
    el.className = '';
    return;
  }
  const device = S.printer?.device || S.settings?.print_device || '/dev/usb/lp0';
  const exists = S.printer?.device_exists;
  el.textContent = `IMPRESORA: USB ${device}${exists ? '' : ' · NO DETECTADA'}`;
  el.className = exists ? 'ok' : 'bad';
}

export function updateHeader() {
  const stats = S.stats || {};
  const today = stats.todaySales || {};
  const month = stats.monthSales || {};
  if ($('#topToday')) $('#topToday').textContent = fmtMoney(today.total || 0);
  if ($('#topCount')) $('#topCount').textContent = String(today.count || 0);
  if ($('#topLow')) $('#topLow').textContent = String(stats.lowStock || 0);
  S.lastSale = stats.lastSale || S.lastSale;
  const box = $('#lastSaleBox');
  if (box) {
    const last = S.lastSale;
    if (!last) {
      box.textContent = '—';
    } else {
      box.innerHTML = `<div class="row"><span class="dim">${esc(last.number)}</span><b>${fmtMoney(last.total)}</b></div>
        <div class="row"><span>${fmtDate(last.created_at)}</span><span>${esc(PAY_LABELS[last.payment_method] || '')}</span></div>`;
    }
  }
  const printer = $('#btnReprintLast');
  if (printer) printer.disabled = !S.lastSale;
  const next = $('#nextTicket');
  if (next) next.textContent = S.nextTicket || '—';
  const topStore = $('#topStore');
  if (topStore) topStore.textContent = String(S.settings.store_name || '').toUpperCase();
  const monthEl = $('#salMonth');
  if (monthEl) monthEl.textContent = fmtMoney(month.total || 0);
}

export async function refreshBootstrap() {
  const data = await api('/api/bootstrap');
  S.settings = data.settings || {};
  S.categories = data.categories || [];
  S.units = data.units || [];
  S.stats = data.stats || {};
  S.nextTicket = data.next_ticket || S.nextTicket;
  S.nextQuote = data.next_quote || S.nextQuote;
  S.printer = data.printer || {};
  applyTheme();
  updateHeader();
  return data;
}

/* ---------------- Navegación ---------------- */
const loaders = new Map();
const viewKeys = {
  venta: '<kbd>F2</kbd> Venta <kbd>F4</kbd> Cobrar <kbd>F9</kbd> Reimprimir <kbd>F1</kbd> Ayuda',
  productos: '<kbd>F3</kbd> Nuevo producto <kbd>Enter</kbd> Editar <kbd>F1</kbd> Ayuda',
  inventario: '<kbd>F5</kbd> Inventario <kbd>F3</kbd> Productos <kbd>F11</kbd> Reportes',
  cotizaciones: '<kbd>F7</kbd> Cotizaciones <kbd>Enter</kbd> Imprimir <kbd>F1</kbd> Ayuda',
  ventas: '<kbd>F6</kbd> Ventas <kbd>F9</kbd> Reimprimir <kbd>F11</kbd> Reportes',
  clientes: '<kbd>F8</kbd> Clientes <kbd>Enter</kbd> Editar <kbd>F1</kbd> Ayuda',
  reportes: '<kbd>F11</kbd> Actualizar <kbd>F6</kbd> Ventas',
  config: '<kbd>F10</kbd> Guardar <kbd>F2</kbd> Venta <kbd>F1</kbd> Ayuda'
};

const viewStatus = {
  venta: 'Venta rápida: escanea un código o busca un producto.',
  productos: 'Registro de productos: F3 crea, Enter edita el seleccionado.',
  inventario: 'Inventario: ajusta entradas, salidas y conteos físicos.',
  cotizaciones: 'Cotizaciones: Enter abre el detalle de la seleccionada.',
  ventas: 'Historial de ventas: Enter abre, F9 reimprime.',
  clientes: 'Clientes: Enter edita el cliente seleccionado.',
  reportes: 'Reportes del período seleccionado.',
  config: 'Configuración del negocio y de la impresora.'
};

export function registerView(name, loader) {
  loaders.set(name, loader);
}

export async function switchView(name) {
  if (!loaders.has(name) && !$(`#view-${name}`)) return;
  S.view = name;
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === name));
  setStatusKeys(viewKeys[name] || '');
  setStatus(viewStatus[name] || 'Listo.');
  const loader = loaders.get(name);
  if (loader) {
    try {
      await loader();
    } catch (err) {
      toast(err.message, 'error', 5000);
    }
  }
  if (name === 'venta') setTimeout(() => $('#saleSearch')?.focus(), 30);
}

/* ---------------- Reloj ---------------- */
function tickClock() {
  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${p(now.getDate())}/${p(now.getMonth() + 1)}/${now.getFullYear()}`;
  const time = `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
  if ($('#clockDate')) $('#clockDate').textContent = date;
  if ($('#clockTime')) $('#clockTime').textContent = time;
}

/* ---------------- Ayuda ---------------- */
export function showHelp() {
  openModal({
    title: 'Ayuda · Mostrador POS',
    className: 'wide',
    html: `
      <div class="catalog-grid">
        <div class="catalog-box">
          <h3>Módulos</h3>
          <div style="line-height:2">
            <div><kbd>F2</kbd> Venta / mostrador</div>
            <div><kbd>F3</kbd> Productos y registro</div>
            <div><kbd>F4</kbd> Cobrar el carrito</div>
            <div><kbd>F5</kbd> Inventario y kardex</div>
            <div><kbd>F6</kbd> Historial de ventas</div>
            <div><kbd>F7</kbd> Cotizaciones</div>
            <div><kbd>F8</kbd> Clientes</div>
            <div><kbd>F9</kbd> Reimprimir último ticket</div>
            <div><kbd>F10</kbd> Configuración</div>
            <div><kbd>F11</kbd> Reportes</div>
          </div>
        </div>
        <div class="catalog-box">
          <h3>Venta rápida</h3>
          <div style="line-height:2">
            <div>Escanea el código y <kbd>Enter</kbd> agrega.</div>
            <div>Escribe <b>3 x tornillo</b> para agregar 3 unidades.</div>
            <div><kbd>↑</kbd><kbd>↓</kbd> navegan los resultados.</div>
            <div><kbd>Enter</kbd> agrega el resultado resaltado.</div>
            <div><kbd>Supr</kbd> quita la línea seleccionada.</div>
            <div><kbd>Esc</kbd> cierra búsqueda o modal.</div>
            <div>Puedes editar cantidad, precio y descuento con el ratón.</div>
          </div>
        </div>
        <div class="catalog-box">
          <h3>Ticket 80 mm</h3>
          <div style="line-height:1.8">
            El sistema genera ESC/POS de 48 columnas y codificación CP437.
            La impresión directa usa <b>/dev/usb/lp0</b> en Linux; también puedes
            imprimir desde el navegador o por red TCP 9100. El ancho y los datos
            del negocio se configuran en <kbd>F10</kbd>.
          </div>
        </div>
        <div class="catalog-box">
          <h3>Buenas prácticas</h3>
          <div style="line-height:1.8">
            Registra el costo para ver utilidad real. Usa el stock mínimo para
            recibir alertas. Anula una venta desde <kbd>F6</kbd> si fue un error:
            el inventario se devuelve automáticamente. Descarga respaldos desde
            Configuración.
          </div>
        </div>
      </div>`
  });
}

/* ---------------- Atajos globales ---------------- */
function fire(name, detail = {}) {
  document.dispatchEvent(new CustomEvent(name, { detail }));
}

export function installKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (modalIsOpen()) {
        e.preventDefault();
        closeModal(true);
      }
      return;
    }
    if (modalIsOpen()) return;
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    const map = {
      F1: () => showHelp(),
      F2: () => switchView('venta'),
      F3: () => {
        if (S.view === 'productos') fire('mostrador:new-product');
        else switchView('productos');
      },
      F4: () => {
        if (S.view === 'venta') fire('mostrador:charge');
        else switchView('venta').then(() => fire('mostrador:charge'));
      },
      F5: () => switchView('inventario'),
      F6: () => switchView('ventas'),
      F7: () => switchView('cotizaciones'),
      F8: () => switchView('clientes'),
      F9: () => fire('mostrador:reprint'),
      F10: () => switchView('config'),
      F11: () => {
        if (S.view === 'reportes') fire('mostrador:reports-refresh');
        else switchView('reportes');
      }
    };
    if (map[e.key]) {
      e.preventDefault();
      map[e.key]();
    }
  });
}

/* ---------------- Arranque ---------------- */
export async function boot() {
  installKeyboard();
  tickClock();
  setInterval(tickClock, 1000);
  $$('.tab').forEach((tab) => {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  });
  await refreshBootstrap();
  S.booted = true;
  setStatus('Listo. Escanea un producto o pulsa F1 para ver la ayuda.');
  await switchView('venta');
  fire('mostrador:boot');
}
