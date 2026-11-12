/* =========================================================
   MOSTRADOR · cotizaciones
   ========================================================= */
import {
  S, $, $$, esc, fmtMoney, fmtQty, fmtDate, toast, api, openModal,
  confirmDialog, formDialog, refreshBootstrap, STATUS_LABELS
} from './core.js';
import { startNewQuote, editQuote, printQuoteById, openPaymentModal } from './sale.js';

let quotes = [];
let selected = 0;
let searchTimer = null;

async function loadQuotes() {
  const q = $('#quoteSearch')?.value.trim() || '';
  const status = $('#quoteStatus')?.value || '';
  try {
    const data = await api(`/api/quotes?q=${encodeURIComponent(q)}&status=${encodeURIComponent(status)}&limit=500`);
    quotes = Array.isArray(data) ? data : [];
    if (selected >= quotes.length) selected = 0;
    renderQuotes();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function statusBadge(status) {
  const cls = status === 'convertida'
    ? 'stock-ok'
    : status === 'anulada' || status === 'vencida'
      ? 'danger'
      : status === 'aceptada'
        ? 'stock-ok'
        : 'warn';
  return `<span class="${cls}">${esc(STATUS_LABELS[status] || status)}</span>`;
}

function renderQuotes() {
  const body = $('#quoteBody');
  if (!body) return;
  body.innerHTML = quotes.map((q, i) => {
    const editable = !['convertida', 'anulada'].includes(q.status);
    return `<tr data-idx="${i}" class="${i === selected ? 'selected' : ''}">
      <td><b>${esc(q.number)}</b></td>
      <td class="dim">${fmtDate(q.created_at)}</td>
      <td>${esc(q.customer_name || 'Cliente')}</td>
      <td class="dim">${fmtDate(q.valid_until, false)}</td>
      <td class="num total-cell">${fmtMoney(q.total)}</td>
      <td>${statusBadge(q.status)}</td>
      <td class="actions-col"><div class="actions">
        <button type="button" class="btn" data-view="${q.id}">Ver</button>
        <button type="button" class="btn" data-print="${q.id}">Imprimir</button>
        ${editable ? `<button type="button" class="btn" data-edit="${q.id}">Editar</button>` : ''}
        ${editable ? `<button type="button" class="btn" data-convert="${q.id}">Convertir</button>` : ''}
        ${editable ? `<button type="button" class="btn" data-cancel="${q.id}">Anular</button>` : ''}
      </div></td>
    </tr>`;
  }).join('');
  if ($('#quoteEmpty')) $('#quoteEmpty').hidden = quotes.length > 0;
}

async function convertQuote(id) {
  try {
    const quote = await api(`/api/quotes/${id}`);
    if (quote.status === 'convertida') {
      toast('Esta cotización ya fue convertida.', 'warn');
      return;
    }
    if (quote.status === 'anulada') {
      toast('Esta cotización está anulada.', 'warn');
      return;
    }
    openPaymentModal({
      mode: 'convert',
      quote,
      onDone: async () => {
        await loadQuotes();
      }
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function setQuoteStatus(quote) {
  const out = await formDialog({
    title: `Estado de ${quote.number}`,
    fields: [{
      name: 'status',
      label: 'Nuevo estado',
      type: 'select',
      value: quote.status,
      options: [
        { value: 'borrador', label: 'Borrador' },
        { value: 'enviada', label: 'Enviada al cliente' },
        { value: 'aceptada', label: 'Aceptada por el cliente' },
        { value: 'vencida', label: 'Vencida' }
      ]
    }],
    submitLabel: 'Cambiar estado'
  });
  if (!out?.status) return;
  try {
    await api(`/api/quotes/${quote.id}/status`, { method: 'POST', body: { status: out.status } });
    toast(`Cotización ${quote.number}: ${STATUS_LABELS[out.status] || out.status}.`, 'ok');
    await loadQuotes();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function cancelQuote(quote) {
  const ok = await confirmDialog(
    `¿Anular la cotización <b>${esc(quote.number)}</b> por <b>${fmtMoney(quote.total)}</b>?`,
    { title: 'Anular cotización', danger: true, okLabel: 'Sí, anular' }
  );
  if (!ok) return;
  try {
    await api(`/api/quotes/${quote.id}/status`, { method: 'POST', body: { status: 'anulada' } });
    toast(`Cotización ${quote.number} anulada.`, 'ok');
    await loadQuotes();
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openQuoteDetail(id) {
  try {
    const quote = await api(`/api/quotes/${id}`);
    const editable = !['convertida', 'anulada'].includes(quote.status);
    openModal({
      title: `Cotización ${quote.number}`,
      className: 'wide',
      html: `
        <div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
          <div class="kpi"><span>Fecha</span><b style="font-size:12px">${fmtDate(quote.created_at)}</b></div>
          <div class="kpi"><span>Cliente</span><b style="font-size:12px">${esc(quote.customer_name || 'Cliente')}</b></div>
          <div class="kpi"><span>Vigencia</span><b style="font-size:12px">${fmtDate(quote.valid_until, false)}</b></div>
          <div class="kpi"><span>Total</span><b>${fmtMoney(quote.total)}</b></div>
        </div>
        <div style="margin-bottom:10px">Estado: ${statusBadge(quote.status)}
          ${quote.notes ? `<span class="dim" style="margin-left:12px">${esc(quote.notes)}</span>` : ''}</div>
        <div class="table-wrap medium">
          <table class="data">
            <thead><tr><th>Cant</th><th>Producto</th><th class="num">Precio</th><th class="num">Desc.</th><th class="num">Total</th></tr></thead>
            <tbody>${(quote.items || []).map((it) => `<tr>
              <td class="num">${fmtQty(it.qty)} <span class="dim">${esc(it.unit_label)}</span></td>
              <td>${esc(it.name)}${it.measure ? `<div class="p-meta">${esc(it.measure)}</div>` : ''}</td>
              <td class="num">${fmtMoney(it.unit_price)}</td>
              <td class="num">${fmtMoney(it.discount)}</td>
              <td class="num">${fmtMoney(it.subtotal)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="totals" style="margin-top:10px">
          <div class="t-row"><span>Base gravable</span><b>${fmtMoney(quote.subtotal)}</b></div>
          <div class="t-row"><span>IVA</span><b>${fmtMoney(quote.tax)}</b></div>
          <div class="t-total"><span>TOTAL</span><b>${fmtMoney(quote.total)}</b></div>
        </div>
        <div class="receipt-actions" style="justify-content:flex-start">
          <button type="button" class="btn primary" data-q-print>Imprimir</button>
          ${editable ? '<button type="button" class="btn" data-q-edit>Editar</button>' : ''}
          ${editable ? '<button type="button" class="btn" data-q-convert>Convertir en venta</button>' : ''}
          ${editable ? '<button type="button" class="btn" data-q-status>Cambiar estado</button>' : ''}
          ${editable ? '<button type="button" class="btn" data-q-cancel style="border-color:var(--red);color:var(--red)">Anular</button>' : ''}
        </div>`,
      onMount(modal, closeFn) {
        $('[data-q-print]', modal).addEventListener('click', () => {
          closeFn();
          printQuoteById(quote.id);
        });
        $('[data-q-edit]', modal)?.addEventListener('click', () => {
          closeFn();
          editQuote(quote.id);
        });
        $('[data-q-convert]', modal)?.addEventListener('click', () => {
          closeFn();
          convertQuote(quote.id);
        });
        $('[data-q-status]', modal)?.addEventListener('click', () => {
          closeFn();
          setQuoteStatus(quote);
        });
        $('[data-q-cancel]', modal)?.addEventListener('click', () => {
          closeFn();
          cancelQuote(quote);
        });
      }
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function initQuotes() {
  $('#quoteSearch')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadQuotes, 160);
  });
  $('#quoteStatus')?.addEventListener('change', loadQuotes);
  $('#btnNewQuote')?.addEventListener('click', startNewQuote);
  $('#quoteBody')?.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-idx]');
    if (row) {
      selected = Number(row.dataset.idx);
      $$('#quoteBody tr').forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.idx) === selected));
    }
    const view = e.target.closest('[data-view]');
    const print = e.target.closest('[data-print]');
    const edit = e.target.closest('[data-edit]');
    const convert = e.target.closest('[data-convert]');
    const cancel = e.target.closest('[data-cancel]');
    if (view) openQuoteDetail(Number(view.dataset.view));
    else if (print) printQuoteById(Number(print.dataset.print));
    else if (edit) editQuote(Number(edit.dataset.edit));
    else if (convert) convertQuote(Number(convert.dataset.convert));
    else if (cancel) {
      const quote = quotes.find((q) => q.id === Number(cancel.dataset.cancel));
      if (quote) cancelQuote(quote);
    }
  });
  $('#quoteBody')?.addEventListener('dblclick', (e) => {
    const row = e.target.closest('tr[data-idx]');
    if (row && quotes[Number(row.dataset.idx)]) openQuoteDetail(quotes[Number(row.dataset.idx)].id);
  });
  document.addEventListener('keydown', (e) => {
    if (S.view !== 'cotizaciones' || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.matches('input,select,textarea')) return;
    if (e.key === 'Enter' && quotes[selected]) {
      e.preventDefault();
      openQuoteDetail(quotes[selected].id);
    }
  });
}

export async function loadQuotesView() {
  await refreshBootstrap();
  await loadQuotes();
  setTimeout(() => $('#quoteSearch')?.focus(), 30);
}

export { loadQuotes, openQuoteDetail, convertQuote };
