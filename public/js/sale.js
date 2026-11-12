/* =========================================================
   MOSTRADOR · venta rápida, carrito, cobro y cotizaciones
   ========================================================= */
import {
  S, $, $$, esc, parseNum, round2, fmtMoney, fmtQty, fmtDate,
  toast, setStatus, api, openModal, closeModal, confirmDialog, formDialog,
  showReceipt, printServer, browserPrint, refreshBootstrap, updateHeader,
  switchView, stockClass
} from './core.js';

const CART_KEY = 'mostrador.cart.v1';

let cart = [];
let cartMode = 'sale';
let customer = null;
let editingQuote = null;
let discount = 0;
let results = [];
let resultsQuery = '';
let resultIndex = -1;
let searchQty = 1;
let searchSeq = 0;
let searchTimer = null;
let selectedLine = -1;

/* ---------------- Carrito ---------------- */
function calcTotals() {
  const include = S.settings.prices_include_tax !== false;
  let gross = 0;
  let base = 0;
  let tax = 0;
  const lines = cart.map((it) => {
    const lineGross = round2(Math.max(0, Number(it.qty) * Number(it.unit_price) - Number(it.discount || 0)));
    const rate = Number(it.tax_rate) || 0;
    let lineBase;
    let lineTax;
    let lineTotal;
    if (include) {
      lineBase = round2(lineGross / (1 + rate / 100));
      lineTax = round2(lineGross - lineBase);
      lineTotal = lineGross;
    } else {
      lineBase = lineGross;
      lineTax = round2(lineGross * (rate / 100));
      lineTotal = round2(lineBase + lineTax);
    }
    gross = round2(gross + lineTotal);
    base = round2(base + lineBase);
    tax = round2(tax + lineTax);
    return { ...it, line_total: lineTotal, line_base: lineBase, line_tax: lineTax };
  });
  const rawDiscount = Math.max(0, Number(discount) || 0);
  const applied = round2(Math.min(rawDiscount, gross));
  const total = round2(gross - applied);
  const ratio = gross > 0 ? total / gross : 0;
  const adjustedBase = round2(base * ratio);
  return {
    lines,
    gross,
    base: adjustedBase,
    tax: round2(total - adjustedBase),
    discount: applied,
    total
  };
}

export function saveCartState() {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify({
      cart,
      cartMode,
      customer,
      editingQuote,
      discount,
      saved_at: new Date().toISOString()
    }));
  } catch { /* almacenamiento no disponible */ }
}

function restoreCartState() {
  try {
    const raw = localStorage.getItem(CART_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!data || !Array.isArray(data.cart) || !data.cart.length) return false;
    cart = data.cart.filter((it) => it && it.name && Number(it.qty) > 0);
    if (!cart.length) return false;
    cartMode = data.cartMode === 'quote' ? 'quote' : 'sale';
    customer = data.customer || null;
    editingQuote = data.editingQuote || null;
    discount = Number(data.discount) || 0;
    return true;
  } catch {
    return false;
  }
}

export function resetSaleState({ keepCustomer = false } = {}) {
  cart = [];
  cartMode = 'sale';
  editingQuote = null;
  discount = 0;
  selectedLine = -1;
  if (!keepCustomer) customer = null;
  saveCartState();
  renderCart();
}

function cartBaseQty(productId, presentationId = null) {
  return cart
    .filter((it) => it.product_id === productId && (it.presentation_id || null) === (presentationId || null))
    .reduce((sum, it) => sum + Number(it.qty) * Number(it.factor || 1), 0);
}

function addResult(result, qty = searchQty) {
  if (!result || result.disabled) {
    toast('Producto sin stock disponible.', 'warn');
    return;
  }
  const amount = Math.max(0.001, Number(qty) || 1);
  const factor = Number(result.factor) || 1;
  const needed = amount * factor;
  if (S.settings.allow_negative_stock === false) {
    const already = cartBaseQty(result.product_id, result.presentation_id);
    if (already + needed > Number(result.stock) + 0.0001) {
      toast(`Stock insuficiente: disponible ${fmtQty(Number(result.stock) - already)} ${result.unit_label || 'UND'}.`, 'warn', 4200);
      return;
    }
  }
  const existing = cart.find(
    (it) =>
      it.product_id === result.product_id &&
      (it.presentation_id || null) === (result.presentation_id || null) &&
      Math.abs(Number(it.unit_price) - Number(result.price)) < 0.001
  );
  if (existing) {
    existing.qty = round2(Number(existing.qty) + amount);
  } else {
    cart.push({
      key: `${result.key}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
      kind: result.kind,
      product_id: result.product_id,
      presentation_id: result.presentation_id || null,
      presentation_label: result.presentation_label || '',
      name: result.name,
      code: result.sku || '',
      barcode: result.barcode || '',
      measure: result.measure || '',
      category_name: result.category_name || '',
      material: result.material || '',
      unit_label: result.unit_label || 'UND',
      factor,
      qty: round2(amount),
      unit_price: round2(Number(result.price) || 0),
      discount: 0,
      tax_rate: Number(result.tax_rate) || 0,
      stock: Number(result.stock) || 0
    });
  }
  selectedLine = cart.length - 1;
  discount = Math.min(discount, calcTotals().gross);
  renderCart();
  const line = cart[selectedLine];
  setStatus(`+ ${fmtQty(amount)} ${line.unit_label} · ${line.name}${line.presentation_label ? ` (${line.presentation_label})` : ''}`);
  saveCartState();
}

/* ---------------- Búsqueda ---------------- */
function parseSearchInput(raw) {
  const value = String(raw || '');
  const m = value.match(/^\s*(\d+(?:[.,]\d+)?)\s*(?:x|\*)\s+(.+)$/i);
  if (m) return { qty: Math.max(0.001, parseNum(m[1])), q: m[2].trim() };
  return { qty: 1, q: value.trim() };
}

function updateSearchQtyBadge() {
  const badge = $('#searchQty');
  if (!badge) return;
  badge.hidden = !(searchQty > 1);
  badge.textContent = `× ${fmtQty(searchQty)}`;
}

async function runSearch() {
  const input = $('#saleSearch');
  if (!input) return;
  const parsed = parseSearchInput(input.value);
  searchQty = parsed.qty;
  updateSearchQtyBadge();
  const seq = ++searchSeq;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(parsed.q)}`);
    if (seq !== searchSeq) return;
    results = Array.isArray(data) ? data : [];
    resultsQuery = parsed.q;
    resultIndex = results.length ? 0 : -1;
    renderResults(parsed.q);
  } catch (err) {
    if (seq !== searchSeq) return;
    results = [];
    resultIndex = -1;
    renderResults(parsed.q, err.message);
  }
}

function renderResults(query = '', error = '') {
  const box = $('#saleResults');
  if (!box) return;
  if (error) {
    box.innerHTML = `<div class="empty-state" style="padding:18px">${esc(error)}</div>`;
    box.hidden = false;
    return;
  }
  if (!results.length) {
    box.innerHTML = `<div class="result disabled" style="grid-template-columns:1fr auto">
      <div><strong>Sin coincidencias${query ? ` para “${esc(query)}”` : ''}.</strong>
      <small class="dim">Puedes crearlo como producto nuevo.</small></div>
      <button type="button" class="btn tiny" data-create-product>+ Crear producto</button>
    </div>`;
    box.hidden = false;
    return;
  }
  box.innerHTML = results.map((r, i) => {
    const isPres = r.kind === 'presentation';
    const stockText = isPres
      ? `${fmtQty(r.factor)} UND`
      : `${fmtQty(r.stock)} ${r.unit_label || 'UND'}`;
    return `<button type="button" class="result ${i === resultIndex ? 'sel' : ''} ${r.disabled ? 'disabled' : ''}" data-result="${i}">
      <span class="r-code">${esc(r.sku || r.barcode || '—')}</span>
      <span class="r-name">
        <strong>${esc(r.name)}${isPres ? ` <span class="tag">${esc(r.presentation_label)}</span>` : ''}</strong>
        <small>${esc([r.category_name, r.measure, r.material, r.brand].filter(Boolean).join(' · ') || 'Sin detalle')}</small>
      </span>
      <span class="r-stock">${stockText}</span>
      <span class="r-price">${fmtMoney(r.price)}</span>
      <span class="r-add">+</span>
    </button>`;
  }).join('');
  box.hidden = false;
  const sel = $('.result.sel', box);
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

function hideResults() {
  const box = $('#saleResults');
  if (box) {
    box.hidden = true;
    box.innerHTML = '';
  }
  resultIndex = -1;
}

async function submitCurrentSearch() {
  const input = $('#saleSearch');
  if (!input) return;
  const raw = input.value.trim();
  if (!raw) return;
  const parsed = parseSearchInput(raw);
  searchQty = parsed.qty;
  updateSearchQtyBadge();
  let chosen = null;
  if (results.length && resultsQuery === parsed.q && resultIndex >= 0) {
    chosen = results[resultIndex];
  } else {
    const seq = ++searchSeq;
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(parsed.q)}`);
      if (seq !== searchSeq) return;
      results = Array.isArray(data) ? data : [];
      resultsQuery = parsed.q;
      resultIndex = results.length ? 0 : -1;
      const lower = parsed.q.toLowerCase();
      chosen = results.find((r) => r.barcode === parsed.q || String(r.sku || '').toLowerCase() === lower) || results[0] || null;
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }
  if (chosen) {
    addResult(chosen);
  } else {
    toast(`No se encontró “${parsed.q}”.`, 'warn');
  }
  input.value = '';
  searchQty = 1;
  updateSearchQtyBadge();
  hideResults();
  input.focus();
}

function selectResult(delta) {
  if (!results.length) return;
  resultIndex = (resultIndex + delta + results.length) % results.length;
  $$('#saleResults .result').forEach((el, i) => el.classList.toggle('sel', i === resultIndex));
  const sel = $('#saleResults .result.sel');
  if (sel) sel.scrollIntoView({ block: 'nearest' });
}

/* ---------------- Render del carrito ---------------- */
function metaFor(it) {
  return [
    it.code,
    it.presentation_label,
    it.measure,
    it.category_name
  ].filter(Boolean).join(' · ');
}

export function renderCart() {
  const body = $('#cartBody');
  if (!body) return;
  const totals = calcTotals();
  const empty = cart.length === 0;
  const emptyEl = $('#cartEmpty');
  if (emptyEl) emptyEl.hidden = !empty;
  const table = $('.cart-table');
  if (table) table.style.display = empty ? 'none' : '';

  body.innerHTML = totals.lines.map((it, i) => `
    <tr data-line="${i}" class="${i === selectedLine ? 'selected' : ''}">
      <td class="w-idx">${i + 1}</td>
      <td>
        <div class="p-name">${esc(it.name)}</div>
        <div class="p-meta">${esc(metaFor(it) || '—')}</div>
      </td>
      <td class="num">
        <div class="stepper">
          <button type="button" data-dec="${i}" tabindex="-1" aria-label="Restar">−</button>
          <input data-qty="${i}" value="${fmtQty(it.qty)}" inputmode="decimal" aria-label="Cantidad">
          <button type="button" data-inc="${i}" tabindex="-1" aria-label="Sumar">+</button>
        </div>
      </td>
      <td class="num"><input class="cell-input" data-price="${i}" value="${Number(it.unit_price).toFixed(2)}" inputmode="decimal" aria-label="Precio"></td>
      <td class="num"><input class="cell-input" data-disc="${i}" value="${Number(it.discount || 0).toFixed(2)}" inputmode="decimal" aria-label="Descuento"></td>
      <td class="num total-cell" data-line-total="${i}">${fmtMoney(it.line_total)}</td>
      <td><button type="button" class="icon-btn" data-del="${i}" title="Quitar línea">×</button></td>
    </tr>`).join('');

  if ($('#cartCount')) $('#cartCount').textContent = `${cart.length} ${cart.length === 1 ? 'ítem' : 'ítems'}`;
  if ($('#cartCustomer')) $('#cartCustomer').textContent = customer?.name || 'Consumidor final';
  if ($('#tSubtotal')) $('#tSubtotal').textContent = fmtMoney(totals.base);
  if ($('#tTax')) $('#tTax').textContent = fmtMoney(totals.tax);
  if ($('#tTotal')) $('#tTotal').textContent = fmtMoney(totals.total);
  const discountInput = $('#tDiscount');
  if (discountInput && document.activeElement !== discountInput) discountInput.value = fmtQty(Number(discount) || 0);

  const modeBadge = $('#cartMode');
  if (modeBadge) {
    modeBadge.textContent = cartMode === 'quote' ? 'COTIZACIÓN' : 'VENTA';
    modeBadge.classList.toggle('quote', cartMode === 'quote');
  }
  const banner = $('#quoteBanner');
  if (banner) banner.hidden = cartMode !== 'quote';
  if ($('#quoteBannerNum')) {
    $('#quoteBannerNum').textContent = editingQuote?.number || S.nextQuote || 'COT-000001';
  }
  if ($('#nextTicket')) {
    $('#nextTicket').textContent = cartMode === 'quote'
      ? (editingQuote?.number || S.nextQuote || 'COT-000001')
      : (S.nextTicket || 'T-000001');
  }
  const charge = $('#btnCharge');
  if (charge) {
    charge.disabled = empty;
    charge.innerHTML = cartMode === 'quote'
      ? `GUARDAR COTIZACIÓN <kbd>F4</kbd>`
      : `COBRAR <kbd>F4</kbd>`;
  }
  const hint = $('#saleHint');
  if (hint) {
    hint.textContent = empty
      ? 'Lector de barras listo.'
      : cartMode === 'quote'
        ? `${cart.length} ítem(s) · se guarda sin afectar inventario.`
        : `${cart.length} ítem(s) · cobra con F4.`;
  }
  saveCartState();
}

function updateTotalsOnly() {
  const totals = calcTotals();
  if ($('#tSubtotal')) $('#tSubtotal').textContent = fmtMoney(totals.base);
  if ($('#tTax')) $('#tTax').textContent = fmtMoney(totals.tax);
  if ($('#tTotal')) $('#tTotal').textContent = fmtMoney(totals.total);
  totals.lines.forEach((it, i) => {
    const cell = $(`[data-line-total="${i}"]`);
    if (cell) cell.textContent = fmtMoney(it.line_total);
  });
  saveCartState();
}

function commitLine(index, { rerender = false, removeZero = false } = {}) {
  const it = cart[index];
  if (!it) return;
  const row = $(`tr[data-line="${index}"]`);
  if (!row) return;
  const qtyEl = $('[data-qty]', row);
  const priceEl = $('[data-price]', row);
  const discEl = $('[data-disc]', row);
  const qty = parseNum(qtyEl?.value);
  const price = parseNum(priceEl?.value);
  const lineDiscount = parseNum(discEl?.value);
  if (qty <= 0) {
    if (removeZero) {
      cart.splice(index, 1);
      selectedLine = Math.min(selectedLine, cart.length - 1);
      renderCart();
      return;
    }
    it.qty = 0;
  } else {
    it.qty = round2(qty);
  }
  it.unit_price = round2(Math.max(0, price));
  it.discount = round2(Math.max(0, lineDiscount));
  if (rerender) renderCart();
  else updateTotalsOnly();
}

function changeQty(index, delta) {
  const it = cart[index];
  if (!it) return;
  it.qty = round2(Math.max(0.001, Number(it.qty) + delta));
  selectedLine = index;
  renderCart();
}

function removeLine(index) {
  cart.splice(index, 1);
  selectedLine = Math.min(selectedLine, cart.length - 1);
  renderCart();
}

/* ---------------- Clientes de la venta ---------------- */
async function openCustomerPicker() {
  let search = '';
  const { close } = openModal({
    title: 'Seleccionar cliente',
    className: 'small',
    html: `<div class="catalog-add" style="margin-bottom:8px">
        <input id="custPickSearch" placeholder="Buscar nombre, documento o teléfono..." autocomplete="off">
        <button type="button" class="btn tiny" id="custPickNew">+ Nuevo</button>
      </div>
      <div id="custPickList" class="catalog-list" style="max-height:340px"></div>
      <div class="form-actions">
        <button type="button" class="btn" id="custPickFinal">Consumidor final</button>
        <button type="button" class="btn" id="custPickClose">Cerrar</button>
      </div>`,
    onMount(modal, closeFn) {
      const list = $('#custPickList', modal);
      const input = $('#custPickSearch', modal);
      const load = async () => {
        list.innerHTML = '<div class="empty-state" style="padding:20px">Cargando...</div>';
        try {
          const data = await api(`/api/customers?q=${encodeURIComponent(search)}&limit=100`);
          const rows = Array.isArray(data) ? data : [];
          list.innerHTML = rows.length
            ? rows.map((c) => `<button type="button" class="catalog-row" data-cust="${c.id}"
                style="width:100%;background:none;border-left:0;border-right:0;border-top:0;text-align:left">
                <span class="name"><b>${esc(c.name)}</b>${c.doc ? ` · ${esc(c.doc)}` : ''}${c.phone ? ` · ${esc(c.phone)}` : ''}</span>
              </button>`).join('')
            : '<div class="empty-state" style="padding:20px">Sin clientes.</div>';
        } catch (err) {
          list.innerHTML = `<div class="empty-state" style="padding:20px">${esc(err.message)}</div>`;
        }
      };
      let timer = null;
      input.addEventListener('input', () => {
        search = input.value;
        clearTimeout(timer);
        timer = setTimeout(load, 140);
      });
      list.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cust]');
        if (!btn) return;
        const id = Number(btn.dataset.cust);
        api(`/api/customers?limit=500`).then((all) => {
          const found = (Array.isArray(all) ? all : []).find((c) => c.id === id);
          if (found) setCustomer(found);
          closeFn();
        }).catch((err) => toast(err.message, 'error'));
      });
      $('#custPickFinal', modal).addEventListener('click', () => {
        setCustomer(null);
        closeFn();
      });
      $('#custPickClose', modal).addEventListener('click', () => closeFn());
      $('#custPickNew', modal).addEventListener('click', async () => {
        const out = await formDialog({
          title: 'Nuevo cliente rápido',
          fields: [
            { name: 'name', label: 'Nombre', required: true },
            { name: 'doc', label: 'Documento' },
            { name: 'phone', label: 'Teléfono' }
          ],
          submitLabel: 'Crear cliente'
        });
        if (!out?.name?.trim()) return;
        try {
          const created = await api('/api/customers', { method: 'POST', body: out });
          setCustomer(created);
          closeFn();
          toast(`Cliente ${created.name} listo.`);
        } catch (err) {
          toast(err.message, 'error');
        }
      });
      load();
      setTimeout(() => input.focus(), 40);
    }
  });
  return close;
}

function setCustomer(c) {
  customer = c ? { id: c.id, name: c.name } : null;
  renderCart();
  if (c) setStatus(`Cliente: ${c.name}`);
}

/* ---------------- Cobro ---------------- */
function quickCashValues(total) {
  const t = round2(total);
  const raw = [t, Math.ceil(t / 1000) * 1000, Math.ceil(t / 5000) * 5000, Math.ceil(t / 10000) * 10000, Math.ceil(t / 50000) * 50000, Math.ceil(t / 100000) * 100000];
  const values = [...new Set(raw.filter((v) => v >= t - 0.001 && v > 0))].slice(0, 5);
  return values;
}

export function openPaymentModal({ mode = 'sale', quote = null, onDone = null } = {}) {
  if (mode === 'sale') {
    if (!cart.length) {
      toast('El carrito está vacío.', 'warn');
      return;
    }
    if (cartMode === 'quote') {
      saveQuoteNow();
      return;
    }
  }
  const totals = mode === 'sale' ? calcTotals() : null;
  const total = mode === 'sale' ? totals.total : round2(Number(quote?.total) || 0);
  if (mode === 'sale' && discount > totals.gross + 0.001) {
    toast('El descuento supera el total de la venta.', 'error');
    return;
  }
  let method = 'efectivo';
  const title = mode === 'convert' ? `Cobrar ${quote.number}` : 'Cobrar venta';

  const { close } = openModal({
    title,
    className: 'small',
    html: `
      <div class="pay-total">${fmtMoney(total)}</div>
      <div class="pay-methods">
        ${['efectivo', 'tarjeta', 'transferencia', 'credito'].map((m) =>
          `<button type="button" class="pay-method ${m === method ? 'active' : ''}" data-pay="${m}">${esc(
            { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', credito: 'Crédito' }[m]
          )}</button>`).join('')}
      </div>
      <div class="pay-grid">
        <div>
          <label class="pay-field" data-received-wrap>Recibido
            <input id="payReceived" inputmode="decimal" value="${total.toFixed(2)}" autocomplete="off">
          </label>
          <div class="quick-cash" data-quick-cash>
            ${quickCashValues(total).map((v) => `<button type="button" class="btn tiny" data-cash="${v}">${fmtMoney(v)}</button>`).join('')}
          </div>
        </div>
        <div>
          <div class="pay-change">Cambio <b id="payChange">${fmtMoney(0)}</b></div>
          <label class="check" style="margin-top:12px">
            <input type="checkbox" id="payPrint" ${S.settings.auto_print !== false ? 'checked' : ''}>
            Imprimir ticket al cobrar
          </label>
          <div class="pay-note" id="payNote">${mode === 'convert'
            ? `Convierte la cotización en venta y descuenta inventario.`
            : `${cart.length} ítem(s) · ${customer?.name || 'Consumidor final'}`}</div>
        </div>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" data-pay-cancel>Cancelar</button>
        <button type="button" class="btn primary xl" data-pay-confirm style="margin:0;min-height:42px;font-size:14px">
          ${mode === 'convert' ? 'CONVERTIR Y COBRAR' : 'CONFIRMAR COBRO'}
        </button>
      </div>`,
    onMount(modal, closeFn) {
      const receivedEl = $('#payReceived', modal);
      const changeEl = $('#payChange', modal);
      const quick = $('[data-quick-cash]', modal);
      const receivedWrap = $('[data-received-wrap]', modal);
      const updateChange = () => {
        const received = method === 'efectivo' ? parseNum(receivedEl.value) : total;
        changeEl.textContent = fmtMoney(Math.max(0, round2(received - total)));
      };
      const setMethod = (next) => {
        method = next;
        $$('.pay-method', modal).forEach((b) => b.classList.toggle('active', b.dataset.pay === method));
        const cash = method === 'efectivo';
        receivedWrap.style.display = cash ? '' : 'none';
        quick.style.display = cash ? '' : 'none';
        receivedEl.disabled = !cash;
        if (!cash) {
          receivedEl.value = total.toFixed(2);
          changeEl.textContent = fmtMoney(0);
        }
        updateChange();
      };
      $$('.pay-method', modal).forEach((b) => b.addEventListener('click', () => setMethod(b.dataset.pay)));
      receivedEl.addEventListener('input', updateChange);
      receivedEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          $('[data-pay-confirm]', modal)?.click();
        }
      });
      quick.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-cash]');
        if (!btn) return;
        receivedEl.value = Number(btn.dataset.cash).toFixed(2);
        updateChange();
      });
      $('[data-pay-cancel]', modal).addEventListener('click', () => closeFn());
      const confirm = $('[data-pay-confirm]', modal);
      confirm.addEventListener('click', async () => {
        const cash = method === 'efectivo';
        const received = cash ? parseNum(receivedEl.value) : total;
        if (cash && received + 0.001 < total) {
          toast('El efectivo recibido es menor que el total.', 'warn');
          receivedEl.focus();
          receivedEl.select();
          return;
        }
        confirm.disabled = true;
        confirm.textContent = 'PROCESANDO...';
        try {
          let result;
          if (mode === 'convert') {
            result = await api(`/api/quotes/${quote.id}/convert`, {
              method: 'POST',
              body: { payment_method: method, received }
            });
          } else {
            result = await api('/api/sales', {
              method: 'POST',
              body: {
                items: cart.map((it) => ({
                  product_id: it.product_id,
                  presentation_id: it.presentation_id || null,
                  qty: it.qty,
                  unit_price: it.unit_price,
                  discount: it.discount || 0
                })),
                discount: totals.discount,
                customer_id: customer?.id || null,
                customer_name: customer?.name || 'Consumidor final',
                payment_method: method,
                received
              }
            });
          }
          const print = $('#payPrint', modal)?.checked;
          closeFn();
          if (mode === 'sale') resetSaleState();
          await refreshBootstrap();
          updateHeader();
          const sale = mode === 'convert' ? result.sale : result;
          showReceipt({
            text: result.receipt,
            saleId: sale.id,
            title: `Ticket ${sale.number}`
          });
          if (onDone) onDone(result);
          if (print) {
            if ((S.settings.print_method || 'usb') === 'browser') {
              browserPrint(result.receipt);
            } else {
              try {
                await printServer({ sale_id: sale.id });
                toast('Ticket enviado a la impresora.', 'ok');
              } catch (err) {
                toast(`Venta guardada, pero no se imprimió: ${err.message}`, 'warn', 6000);
              }
            }
          }
          toast(`Venta ${sale.number} registrada por ${fmtMoney(sale.total)}.`, 'ok');
        } catch (err) {
          toast(err.message, 'error', 6000);
          confirm.disabled = false;
          confirm.textContent = mode === 'convert' ? 'CONVERTIR Y COBRAR' : 'CONFIRMAR COBRO';
        }
      });
      setTimeout(() => {
        receivedEl.focus();
        receivedEl.select();
      }, 40);
    }
  });
  return close;
}

/* ---------------- Cotizaciones desde la venta ---------------- */
export function startNewQuote() {
  resetSaleState();
  cartMode = 'quote';
  editingQuote = null;
  renderCart();
  switchView('venta');
  setStatus('Nueva cotización. Agrega productos y guarda con F4.');
}

export async function editQuote(id) {
  try {
    const quote = await api(`/api/quotes/${id}`);
    cart = (quote.items || []).map((it, index) => ({
      key: `q-${it.id || index}-${Date.now()}`,
      kind: it.presentation_id ? 'presentation' : 'product',
      product_id: it.product_id,
      presentation_id: it.presentation_id || null,
      presentation_label: Number(it.factor) > 1 ? (it.unit_label === 'CAJA' ? `Caja x ${fmtQty(it.factor)}` : `Presentación x ${fmtQty(it.factor)}`) : '',
      name: it.name,
      code: it.code || '',
      measure: it.measure || '',
      category_name: '',
      material: '',
      unit_label: it.unit_label || 'UND',
      factor: Number(it.factor) || 1,
      qty: Number(it.qty),
      unit_price: Number(it.unit_price),
      discount: Number(it.discount) || 0,
      tax_rate: Number(it.tax_rate) || 0,
      stock: 999999
    }));
    cartMode = 'quote';
    editingQuote = { id: quote.id, number: quote.number };
    customer = quote.customer_id ? { id: quote.customer_id, name: quote.customer_name } : null;
    discount = Number(quote.discount) || 0;
    selectedLine = -1;
    renderCart();
    await switchView('venta');
    setStatus(`Editando ${quote.number}. F4 guarda los cambios.`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function saveQuoteNow() {
  if (!cart.length) {
    toast('Agrega productos antes de guardar la cotización.', 'warn');
    return;
  }
  const totals = calcTotals();
  if (discount > totals.gross + 0.001) {
    toast('El descuento supera el total de la cotización.', 'error');
    return;
  }
  const body = {
    items: cart.map((it) => ({
      product_id: it.product_id,
      presentation_id: it.presentation_id || null,
      qty: it.qty,
      unit_price: it.unit_price,
      discount: it.discount || 0
    })),
    discount: totals.discount,
    customer_id: customer?.id || null,
    customer_name: customer?.name || 'Cliente'
  };
  const wasEditing = Boolean(editingQuote?.id);
  try {
    setStatus('Guardando cotización...');
    const result = wasEditing
      ? await api(`/api/quotes/${editingQuote.id}`, { method: 'PUT', body })
      : await api('/api/quotes', { method: 'POST', body });
    resetSaleState();
    await refreshBootstrap();
    updateHeader();
    showReceipt({ text: result.receipt, quoteId: result.id, title: `Cotización ${result.number}` });
    toast(`Cotización ${result.number} ${wasEditing ? 'actualizada' : 'creada'}.`, 'ok');
  } catch (err) {
    toast(err.message, 'error', 6000);
    setStatus('No se pudo guardar la cotización.');
  }
}

/* ---------------- Reimpresión ---------------- */
export async function reprintSale(id) {
  const saleId = id || S.lastSale?.id;
  if (!saleId) {
    toast('Todavía no hay una venta para reimprimir.', 'warn');
    return;
  }
  try {
    const data = await api(`/api/sales/${saleId}/receipt`);
    const sale = await api(`/api/sales/${saleId}`);
    showReceipt({ text: data.text, saleId, title: `Ticket ${sale.number}` });
  } catch (err) {
    toast(err.message, 'error');
  }
}

export async function printQuoteById(id) {
  try {
    const data = await api(`/api/quotes/${id}/receipt`);
    const quote = await api(`/api/quotes/${id}`);
    showReceipt({ text: data.text, quoteId: id, title: `Cotización ${quote.number}` });
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* ---------------- Eventos ---------------- */
export function initSale() {
  const search = $('#saleSearch');
  if (!search) return;

  search.addEventListener('focus', () => {
    if (!results.length) runSearch();
  });
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const parsed = parseSearchInput(search.value);
    searchQty = parsed.qty;
    updateSearchQtyBadge();
    searchTimer = setTimeout(runSearch, 110);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if ($('#saleResults')?.hidden) runSearch();
      else selectResult(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectResult(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submitCurrentSearch();
    } else if (e.key === 'Escape') {
      hideResults();
      search.blur();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!(e.target instanceof Element)) return;
    if (!e.target.closest('.searchbar') && !e.target.closest('#saleResults')) {
      if (!$('#saleResults')?.hidden) hideResults();
    }
  });

  const resultsBox = $('#saleResults');
  resultsBox?.addEventListener('click', (e) => {
    const create = e.target.closest('[data-create-product]');
    if (create) {
      const parsed = parseSearchInput(search.value);
      hideResults();
      switchView('productos').then(() => {
        document.dispatchEvent(new CustomEvent('mostrador:new-product', { detail: { name: parsed.q } }));
      });
      return;
    }
    const btn = e.target.closest('[data-result]');
    if (!btn) return;
    const item = results[Number(btn.dataset.result)];
    addResult(item);
    search.value = '';
    searchQty = 1;
    updateSearchQtyBadge();
    hideResults();
    search.focus();
  });

  const cartBody = $('#cartBody');
  cartBody?.addEventListener('click', (e) => {
    const inc = e.target.closest('[data-inc]');
    const dec = e.target.closest('[data-dec]');
    const del = e.target.closest('[data-del]');
    if (inc) { e.preventDefault(); changeQty(Number(inc.dataset.inc), 1); return; }
    if (dec) { e.preventDefault(); changeQty(Number(dec.dataset.dec), -1); return; }
    if (del) { e.preventDefault(); removeLine(Number(del.dataset.del)); return; }
    const row = e.target.closest('tr[data-line]');
    if (row) {
      selectedLine = Number(row.dataset.line);
      $$('#cartBody tr').forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.line) === selectedLine));
    }
  });
  cartBody?.addEventListener('change', (e) => {
    const row = e.target.closest('tr[data-line]');
    if (!row) return;
    const index = Number(row.dataset.line);
    if (e.target.matches('[data-qty]')) commitLine(index, { rerender: true, removeZero: true });
    else if (e.target.matches('[data-price]') || e.target.matches('[data-disc]')) commitLine(index, { rerender: true });
  });
  cartBody?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.matches('input')) {
      e.preventDefault();
      e.target.blur();
      const row = e.target.closest('tr[data-line]');
      if (row) commitLine(Number(row.dataset.line), { rerender: true, removeZero: true });
    }
  });
  cartBody?.addEventListener('input', (e) => {
    const row = e.target.closest('tr[data-line]');
    if (!row) return;
    if (e.target.matches('[data-qty],[data-price],[data-disc]')) {
      const idx = Number(row.dataset.line);
      const it = cart[idx];
      if (!it) return;
      if (e.target.matches('[data-qty]')) it.qty = parseNum(e.target.value);
      if (e.target.matches('[data-price]')) it.unit_price = Math.max(0, parseNum(e.target.value));
      if (e.target.matches('[data-disc]')) it.discount = Math.max(0, parseNum(e.target.value));
      updateTotalsOnly();
    }
  });

  $('#tDiscount')?.addEventListener('input', (e) => {
    discount = Math.max(0, parseNum(e.target.value));
    updateTotalsOnly();
  });
  $('#tDiscount')?.addEventListener('change', () => {
    const totals = calcTotals();
    if (discount > totals.gross) {
      discount = totals.gross;
      $('#tDiscount').value = fmtQty(discount);
      updateTotalsOnly();
    }
  });

  $('#btnCharge')?.addEventListener('click', () => openPaymentModal({ mode: 'sale' }));
  $('#btnPickCustomer')?.addEventListener('click', openCustomerPicker);
  $('#btnCancelQuote')?.addEventListener('click', () => {
    confirmDialog('¿Cancelar esta cotización y volver a una venta normal?', { title: 'Cancelar cotización', danger: true })
      .then((ok) => { if (ok) resetSaleState(); });
  });
  $('#btnClearCart')?.addEventListener('click', async () => {
    if (!cart.length) return;
    const ok = await confirmDialog('¿Vaciar el carrito actual?', { title: 'Vaciar carrito', danger: true });
    if (ok) resetSaleState({ keepCustomer: true });
  });
  $('#btnReprintLast')?.addEventListener('click', () => reprintSale());

  document.addEventListener('mostrador:charge', () => {
    if (S.view !== 'venta') return;
    if (cartMode === 'quote') saveQuoteNow();
    else openPaymentModal({ mode: 'sale' });
  });
  document.addEventListener('mostrador:reprint', () => {
    if (S.view === 'venta' || S.view === 'ventas') reprintSale();
  });
  document.addEventListener('mostrador:quote-new', startNewQuote);
  document.addEventListener('mostrador:quote-edit', (e) => editQuote(e.detail?.id));

  document.addEventListener('keydown', (e) => {
    if (S.view !== 'venta' || e.ctrlKey || e.altKey || e.metaKey) return;
    const inField = e.target instanceof Element && e.target.matches('input,select,textarea');
    if (e.key === 'Delete' && selectedLine >= 0 && !inField) {
      removeLine(selectedLine);
      e.preventDefault();
    } else if ((e.key === '+' || e.key === '=') && selectedLine >= 0 && !inField) {
      changeQty(selectedLine, 1);
      e.preventDefault();
    } else if (e.key === '-' && selectedLine >= 0 && !inField) {
      changeQty(selectedLine, -1);
      e.preventDefault();
    }
  });

  document.addEventListener('mostrador:boot', () => {
    const restored = restoreCartState();
    renderCart();
    if (restored) {
      setStatus(`Carrito recuperado: ${cart.length} ítem(s).`);
      toast('Se recuperó el carrito de la última sesión.', 'info');
    }
    setTimeout(() => search.focus(), 60);
  });
}
