import { formatMoney, round2, PAYMENT_LABELS } from '../db.js';

const STATUS_LABELS = {
  borrador: 'BORRADOR',
  enviada: 'ENVIADA',
  aceptada: 'ACEPTADA',
  vencida: 'VENCIDA',
  convertida: 'CONVERTIDA',
  anulada: 'ANULADA',
  ok: 'VÁLIDA'
};

function widthOf(settings) {
  return Math.max(32, Number(settings.print_cols) || 48);
}

function center(text, width) {
  const s = String(text ?? '').trim();
  if (s.length >= width) return s.slice(0, width);
  const left = Math.floor((width - s.length) / 2);
  return ' '.repeat(left) + s;
}

function line(left, right, width) {
  const r = String(right ?? '');
  let l = String(left ?? '');
  const max = Math.max(0, width - r.length - 1);
  if (l.length > max) l = l.slice(0, max);
  return l + ' '.repeat(Math.max(1, width - l.length - r.length)) + r;
}

export function wrapText(text, width) {
  const words = String(text ?? '').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [''];
  const out = [];
  let current = '';
  for (const word of words) {
    if (word.length > width) {
      if (current) {
        out.push(current);
        current = '';
      }
      let rest = word;
      while (rest.length > width) {
        out.push(rest.slice(0, width));
        rest = rest.slice(width);
      }
      current = rest;
      continue;
    }
    const next = current ? `${current} ${word}` : word;
    if (next.length <= width) current = next;
    else {
      out.push(current);
      current = word;
    }
  }
  if (current) out.push(current);
  return out;
}

export function formatQty(qty) {
  const n = Number(qty) || 0;
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(3).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
}

function formatDate(value, withTime = true) {
  const s = String(value || '');
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (!m) return s;
  const date = `${m[3]}/${m[2]}/${m[1]}`;
  return withTime && m[4] ? `${date} ${m[4]}:${m[5]}` : date;
}

function money(n, settings) {
  return formatMoney(n, settings);
}

function itemLines(item, width, settings, withPrice = true) {
  const lines = [];
  const valueW = 14;
  const qtyW = 5;
  const descW = Math.max(10, width - qtyW - valueW - 2);
  const value = withPrice ? money(item.subtotal, settings) : '';
  const name = String(item.name || '');
  const desc = item.measure && !name.includes(item.measure) ? `${name} ${item.measure}` : name;
  const chunks = wrapText(desc, descW);
  const qty = formatQty(item.qty);
  const firstLeft = qty.padStart(qtyW) + ' ' + (chunks[0] || '');
  lines.push(withPrice ? line(firstLeft, value, width) : firstLeft);
  for (let i = 1; i < chunks.length; i++) {
    lines.push(' '.repeat(qtyW + 1) + chunks[i]);
  }
  const unitLabel = item.unit_label || 'UND';
  let detail = `     ${unitLabel} x ${money(item.unit_price, settings)}`;
  if (Number(item.factor) > 1) detail += ` = ${formatQty(item.factor)} UND`;
  lines.push(detail);
  if (Number(item.discount) > 0) {
    lines.push(`     Descuento -${money(item.discount, settings)}`);
  }
  return lines;
}

export function buildReceipt(sale, settings) {
  const width = widthOf(settings);
  const out = [];
  const put = (s = '') => out.push(s);
  const rule = '-'.repeat(width);
  const double = '='.repeat(width);

  if (settings.store_name) put(center(String(settings.store_name).toUpperCase(), width));
  if (settings.store_doc) put(center(`NIT/CC ${settings.store_doc}`, width));
  const addr = [settings.store_address, settings.store_city].filter(Boolean).join(' · ');
  if (addr) wrapText(addr, width).forEach((l) => put(center(l, width)));
  if (settings.store_phone) put(center(`Tel. ${settings.store_phone}`, width));
  put(double);
  put(center(settings.doc_title || 'TICKET DE VENTA', width));
  put(line(`No. ${sale.number}`, formatDate(sale.created_at), width));
  put(`Cliente: ${sale.customer_name || 'Consumidor final'}`);
  put(rule);
  put(line('CANT DESCRIPCION', 'VALOR', width));
  put(rule);

  for (const item of sale.items || []) {
    for (const l of itemLines(item, width, settings)) put(l);
  }

  put(rule);
  if (Number(sale.discount) > 0) {
    put(line('Descuento aplicado', `-${money(sale.discount, settings)}`, width));
  }
  put(line('Base gravable', money(sale.subtotal, settings), width));
  if (Number(sale.tax) > 0) {
    put(line(settings.prices_include_tax ? 'IVA incluido' : 'IVA', money(sale.tax, settings), width));
  }
  put(line('TOTAL', money(sale.total, settings), width));
  put(rule);

  const payLabel = PAYMENT_LABELS[sale.payment_method] || sale.payment_method || 'Efectivo';
  put(line('Pago', payLabel, width));
  if (sale.payment_method === 'efectivo') {
    put(line('Recibido', money(sale.received, settings), width));
    put(line('Cambio', money(sale.change_due, settings), width));
  }
  put(double);

  if (settings.store_footer) {
    wrapText(settings.store_footer, width).forEach((l) => put(center(l, width)));
  }
  if (settings.receipt_note) {
    put('');
    wrapText(settings.receipt_note, width).forEach((l) => put(center(l, width)));
  }
  put('');
  put(center('Mostrador POS · 80 mm', width));
  put('');
  put('');
  return out.join('\n');
}

export function buildQuote(quote, settings) {
  const width = widthOf(settings);
  const out = [];
  const put = (s = '') => out.push(s);
  const rule = '-'.repeat(width);
  const double = '='.repeat(width);

  if (settings.store_name) put(center(String(settings.store_name).toUpperCase(), width));
  if (settings.store_doc) put(center(`NIT/CC ${settings.store_doc}`, width));
  const addr = [settings.store_address, settings.store_city].filter(Boolean).join(' · ');
  if (addr) wrapText(addr, width).forEach((l) => put(center(l, width)));
  if (settings.store_phone) put(center(`Tel. ${settings.store_phone}`, width));
  put(double);
  put(center(settings.quote_title || 'COTIZACIÓN', width));
  put(line(`No. ${quote.number}`, formatDate(quote.created_at), width));
  put(`Cliente: ${quote.customer_name || 'Cliente'}`);
  put(`Vigencia: ${formatDate(quote.valid_until, false)}`);
  if (quote.status && quote.status !== 'borrador') {
    put(`Estado: ${STATUS_LABELS[quote.status] || quote.status}`);
  }
  put(rule);
  put(line('CANT DESCRIPCION', 'VALOR', width));
  put(rule);

  for (const item of quote.items || []) {
    for (const l of itemLines(item, width, settings)) put(l);
  }

  put(rule);
  put(line('Base gravable', money(quote.subtotal, settings), width));
  if (Number(quote.tax) > 0) {
    put(line(settings.prices_include_tax ? 'IVA incluido' : 'IVA', money(quote.tax, settings), width));
  }
  put(line('TOTAL', money(quote.total, settings), width));
  put(double);
  put(center('Cotización sujeta a disponibilidad', width));
  if (quote.notes) wrapText(quote.notes, width).forEach((l) => put(l));
  if (settings.store_footer) {
    put('');
    wrapText(settings.store_footer, width).forEach((l) => put(center(l, width)));
  }
  put('');
  put(center('Mostrador POS · 80 mm', width));
  put('');
  put('');
  return out.join('\n');
}

export function buildTest(settings) {
  const sample = {
    number: 'T-000001',
    created_at: new Date().toISOString().slice(0, 19).replace('T', ' '),
    customer_name: 'Consumidor final',
    subtotal: 504.2,
    discount: 0,
    tax: 95.8,
    total: 600,
    payment_method: 'efectivo',
    received: 1000,
    change_due: 400,
    items: [
      {
        name: 'Tornillo hex 1/4" x 2"',
        measure: '1/4" x 2"',
        unit_label: 'UND',
        qty: 2,
        factor: 1,
        unit_price: 250,
        discount: 0,
        subtotal: 500
      },
      {
        name: 'Tuerca hex 1/4" galvanizada',
        measure: '1/4"',
        unit_label: 'UND',
        qty: 1,
        factor: 1,
        unit_price: 100,
        discount: 0,
        subtotal: 100
      }
    ]
  };
  return buildReceipt(sample, settings);
}

export function totalsFromItems(items, settings) {
  let gross = 0;
  let base = 0;
  let tax = 0;
  const include = Boolean(settings.prices_include_tax);
  const lines = items.map((it) => {
    const lineGross = round2(Math.max(0, Number(it.qty) * Number(it.unit_price) - Number(it.discount || 0)));
    const rate = Number(it.tax_rate || 0);
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
    return { ...it, subtotal: lineTotal, line_base: lineBase, line_tax: lineTax };
  });
  return { items: lines, gross, base, tax };
}
