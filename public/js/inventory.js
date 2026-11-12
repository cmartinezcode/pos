/* =========================================================
   MOSTRADOR · inventario, ajustes y kardex
   ========================================================= */
import {
  S, $, $$, esc, parseNum, fmtMoney, fmtQty, fmtDate, toast, setStatus, api,
  openModal, refreshBootstrap, updateHeader, stockClass
} from './core.js';

let allProducts = [];
let allMovements = [];
let searchTimer = null;

const MOV_LABELS = {
  inicial: 'Inicial',
  venta: 'Venta',
  anulacion: 'Anulación',
  entrada: 'Entrada',
  salida: 'Salida',
  ajuste: 'Ajuste'
};

async function loadInventory() {
  const q = $('#invSearch')?.value.trim() || '';
  try {
    const [data, movements] = await Promise.all([
      api('/api/products?limit=2000'),
      api(`/api/movements?limit=160&q=${encodeURIComponent(q)}`)
    ]);
    allProducts = Array.isArray(data.items) ? data.items : [];
    allMovements = Array.isArray(movements) ? movements : [];
    renderInventory();
    renderMovements();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function filteredProducts() {
  const q = ($('#invSearch')?.value || '').trim().toLowerCase();
  const lowOnly = $('#invLowOnly')?.checked;
  return allProducts.filter((p) => {
    if (lowOnly && !(Number(p.stock) <= Number(p.min_stock))) return false;
    if (!q) return true;
    return [p.name, p.sku, p.barcode, p.measure, p.material, p.brand, p.category_name, p.location]
      .filter(Boolean).join(' ').toLowerCase().includes(q);
  });
}

function renderInventory() {
  const rows = filteredProducts();
  const body = $('#invBody');
  if (!body) return;
  body.innerHTML = rows.map((p) => {
    const low = Number(p.stock) <= Number(p.min_stock);
    const value = Number(p.stock) * Number(p.cost_price);
    return `<tr>
      <td><span class="code">${esc(p.sku || '—')}</span></td>
      <td class="name-cell"><strong>${esc(p.name)}</strong>
        <small>${esc([p.measure, p.location].filter(Boolean).join(' · ') || 'Sin ubicación')}</small></td>
      <td>${esc(p.category_name || '—')}</td>
      <td class="num ${stockClass(p.stock, p.min_stock)}">${fmtQty(p.stock)} <span class="dim">${esc(p.unit_abbr || '')}</span></td>
      <td class="num">${fmtQty(p.min_stock)}</td>
      <td class="num">${fmtMoney(p.cost_price)}</td>
      <td class="num">${fmtMoney(value)}</td>
      <td>${low ? '<span class="warn">BAJO MÍNIMO</span>' : '<span class="dim">OK</span>'}</td>
      <td class="actions-col"><button type="button" class="btn" data-adjust="${p.id}">Ajustar</button></td>
    </tr>`;
  }).join('');
  if ($('#invEmpty')) $('#invEmpty').hidden = rows.length > 0;

  const refs = allProducts.length;
  const cost = allProducts.reduce((sum, p) => sum + Number(p.stock) * Number(p.cost_price), 0);
  const sale = allProducts.reduce((sum, p) => sum + Number(p.stock) * Number(p.sale_price), 0);
  const low = allProducts.filter((p) => Number(p.stock) <= Number(p.min_stock)).length;
  if ($('#invProducts')) $('#invProducts').textContent = String(refs);
  if ($('#invCost')) $('#invCost').textContent = fmtMoney(cost);
  if ($('#invSale')) $('#invSale').textContent = fmtMoney(sale);
  if ($('#invLow')) $('#invLow').textContent = String(low);
}

function renderMovements() {
  const body = $('#movBody');
  if (!body) return;
  body.innerHTML = allMovements.map((m) => {
    const qty = Number(m.qty);
    const cls = qty < 0 ? 'danger' : qty > 0 ? 'stock-ok' : 'dim';
    return `<tr>
      <td class="dim">${fmtDate(m.created_at)}</td>
      <td>${esc(m.product_name)} <span class="code">${esc(m.sku || '')}</span></td>
      <td>${esc(MOV_LABELS[m.type] || m.type)}</td>
      <td class="num ${cls}">${qty > 0 ? '+' : ''}${fmtQty(qty)} ${esc(m.unit_abbr || '')}</td>
      <td class="num">${fmtQty(m.stock_after)}</td>
      <td class="dim">${esc(m.note || '')}</td>
    </tr>`;
  }).join('');
  if ($('#movEmpty')) $('#movEmpty').hidden = allMovements.length > 0;
}

export async function openAdjustModal(id) {
  let product;
  try {
    product = allProducts.find((p) => p.id === id) || await api(`/api/products/${id}`);
  } catch (err) {
    toast(err.message, 'error');
    return;
  }
  const { close } = openModal({
    title: `Ajustar inventario · ${product.name}`,
    className: 'small',
    html: `
      <div class="kpis" style="grid-template-columns:1fr 1fr;margin-bottom:12px">
        <div class="kpi"><span>Stock actual</span><b>${fmtQty(product.stock)} ${esc(product.unit_abbr || '')}</b></div>
        <div class="kpi"><span>Mínimo</span><b>${fmtQty(product.min_stock)}</b></div>
      </div>
      <form data-adjust-form class="form-grid">
        <label>Tipo de movimiento
          <select name="type">
            <option value="entrada">Entrada / compra</option>
            <option value="salida">Salida / pérdida</option>
            <option value="ajuste">Ajuste por conteo</option>
          </select>
        </label>
        <label><span data-qty-label>Cantidad que entra</span>
          <input name="qty" inputmode="decimal" value="1" autocomplete="off">
        </label>
        <label class="f2">Nota / referencia
          <input name="note" autocomplete="off" placeholder="Ej: compra factura 123, merma...">
        </label>
        <div class="mini-note f2" data-adjust-hint>La entrada suma al stock actual.</div>
        <div class="form-actions f2">
          <button type="button" class="btn" data-adjust-cancel>Cancelar</button>
          <button type="submit" class="btn primary">APLICAR AJUSTE</button>
        </div>
      </form>`,
    onMount(modal, closeFn) {
      const form = $('[data-adjust-form]', modal);
      const qtyLabel = $('[data-qty-label]', modal);
      const hint = $('[data-adjust-hint]', modal);
      const typeEl = form.elements.type;
      const qtyEl = form.elements.qty;
      const updateHint = () => {
        if (typeEl.value === 'entrada') {
          qtyLabel.textContent = 'Cantidad que entra';
          hint.textContent = 'La entrada suma al stock actual.';
        } else if (typeEl.value === 'salida') {
          qtyLabel.textContent = 'Cantidad que sale';
          hint.textContent = 'La salida resta al stock actual.';
        } else {
          qtyLabel.textContent = 'Conteo final real';
          hint.textContent = 'Escribe cuántas unidades contaste físicamente.';
        }
      };
      typeEl.addEventListener('change', updateHint);
      $('[data-adjust-cancel]', modal).addEventListener('click', () => closeFn());
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const type = typeEl.value;
        const qty = parseNum(qtyEl.value);
        if (type !== 'ajuste' && qty <= 0) {
          toast('La cantidad debe ser mayor que cero.', 'warn');
          qtyEl.focus();
          return;
        }
        if (type === 'ajuste' && qty < 0) {
          toast('El conteo no puede ser negativo.', 'warn');
          return;
        }
        const submit = $('button[type="submit"]', form);
        submit.disabled = true;
        submit.textContent = 'APLICANDO...';
        try {
          const result = await api(`/api/products/${id}/adjust`, {
            method: 'POST',
            body: { type, qty, note: form.elements.note.value }
          });
          closeFn();
          toast(`Stock de ${product.name}: ${fmtQty(result.stock_after)} ${product.unit_abbr || ''}.`, 'ok');
          await refreshBootstrap();
          updateHeader();
          await loadInventory();
          setStatus(`Ajuste aplicado a ${product.name}.`);
        } catch (err) {
          toast(err.message, 'error', 6000);
          submit.disabled = false;
          submit.textContent = 'APLICAR AJUSTE';
        }
      });
      setTimeout(() => { qtyEl.focus(); qtyEl.select(); }, 40);
    }
  });
  return close;
}

export function initInventory() {
  const search = $('#invSearch');
  search?.addEventListener('input', () => {
    renderInventory();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
      const q = search.value.trim();
      try {
        allMovements = await api(`/api/movements?limit=160&q=${encodeURIComponent(q)}`);
        renderMovements();
      } catch { /* ignorar */ }
    }, 180);
  });
  $('#invLowOnly')?.addEventListener('change', renderInventory);
  $('#btnInvRefresh')?.addEventListener('click', loadInventory);
  $('#invBody')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-adjust]');
    if (btn) openAdjustModal(Number(btn.dataset.adjust));
  });
  document.addEventListener('mostrador:adjust-product', (e) => {
    if (e.detail?.id) openAdjustModal(Number(e.detail.id));
  });
}

export async function loadInventoryView() {
  await loadInventory();
  setTimeout(() => $('#invSearch')?.focus(), 30);
}

export { loadInventory };
