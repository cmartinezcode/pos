/* =========================================================
   MOSTRADOR · productos, categorías y unidades
   ========================================================= */
import {
  S, $, $$, esc, parseNum, fmtMoney, fmtQty, toast, setStatus, api,
  openModal, confirmDialog, formDialog, refreshBootstrap, updateHeader, switchView
} from './core.js';

let products = [];
let selected = -1;
let searchTimer = null;

async function loadProducts() {
  const q = $('#prodSearch')?.value.trim() || '';
  try {
    const data = await api(`/api/products?q=${encodeURIComponent(q)}&limit=1200`);
    products = Array.isArray(data.items) ? data.items : [];
    if (selected >= products.length) selected = -1;
    renderProducts();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderProducts() {
  const body = $('#prodBody');
  if (!body) return;
  const count = $('#prodCount');
  if (count) count.textContent = `${products.length} referencia(s)`;
  const empty = $('#prodEmpty');
  if (empty) empty.hidden = products.length > 0;
  body.innerHTML = products.map((p, i) => {
    const low = Number(p.stock) <= Number(p.min_stock);
    return `<tr data-idx="${i}" class="${i === selected ? 'selected' : ''}">
      <td><span class="code">${esc(p.sku || '—')}</span></td>
      <td class="name-cell"><strong>${esc(p.name)}</strong>
        <small>${esc([p.measure, p.material, p.brand].filter(Boolean).join(' · ') || 'Sin medida')}</small></td>
      <td>${esc(p.category_name || '—')}</td>
      <td>${esc(p.unit_abbr || 'UND')}</td>
      <td class="num">${fmtMoney(p.cost_price)}</td>
      <td class="num">${fmtMoney(p.sale_price)}</td>
      <td class="num ${low ? 'stock-low' : ''}">${fmtQty(p.stock)}</td>
      <td class="num">${fmtQty(p.min_stock)}</td>
      <td>${low ? '<span class="warn">BAJO</span>' : '<span class="dim">OK</span>'}</td>
      <td class="actions-col"><div class="actions">
        <button type="button" class="btn" data-edit="${p.id}">Editar</button>
        <button type="button" class="btn" data-adjust="${p.id}">Ajustar</button>
        <button type="button" class="btn" data-del="${p.id}">Borrar</button>
      </div></td>
    </tr>`;
  }).join('');
}

function presentationRow(data = {}) {
  const row = document.createElement('div');
  row.className = 'pres-row';
  row.innerHTML = `
    <input data-pres-label placeholder="Ej: Caja x 100" value="${esc(data.label || '')}">
    <input data-pres-qty placeholder="Cant." inputmode="decimal" value="${esc(data.qty ?? '')}">
    <input data-pres-price placeholder="Precio" inputmode="decimal" value="${esc(data.price ?? '')}">
    <input data-pres-barcode placeholder="Código de barras" value="${esc(data.barcode || '')}">
    <button type="button" class="icon-btn" data-pres-del title="Quitar">×</button>`;
  return row;
}

async function openProductModal(id = null, preset = {}) {
  let product = {
    name: preset.name || '',
    sku: '',
    barcode: '',
    category_id: preset.category_id || '',
    unit_id: '',
    measure: '',
    material: '',
    brand: '',
    location: '',
    cost_price: 0,
    sale_price: 0,
    wholesale_price: 0,
    stock: 0,
    min_stock: 0,
    tax_rate: S.settings.default_tax_rate ?? 19,
    presentations: []
  };
  if (id) {
    try {
      product = await api(`/api/products/${id}`);
    } catch (err) {
      toast(err.message, 'error');
      return;
    }
  }
  if (!S.categories.length || !S.units.length) {
    try { await refreshBootstrap(); } catch { /* ignore */ }
  }
  const isEdit = Boolean(id);
  const catOptions = ['<option value="">Sin categoría</option>', ...S.categories.map((c) =>
    `<option value="${c.id}" ${Number(product.category_id) === c.id ? 'selected' : ''}>${esc(c.name)}</option>`)].join('');
  const unitOptions = S.units.map((u) =>
    `<option value="${u.id}" ${Number(product.unit_id) === u.id ? 'selected' : ''}>${esc(u.abbr)} · ${esc(u.name)}</option>`).join('');

  const { close } = openModal({
    title: isEdit ? `Editar producto · ${product.name}` : 'Nuevo producto',
    className: 'wide',
    html: `
      <form data-product-form>
        <div class="form-grid">
          <label class="f2">Nombre del producto *
            <input name="name" value="${esc(product.name)}" required autocomplete="off" placeholder="Ej: Tornillo hex 1/4&quot; x 2&quot;">
          </label>
          <label>Código interno
            <input name="sku" value="${esc(product.sku)}" autocomplete="off" placeholder="Se genera si se deja vacío">
          </label>
          <label>Código de barras
            <input name="barcode" value="${esc(product.barcode)}" autocomplete="off" placeholder="Opcional">
          </label>
          <label>Categoría
            <select name="category_id">${catOptions}</select>
          </label>
          <label>Unidad de medida
            <select name="unit_id">${unitOptions}</select>
          </label>
          <label>Medida / tamaño
            <input name="measure" value="${esc(product.measure)}" autocomplete="off" placeholder="Ej: 1/4&quot; x 2&quot;">
          </label>
          <label>Material
            <input name="material" value="${esc(product.material)}" autocomplete="off" placeholder="Ej: Acero zincado">
          </label>
          <label>Marca
            <input name="brand" value="${esc(product.brand)}" autocomplete="off">
          </label>
          <label>Ubicación
            <input name="location" value="${esc(product.location)}" autocomplete="off" placeholder="Ej: A1-01">
          </label>
          <label>Costo
            <input name="cost_price" inputmode="decimal" value="${Number(product.cost_price || 0).toFixed(2)}">
          </label>
          <label>Precio de venta
            <input name="sale_price" inputmode="decimal" value="${Number(product.sale_price || 0).toFixed(2)}">
          </label>
          <label>Precio mayorista
            <input name="wholesale_price" inputmode="decimal" value="${Number(product.wholesale_price || 0).toFixed(2)}">
          </label>
          <label>IVA (%)
            <input name="tax_rate" inputmode="decimal" value="${Number(product.tax_rate ?? S.settings.default_tax_rate ?? 19)}">
          </label>
          <label>Stock mínimo
            <input name="min_stock" inputmode="decimal" value="${fmtQty(product.min_stock || 0)}">
          </label>
          ${isEdit
            ? `<label>Stock actual
                 <input value="${fmtQty(product.stock)} ${esc(product.unit_abbr || '')}" disabled>
               </label>`
            : `<label>Stock inicial
                 <input name="stock" inputmode="decimal" value="${fmtQty(product.stock || 0)}">
               </label>`}
        </div>

        <div class="pres-editor" style="margin-top:12px">
          <div class="pres-editor-head">
            <span>Presentaciones / empaques (opcional)</span>
            <button type="button" class="btn tiny" data-pres-add>+ Presentación</button>
          </div>
          <div data-pres-rows></div>
          <div class="mini-note">Ej: “Caja x 100” convierte una venta en 100 unidades de inventario.</div>
        </div>

        <div class="form-actions">
          <button type="button" class="btn" data-prod-cancel>Cancelar</button>
          <button type="submit" class="btn primary">${isEdit ? 'GUARDAR CAMBIOS' : 'CREAR PRODUCTO'}</button>
        </div>
      </form>`,
    onMount(modal, closeFn) {
      const form = $('[data-product-form]', modal);
      const rows = $('[data-pres-rows]', modal);
      const addRow = (data = {}) => rows.appendChild(presentationRow(data));
      (product.presentations || []).forEach(addRow);
      $('[data-pres-add]', modal).addEventListener('click', () => {
        addRow();
        const last = rows.lastElementChild;
        last?.querySelector('input')?.focus();
      });
      rows.addEventListener('click', (e) => {
        const del = e.target.closest('[data-pres-del]');
        if (del) del.closest('.pres-row').remove();
      });
      $('[data-prod-cancel]', modal).addEventListener('click', () => closeFn());
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = {};
        for (const [k, v] of fd.entries()) body[k] = String(v).trim();
        body.presentations = $$('.pres-row', rows).map((r) => ({
          label: $('[data-pres-label]', r).value.trim(),
          qty: $('[data-pres-qty]', r).value,
          price: $('[data-pres-price]', r).value,
          barcode: $('[data-pres-barcode]', r).value.trim()
        })).filter((p) => p.label && parseNum(p.qty) > 0);
        body.cost_price = parseNum(body.cost_price);
        body.sale_price = parseNum(body.sale_price);
        body.wholesale_price = parseNum(body.wholesale_price);
        body.tax_rate = parseNum(body.tax_rate);
        body.min_stock = parseNum(body.min_stock);
        if (!isEdit) body.stock = parseNum(body.stock);
        const submit = $('button[type="submit"]', form);
        submit.disabled = true;
        submit.textContent = 'GUARDANDO...';
        try {
          const saved = isEdit
            ? await api(`/api/products/${id}`, { method: 'PUT', body })
            : await api('/api/products', { method: 'POST', body });
          closeFn();
          toast(`Producto ${saved.name} ${isEdit ? 'actualizado' : 'creado'}.`, 'ok');
          await refreshBootstrap();
          updateHeader();
          await loadProducts();
          setStatus(`${saved.name} · ${fmtMoney(saved.sale_price)} · stock ${fmtQty(saved.stock)}`);
        } catch (err) {
          toast(err.message, 'error', 6000);
          submit.disabled = false;
          submit.textContent = isEdit ? 'GUARDAR CAMBIOS' : 'CREAR PRODUCTO';
        }
      });
      setTimeout(() => $('input[name="name"]', form)?.focus(), 40);
    }
  });
  return close;
}

async function deleteProduct(id) {
  const product = products.find((p) => p.id === id);
  const ok = await confirmDialog(
    `¿Borrar <b>${esc(product?.name || 'este producto')}</b>?<br><br>
     Dejará de aparecer en ventas y búsquedas. Las ventas históricas se conservan.`,
    { title: 'Borrar producto', danger: true, okLabel: 'Sí, borrar' }
  );
  if (!ok) return;
  try {
    await api(`/api/products/${id}`, { method: 'DELETE' });
    toast('Producto borrado.', 'ok');
    await refreshBootstrap();
    updateHeader();
    await loadProducts();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function adjustProduct(id) {
  document.dispatchEvent(new CustomEvent('mostrador:adjust-product', { detail: { id } }));
}

/* ---------------- Catálogo de categorías / unidades ---------------- */
async function openCatalog() {
  const { close } = openModal({
    title: 'Categorías y unidades',
    className: 'wide',
    html: `<div class="catalog-grid">
      <div class="catalog-box">
        <h3>Categorías</h3>
        <div class="catalog-list" data-cat-list><div class="empty-state" style="padding:18px">Cargando...</div></div>
        <button type="button" class="btn primary" data-cat-add>+ Nueva categoría</button>
      </div>
      <div class="catalog-box">
        <h3>Unidades de medida</h3>
        <div class="catalog-list" data-unit-list><div class="empty-state" style="padding:18px">Cargando...</div></div>
        <button type="button" class="btn primary" data-unit-add>+ Nueva unidad</button>
      </div>
    </div>`,
    onMount(modal, closeFn) {
      const catList = $('[data-cat-list]', modal);
      const unitList = $('[data-unit-list]', modal);

      const load = async () => {
        try {
          const [cats, units] = await Promise.all([api('/api/categories'), api('/api/units')]);
          S.categories = cats;
          S.units = units;
          catList.innerHTML = cats.map((c) => `<div class="catalog-row">
            <span class="name">${esc(c.name)}</span>
            <span class="count">${c.products || 0}</span>
            <button type="button" class="icon-btn" data-cat-edit="${c.id}" title="Editar">✎</button>
            <button type="button" class="icon-btn" data-cat-del="${c.id}" title="Borrar">×</button>
          </div>`).join('') || '<div class="empty-state" style="padding:18px">Sin categorías.</div>';
          unitList.innerHTML = units.map((u) => `<div class="catalog-row">
            <span class="name"><b>${esc(u.abbr)}</b> · ${esc(u.name)} ${u.decimals ? '<span class="dim">(decimales)</span>' : ''}</span>
            <span class="count">${u.products || 0}</span>
            <button type="button" class="icon-btn" data-unit-edit="${u.id}" title="Editar">✎</button>
            <button type="button" class="icon-btn" data-unit-del="${u.id}" title="Borrar">×</button>
          </div>`).join('') || '<div class="empty-state" style="padding:18px">Sin unidades.</div>';
        } catch (err) {
          catList.innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
          unitList.innerHTML = '';
        }
      };

      $('[data-cat-add]', modal).addEventListener('click', async () => {
        const out = await formDialog({ title: 'Nueva categoría', fields: [{ name: 'name', label: 'Nombre', required: true }] });
        if (!out?.name?.trim()) return;
        try {
          await api('/api/categories', { method: 'POST', body: { name: out.name.trim() } });
          await refreshBootstrap();
          await load();
          toast('Categoría creada.', 'ok');
        } catch (err) { toast(err.message, 'error'); }
      });

      catList.addEventListener('click', async (e) => {
        const edit = e.target.closest('[data-cat-edit]');
        const del = e.target.closest('[data-cat-del]');
        if (edit) {
          const cat = S.categories.find((c) => c.id === Number(edit.dataset.catEdit));
          if (!cat) return;
          const out = await formDialog({ title: 'Editar categoría', fields: [{ name: 'name', label: 'Nombre', value: cat.name, required: true }] });
          if (!out?.name?.trim()) return;
          try {
            await api(`/api/categories/${cat.id}`, { method: 'PUT', body: { name: out.name.trim() } });
            await refreshBootstrap();
            await load();
            toast('Categoría actualizada.', 'ok');
          } catch (err) { toast(err.message, 'error'); }
        }
        if (del) {
          const cat = S.categories.find((c) => c.id === Number(del.dataset.catDel));
          if (!cat) return;
          const ok = await confirmDialog(`¿Borrar la categoría <b>${esc(cat.name)}</b>?`, { danger: true, title: 'Borrar categoría' });
          if (!ok) return;
          try {
            await api(`/api/categories/${cat.id}`, { method: 'DELETE' });
            await refreshBootstrap();
            await load();
            toast('Categoría borrada.', 'ok');
          } catch (err) { toast(err.message, 'error'); }
        }
      });

      $('[data-unit-add]', modal).addEventListener('click', async () => {
        const out = await formDialog({
          title: 'Nueva unidad',
          fields: [
            { name: 'name', label: 'Nombre', placeholder: 'Ej: Metro', required: true },
            { name: 'abbr', label: 'Abreviatura', placeholder: 'Ej: METRO', required: true },
            { name: 'decimals', label: 'Permite decimales', type: 'checkbox' }
          ]
        });
        if (!out?.name?.trim() || !out?.abbr?.trim()) return;
        try {
          await api('/api/units', { method: 'POST', body: { name: out.name.trim(), abbr: out.abbr.trim(), decimals: out.decimals } });
          await refreshBootstrap();
          await load();
          toast('Unidad creada.', 'ok');
        } catch (err) { toast(err.message, 'error'); }
      });

      unitList.addEventListener('click', async (e) => {
        const edit = e.target.closest('[data-unit-edit]');
        const del = e.target.closest('[data-unit-del]');
        if (edit) {
          const unit = S.units.find((u) => u.id === Number(edit.dataset.unitEdit));
          if (!unit) return;
          const out = await formDialog({
            title: 'Editar unidad',
            fields: [
              { name: 'name', label: 'Nombre', value: unit.name, required: true },
              { name: 'abbr', label: 'Abreviatura', value: unit.abbr, required: true },
              { name: 'decimals', label: 'Permite decimales', type: 'checkbox', value: Boolean(unit.decimals) }
            ]
          });
          if (!out?.name?.trim() || !out?.abbr?.trim()) return;
          try {
            await api(`/api/units/${unit.id}`, { method: 'PUT', body: out });
            await refreshBootstrap();
            await load();
            toast('Unidad actualizada.', 'ok');
          } catch (err) { toast(err.message, 'error'); }
        }
        if (del) {
          const unit = S.units.find((u) => u.id === Number(del.dataset.unitDel));
          if (!unit) return;
          const ok = await confirmDialog(`¿Borrar la unidad <b>${esc(unit.abbr)}</b>?`, { danger: true, title: 'Borrar unidad' });
          if (!ok) return;
          try {
            await api(`/api/units/${unit.id}`, { method: 'DELETE' });
            await refreshBootstrap();
            await load();
            toast('Unidad borrada.', 'ok');
          } catch (err) { toast(err.message, 'error'); }
        }
      });

      load();
    }
  });
  return close;
}

/* ---------------- Eventos ---------------- */
export function initProducts() {
  const search = $('#prodSearch');
  search?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadProducts, 150);
  });
  $('#btnNewProduct')?.addEventListener('click', () => openProductModal());
  $('#btnCatalog')?.addEventListener('click', openCatalog);
  $('#btnCatalog2')?.addEventListener('click', openCatalog);

  const body = $('#prodBody');
  body?.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-idx]');
    if (row) {
      selected = Number(row.dataset.idx);
      $$('#prodBody tr').forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.idx) === selected));
    }
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    const adj = e.target.closest('[data-adjust]');
    if (edit) openProductModal(Number(edit.dataset.edit));
    else if (del) deleteProduct(Number(del.dataset.del));
    else if (adj) adjustProduct(Number(adj.dataset.adjust));
  });
  body?.addEventListener('dblclick', (e) => {
    const row = e.target.closest('tr[data-idx]');
    if (row) openProductModal(Number(products[Number(row.dataset.idx)]?.id));
  });

  document.addEventListener('keydown', (e) => {
    if (S.view !== 'productos' || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.matches('input,select,textarea')) return;
    if (e.key === 'Enter' && selected >= 0 && products[selected]) {
      e.preventDefault();
      openProductModal(products[selected].id);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!products.length) return;
      e.preventDefault();
      selected = Math.max(0, Math.min(products.length - 1, selected + (e.key === 'ArrowDown' ? 1 : -1)));
      $$('#prodBody tr').forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.idx) === selected));
      $(`#prodBody tr[data-idx="${selected}"]`)?.scrollIntoView({ block: 'nearest' });
    }
  });

  document.addEventListener('mostrador:new-product', (e) => {
    openProductModal(null, { name: e.detail?.name || '' });
  });
}

export async function loadProductView() {
  await loadProducts();
  setTimeout(() => $('#prodSearch')?.focus(), 30);
}

export { openProductModal, openCatalog };
