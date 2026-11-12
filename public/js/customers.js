/* =========================================================
   MOSTRADOR · clientes
   ========================================================= */
import {
  S, $, $$, esc, toast, api, openModal, confirmDialog, refreshBootstrap
} from './core.js';

let customers = [];
let selected = -1;
let searchTimer = null;

async function loadCustomers() {
  const q = $('#customerSearch')?.value.trim() || '';
  try {
    const data = await api(`/api/customers?q=${encodeURIComponent(q)}&limit=500`);
    customers = Array.isArray(data) ? data : [];
    if (selected >= customers.length) selected = -1;
    renderCustomers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderCustomers() {
  const body = $('#customerBody');
  if (!body) return;
  body.innerHTML = customers.map((c, i) => `<tr data-idx="${i}" class="${i === selected ? 'selected' : ''}">
    <td class="code">${esc(c.doc || '—')}</td>
    <td class="name-cell"><strong>${esc(c.name)}</strong>${c.notes ? `<small>${esc(c.notes)}</small>` : ''}</td>
    <td>${esc(c.phone || '—')}</td>
    <td>${esc(c.address || '—')}</td>
    <td class="dim">${esc(c.email || '—')}</td>
    <td class="actions-col"><div class="actions">
      <button type="button" class="btn" data-edit="${c.id}">Editar</button>
      <button type="button" class="btn" data-del="${c.id}">Borrar</button>
    </div></td>
  </tr>`).join('');
  if ($('#customerEmpty')) $('#customerEmpty').hidden = customers.length > 0;
}

function openCustomerModal(customer = null) {
  const data = customer || { doc: '', name: '', phone: '', address: '', email: '', notes: '' };
  const { close } = openModal({
    title: customer ? `Editar cliente · ${data.name}` : 'Nuevo cliente',
    className: 'small',
    html: `<form data-customer-form>
      <div class="form-grid">
        <label class="f2">Nombre / razón social *
          <input name="name" value="${esc(data.name)}" required autocomplete="off">
        </label>
        <label>Documento / NIT
          <input name="doc" value="${esc(data.doc)}" autocomplete="off">
        </label>
        <label>Teléfono
          <input name="phone" value="${esc(data.phone)}" autocomplete="off">
        </label>
        <label class="f2">Dirección
          <input name="address" value="${esc(data.address)}" autocomplete="off">
        </label>
        <label class="f2">Correo electrónico
          <input name="email" type="email" value="${esc(data.email)}" autocomplete="off">
        </label>
        <label class="f2">Notas
          <textarea name="notes" rows="2">${esc(data.notes)}</textarea>
        </label>
      </div>
      <div class="form-actions">
        <button type="button" class="btn" data-cancel>Cancelar</button>
        <button type="submit" class="btn primary">${customer ? 'GUARDAR CAMBIOS' : 'CREAR CLIENTE'}</button>
      </div>
    </form>`,
    onMount(modal, closeFn) {
      const form = $('[data-customer-form]', modal);
      $('[data-cancel]', modal).addEventListener('click', () => closeFn());
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(form);
        const body = {};
        for (const [k, v] of fd.entries()) body[k] = String(v).trim();
        const submit = $('button[type="submit"]', form);
        submit.disabled = true;
        submit.textContent = 'GUARDANDO...';
        try {
          const saved = customer
            ? await api(`/api/customers/${customer.id}`, { method: 'PUT', body })
            : await api('/api/customers', { method: 'POST', body });
          closeFn();
          toast(`Cliente ${saved.name} ${customer ? 'actualizado' : 'creado'}.`, 'ok');
          await refreshBootstrap();
          await loadCustomers();
        } catch (err) {
          toast(err.message, 'error', 6000);
          submit.disabled = false;
          submit.textContent = customer ? 'GUARDAR CAMBIOS' : 'CREAR CLIENTE';
        }
      });
      setTimeout(() => $('input[name="name"]', form)?.focus(), 40);
    }
  });
  return close;
}

async function deleteCustomer(id) {
  const customer = customers.find((c) => c.id === id);
  const ok = await confirmDialog(
    `¿Borrar el cliente <b>${esc(customer?.name || '')}</b>?<br><br>Las ventas históricas se conservan.`,
    { title: 'Borrar cliente', danger: true, okLabel: 'Sí, borrar' }
  );
  if (!ok) return;
  try {
    await api(`/api/customers/${id}`, { method: 'DELETE' });
    toast('Cliente borrado.', 'ok');
    await refreshBootstrap();
    await loadCustomers();
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function initCustomers() {
  const search = $('#customerSearch');
  search?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadCustomers, 150);
  });
  $('#btnNewCustomer')?.addEventListener('click', () => openCustomerModal());
  $('#customerBody')?.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-idx]');
    if (row) {
      selected = Number(row.dataset.idx);
      $$('#customerBody tr').forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.idx) === selected));
    }
    const edit = e.target.closest('[data-edit]');
    const del = e.target.closest('[data-del]');
    if (edit) {
      const customer = customers.find((c) => c.id === Number(edit.dataset.edit));
      if (customer) openCustomerModal(customer);
    } else if (del) deleteCustomer(Number(del.dataset.del));
  });
  $('#customerBody')?.addEventListener('dblclick', (e) => {
    const row = e.target.closest('tr[data-idx]');
    if (row && customers[Number(row.dataset.idx)]) openCustomerModal(customers[Number(row.dataset.idx)]);
  });
  document.addEventListener('keydown', (e) => {
    if (S.view !== 'clientes' || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.matches('input,select,textarea')) return;
    if (e.key === 'Enter' && selected >= 0 && customers[selected]) {
      e.preventDefault();
      openCustomerModal(customers[selected]);
    }
  });
}

export async function loadCustomersView() {
  await loadCustomers();
  setTimeout(() => $('#customerSearch')?.focus(), 30);
}

export { openCustomerModal };
