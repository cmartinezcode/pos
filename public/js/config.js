/* =========================================================
   MOSTRADOR · configuración, impresora y respaldos
   ========================================================= */
import {
  S, $, esc, toast, setStatus, api, applyTheme, refreshBootstrap, updateHeader,
  showReceipt, browserPrint, renderPrinterStatus, normalizeTheme
} from './core.js';

const BOOL_FIELDS = ['prices_include_tax', 'cut_paper', 'auto_print', 'allow_negative_stock', 'scanlines'];
const NUMBER_FIELDS = ['default_tax_rate', 'ticket_pad', 'quote_pad', 'quote_valid_days', 'print_port', 'print_cols'];

function fillForm() {
  const form = $('#configForm');
  if (!form) return;
  for (const el of form.elements) {
    if (!el.name) continue;
    const key = el.name;
    let value = S.settings[key];
    if (key === 'accent') value = normalizeTheme(value);
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else if (value !== undefined && value !== null) el.value = String(value);
  }
  updatePrinterBox();
}

function updatePrinterBox() {
  const box = $('#printerStatus');
  if (!box) return;
  box.innerHTML = 'Navegador / CUPS: el ticket se imprime con el diálogo del sistema y también se puede guardar como PDF.';
}

async function refreshPrinterStatus() {
  try {
    const status = await api('/api/print/status');
    S.printer = status;
    updatePrinterBox();
    renderPrinterStatus();
  } catch (err) {
    const box = $('#printerStatus');
    if (box) box.textContent = err.message;
  }
}

async function saveConfig(e) {
  e.preventDefault();
  const form = $('#configForm');
  const body = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    if (el.type === 'checkbox') body[el.name] = el.checked;
    else if (NUMBER_FIELDS.includes(el.name)) body[el.name] = Number(el.value) || 0;
    else body[el.name] = el.value;
  }
  const submit = $('button[type="submit"]', form);
  submit.disabled = true;
  submit.textContent = 'GUARDANDO...';
  try {
    const settings = await api('/api/settings', { method: 'PUT', body });
    S.settings = settings;
    applyTheme();
    await refreshBootstrap();
    updateHeader();
    fillForm();
    toast('Configuración guardada.', 'ok');
    setStatus('Configuración actualizada.');
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally {
    submit.disabled = false;
    submit.textContent = 'GUARDAR CONFIGURACIÓN';
  }
}

async function testPrint() {
  const btn = $('#btnTestPrint');
  btn.disabled = true;
  btn.textContent = 'PROBANDO...';
  try {
    const data = await api('/api/print/test', { method: 'POST' });
    browserPrint(data.text);
    toast('Abre el diálogo de impresión del navegador.', 'ok');
  } catch (err) {
    toast(err.message, 'error', 7000);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Probar impresión';
  }
}

async function previewPrint() {
  try {
    const data = await api('/api/print/sample');
    showReceipt({ text: data.text, title: 'Vista previa · 80 mm' });
  } catch (err) {
    toast(err.message, 'error');
  }
}

export function initConfig() {
  $('#configForm')?.addEventListener('submit', saveConfig);
  $('#btnTestPrint')?.addEventListener('click', testPrint);
  $('#btnPreviewPrint')?.addEventListener('click', previewPrint);
  $('#btnChangePassword')?.addEventListener('click', changeAccessPassword);
  $('#btnLogout')?.addEventListener('click', logoutSession);
  $('#configForm')?.elements?.print_device?.addEventListener('change', updatePrinterBox);
}

async function changeAccessPassword() {
  const current = $('#pwCurrent')?.value || '';
  const next = $('#pwNext')?.value || '';
  const repeat = $('#pwRepeat')?.value || '';
  if (!current || !next) {
    toast('Escribe la clave actual y la nueva.', 'warn');
    return;
  }
  if (next.length < 8) {
    toast('La clave nueva debe tener al menos 8 caracteres.', 'warn');
    return;
  }
  if (next !== repeat) {
    toast('Las claves nuevas no coinciden.', 'warn');
    return;
  }
  const btn = $('#btnChangePassword');
  btn.disabled = true;
  try {
    await api('/api/password', { method: 'PUT', body: { current, next } });
    $('#pwCurrent').value = '';
    $('#pwNext').value = '';
    $('#pwRepeat').value = '';
    toast('Clave actualizada.', 'ok');
  } catch (err) {
    toast(err.message, 'error', 6000);
  } finally {
    btn.disabled = false;
  }
}

async function logoutSession() {
  try {
    await api('/api/logout', { method: 'POST' });
  } catch {
    /* la sesión pudo expirar */
  }
  window.location.href = '/login';
}

export async function loadConfigView() {
  try {
    await refreshBootstrap();
  } catch { /* usar valores en memoria */ }
  fillForm();
  refreshPrinterStatus();
}

export { fillForm, refreshPrinterStatus };
