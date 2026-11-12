/* =========================================================
   MOSTRADOR · reportes del período
   ========================================================= */
import {
  $, esc, fmtMoney, fmtQty, fmtDate, todayLocal, monthStartLocal,
  toast, api, PAY_LABELS
} from './core.js';

async function loadReports() {
  const from = $('#reportFrom')?.value || monthStartLocal();
  const to = $('#reportTo')?.value || todayLocal();
  try {
    const data = await api(`/api/reports?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    const totals = data.totals || {};
    if ($('#repTotal')) $('#repTotal').textContent = fmtMoney(totals.total || 0);
    if ($('#repCount')) $('#repCount').textContent = String(totals.count || 0);
    if ($('#repProfit')) $('#repProfit').textContent = fmtMoney(totals.profit || 0);
    if ($('#repAvg')) $('#repAvg').textContent = fmtMoney(totals.avg || 0);
    if ($('#repTopBody')) {
      $('#repTopBody').innerHTML = (data.topProducts || []).map((p) => `<tr>
        <td class="code">${esc(p.code || '—')}</td>
        <td>${esc(p.name)}</td>
        <td class="num">${fmtQty(p.qty)}</td>
        <td class="num">${fmtMoney(p.amount)}</td>
        <td class="num">${fmtMoney(p.cost)}</td>
      </tr>`).join('') || '<tr><td colspan="5" class="dim" style="padding:18px;text-align:center">Sin ventas en el período.</td></tr>';
    }
    if ($('#repDayBody')) {
      $('#repDayBody').innerHTML = (data.byDay || []).map((d) => `<tr>
        <td>${fmtDate(d.day, false)}</td>
        <td class="num">${d.count}</td>
        <td class="num">${fmtMoney(d.total)}</td>
        <td class="num">${fmtMoney(d.profit)}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="dim" style="padding:18px;text-align:center">Sin datos.</td></tr>';
    }
    if ($('#repPayBody')) {
      $('#repPayBody').innerHTML = (data.payments || []).map((p) => `<tr>
        <td>${esc(PAY_LABELS[p.payment_method] || p.payment_method)}</td>
        <td class="num">${p.count}</td>
        <td class="num">${fmtMoney(p.total)}</td>
      </tr>`).join('') || '<tr><td colspan="3" class="dim" style="padding:18px;text-align:center">Sin datos.</td></tr>';
    }
    if ($('#repLowBody')) {
      $('#repLowBody').innerHTML = (data.lowStock || []).map((p) => `<tr>
        <td class="code">${esc(p.sku || '—')}</td>
        <td>${esc(p.name)}</td>
        <td class="num stock-low">${fmtQty(p.stock)} <span class="dim">${esc(p.unit_abbr || '')}</span></td>
        <td class="num">${fmtQty(p.min_stock)}</td>
      </tr>`).join('') || '<tr><td colspan="4" class="dim" style="padding:18px;text-align:center">Todo el stock está sobre el mínimo.</td></tr>';
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function initReports() {
  $('#btnReportRefresh')?.addEventListener('click', loadReports);
  $('#reportFrom')?.addEventListener('change', loadReports);
  $('#reportTo')?.addEventListener('change', loadReports);
  document.addEventListener('mostrador:reports-refresh', loadReports);
}

export async function loadReportsView() {
  if (!$('#reportFrom')?.value) $('#reportFrom').value = monthStartLocal();
  if (!$('#reportTo')?.value) $('#reportTo').value = todayLocal();
  await loadReports();
}

export { loadReports };
