/* =========================================================
   MOSTRADOR · historial de ventas, anulación y reimpresión
   ========================================================= */
import {
  S, $, $$, esc, fmtMoney, fmtQty, fmtDate, todayLocal, monthStartLocal,
  toast, api, openModal, confirmDialog, refreshBootstrap, updateHeader,
  showReceipt, STATUS_LABELS, PAY_LABELS
} from './core.js';

let sales = [];
let selected = 0;
let searchTimer = null;

function setDateRange(from, to) {
  if ($('#salesFrom')) $('#salesFrom').value = from;
  if ($('#salesTo')) $('#salesTo').value = to;
}

async function loadSales() {
  const from = $('#salesFrom')?.value || todayLocal();
  const to = $('#salesTo')?.value || todayLocal();
  const q = $('#saleListSearch')?.value.trim() || '';
  try {
    const data = await api(`/api/sales?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&q=${encodeURIComponent(q)}&limit=500`);
    sales = Array.isArray(data) ? data : [];
    if (selected >= sales.length) selected = 0;
    renderSales();
  } catch (err) {
    toast(err.message, 'error');
  }
}

function renderSales() {
  const body = $('#salesBody');
  if (!body) return;
  body.innerHTML = sales.map((s, i) => `<tr data-idx="${i}" class="${i === selected ? 'selected' : ''}">
    <td><b>${esc(s.number)}</b></td>
    <td class="dim">${fmtDate(s.created_at)}</td>
    <td>${esc(s.customer_name || 'Consumidor final')}</td>
    <td class="num">${s.items_count}</td>
    <td>${esc(PAY_LABELS[s.payment_method] || s.payment_method)}</td>
    <td class="num total-cell">${fmtMoney(s.total)}</td>
    <td>${s.status === 'ok' ? '<span class="stock-ok">Válida</span>' : '<span class="danger">Anulada</span>'}</td>
    <td class="actions-col"><div class="actions">
      <button type="button" class="btn" data-view="${s.id}">Ver</button>
      <button type="button" class="btn" data-print="${s.id}">Imprimir</button>
      ${s.status === 'ok' ? `<button type="button" class="btn" data-void="${s.id}">Anular</button>` : ''}
    </div></td>
  </tr>`).join('');
  if ($('#salesEmpty')) $('#salesEmpty').hidden = sales.length > 0;
  const stats = S.stats || {};
  if ($('#salToday')) $('#salToday').textContent = fmtMoney(stats.todaySales?.total || 0);
  if ($('#salTodayCount')) $('#salTodayCount').textContent = String(stats.todaySales?.count || 0);
  if ($('#salMonth')) $('#salMonth').textContent = fmtMoney(stats.monthSales?.total || 0);
  if ($('#salProfit')) $('#salProfit').textContent = fmtMoney(stats.todaySales?.profit || 0);
}

async function openSaleDetail(id) {
  try {
    const [sale, receipt] = await Promise.all([
      api(`/api/sales/${id}`),
      api(`/api/sales/${id}/receipt`)
    ]);
    openModal({
      title: `Venta ${sale.number}`,
      className: 'wide',
      html: `
        <div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:12px">
          <div class="kpi"><span>Fecha</span><b style="font-size:12px">${fmtDate(sale.created_at)}</b></div>
          <div class="kpi"><span>Cliente</span><b style="font-size:12px">${esc(sale.customer_name)}</b></div>
          <div class="kpi"><span>Pago</span><b style="font-size:12px">${esc(PAY_LABELS[sale.payment_method] || sale.payment_method)}</b></div>
          <div class="kpi"><span>Total</span><b>${fmtMoney(sale.total)}</b></div>
        </div>
        <div class="table-wrap medium">
          <table class="data">
            <thead><tr><th>Cant</th><th>Producto</th><th class="num">Precio</th><th class="num">Desc.</th><th class="num">Total</th></tr></thead>
            <tbody>${(sale.items || []).map((it) => `<tr>
              <td class="num">${fmtQty(it.qty)} <span class="dim">${esc(it.unit_label)}</span></td>
              <td>${esc(it.name)}${it.measure ? `<div class="p-meta">${esc(it.measure)}</div>` : ''}</td>
              <td class="num">${fmtMoney(it.unit_price)}</td>
              <td class="num">${fmtMoney(it.discount)}</td>
              <td class="num">${fmtMoney(it.subtotal)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>
        <div class="totals" style="margin-top:10px">
          <div class="t-row"><span>Base gravable</span><b>${fmtMoney(sale.subtotal)}</b></div>
          <div class="t-row"><span>IVA</span><b>${fmtMoney(sale.tax)}</b></div>
          <div class="t-total"><span>TOTAL</span><b>${fmtMoney(sale.total)}</b></div>
        </div>
        <div class="receipt-actions" style="justify-content:flex-start">
          <button type="button" class="btn primary" data-detail-print>Reimprimir ticket</button>
          ${sale.status === 'ok' ? '<button type="button" class="btn" data-detail-void style="border-color:var(--red);color:var(--red)">Anular venta</button>' : '<span class="dim">Venta anulada</span>'}
        </div>`,
      onMount(modal, closeFn) {
        $('[data-detail-print]', modal).addEventListener('click', () => {
          closeFn();
          showReceipt({ text: receipt.text, saleId: sale.id, title: `Ticket ${sale.number}` });
        });
        const voidBtn = $('[data-detail-void]', modal);
        voidBtn?.addEventListener('click', async () => {
          closeFn();
          await voidSale(sale);
        });
      }
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function voidSale(sale) {
  const ok = await confirmDialog(
    `¿Anular la venta <b>${esc(sale.number)}</b> por <b>${fmtMoney(sale.total)}</b>?<br><br>
     El inventario de sus productos se devolverá automáticamente.`,
    { title: 'Anular venta', danger: true, okLabel: 'Sí, anular' }
  );
  if (!ok) return;
  try {
    await api(`/api/sales/${sale.id}/void`, { method: 'POST' });
    toast(`Venta ${sale.number} anulada. Inventario restaurado.`, 'ok');
    await refreshBootstrap();
    updateHeader();
    await loadSales();
  } catch (err) {
    toast(err.message, 'error', 6000);
  }
}

async function reprint(id) {
  try {
    const [sale, receipt] = await Promise.all([
      api(`/api/sales/${id}`),
      api(`/api/sales/${id}/receipt`)
    ]);
    showReceipt({ text: receipt.text, saleId: id, title: `Ticket ${sale.number}` });
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function initSales() {
  $('#saleListSearch')?.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadSales, 160);
  });
  $('#salesFrom')?.addEventListener('change', loadSales);
  $('#salesTo')?.addEventListener('change', loadSales);
  $('#btnReloadSales')?.addEventListener('click', loadSales);
  $('#btnTodaySales')?.addEventListener('click', () => {
    const today = todayLocal();
    setDateRange(today, today);
    loadSales();
  });
  $('#btnMonthSales')?.addEventListener('click', () => {
    setDateRange(monthStartLocal(), todayLocal());
    loadSales();
  });
  $('#salesBody')?.addEventListener('click', (e) => {
    const row = e.target.closest('tr[data-idx]');
    if (row) {
      selected = Number(row.dataset.idx);
      $$('#salesBody tr').forEach((tr) => tr.classList.toggle('selected', Number(tr.dataset.idx) === selected));
    }
    const view = e.target.closest('[data-view]');
    const print = e.target.closest('[data-print]');
    const voidBtn = e.target.closest('[data-void]');
    if (view) openSaleDetail(Number(view.dataset.view));
    else if (print) reprint(Number(print.dataset.print));
    else if (voidBtn) {
      const sale = sales.find((s) => s.id === Number(voidBtn.dataset.void));
      if (sale) voidSale(sale);
    }
  });
  $('#salesBody')?.addEventListener('dblclick', (e) => {
    const row = e.target.closest('tr[data-idx]');
    if (row && sales[Number(row.dataset.idx)]) openSaleDetail(sales[Number(row.dataset.idx)].id);
  });
  document.addEventListener('keydown', (e) => {
    if (S.view !== 'ventas' || e.ctrlKey || e.altKey || e.metaKey) return;
    if (e.target instanceof Element && e.target.matches('input,select,textarea')) return;
    if (e.key === 'Enter' && sales[selected]) {
      e.preventDefault();
      openSaleDetail(sales[selected].id);
    }
  });
}

export async function loadSalesView() {
  if (!$('#salesFrom')?.value) setDateRange(todayLocal(), todayLocal());
  try {
    await refreshBootstrap();
  } catch { /* datos locales disponibles */ }
  await loadSales();
  setTimeout(() => $('#saleListSearch')?.focus(), 30);
}

export { openSaleDetail, reprint };
