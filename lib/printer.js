import fs from 'node:fs';
import net from 'node:net';

/* Juego alto de CP437 (códigos 128-255), el estándar de las térmicas ESC/POS. */
const HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■\u00a0';

const CP437 = new Map();
for (let i = 0; i < HIGH.length; i++) CP437.set(HIGH[i], 128 + i);

const FALLBACK = new Map(
  Object.entries({
    '€': 'E',
    '–': '-',
    '—': '-',
    '―': '-',
    '“': '"',
    '”': '"',
    '„': '"',
    '‘': "'",
    '’': "'",
    '…': '...',
    '•': '*',
    '×': 'x',
    '→': '>',
    '✓': 'v',
    'Á': 'A',
    'Í': 'I',
    'Ó': 'O',
    'Ú': 'U',
    'À': 'A',
    'È': 'E',
    'Ì': 'I',
    'Ò': 'O',
    'Ù': 'U'
  })
);

export function encodeCP437(text) {
  const input = String(text ?? '').replace(/\r\n/g, '\n');
  const bytes = [];
  for (const ch of input) {
    const code = ch.codePointAt(0);
    if (ch === '\n') {
      bytes.push(10);
    } else if (code < 128) {
      bytes.push(code);
    } else if (CP437.has(ch)) {
      bytes.push(CP437.get(ch));
    } else if (FALLBACK.has(ch)) {
      const repl = FALLBACK.get(ch);
      for (const c of repl) bytes.push(c.codePointAt(0) < 128 ? c.codePointAt(0) : 63);
    } else {
      bytes.push(63);
    }
  }
  return Buffer.from(bytes);
}

export function escposBuffer(text, settings = {}) {
  const chunks = [
    Buffer.from([0x1b, 0x40]), // inicializar
    Buffer.from([0x1b, 0x74, 0x00]) // página de códigos CP437
  ];
  chunks.push(encodeCP437(String(text ?? '').replace(/\n+$/, '') + '\n'));
  chunks.push(Buffer.from([0x1b, 0x64, 0x03])); // avanzar papel
  if (settings.cut_paper !== false) {
    chunks.push(Buffer.from([0x1d, 0x56, 0x42, 0x00])); // cortar
  }
  return Buffer.concat(chunks);
}

export function printUsb(buffer, device) {
  if (!device) throw new Error('Falta la ruta del dispositivo USB en Configuración.');
  let fd;
  try {
    fd = fs.openSync(device, 'w');
    fs.writeSync(fd, buffer, 0, buffer.length, null);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new Error(
        `No existe ${device}. Verifica que la impresora esté encendida y conectada, o usa el método Navegador/CUPS.`
      );
    }
    if (err.code === 'EACCES') {
      throw new Error(
        `Sin permiso para escribir en ${device}. Ejecuta: sudo usermod -aG lp $USER y vuelve a iniciar sesión.`
      );
    }
    throw new Error(`No se pudo imprimir en ${device}: ${err.message}`);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

export function printTcp(buffer, host, port = 9100, timeoutMs = 5000) {
  if (!host) throw new Error('Falta la IP de la impresora en Configuración.');
  const tcpPort = Number(port) || 9100;
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err) => {
      if (settled) return;
      settled = true;
      if (err) reject(new Error(`No se pudo imprimir en ${host}:${tcpPort}: ${err.message}`));
      else resolve();
    };
    const socket = net.connect(tcpPort, host, () => {
      socket.write(buffer, () => socket.end());
    });
    socket.setTimeout(timeoutMs, () => {
      socket.destroy();
      done(new Error('tiempo de espera agotado'));
    });
    socket.on('close', () => done());
    socket.on('error', (err) => done(err));
  });
}

export async function printText(text, settings) {
  const method = String(settings.print_method || 'usb');
  if (method === 'browser') {
    throw new Error(
      'El método configurado es Navegador/CUPS. Imprime desde la vista previa o cambia a USB directo.'
    );
  }
  const buffer = escposBuffer(text, settings);
  if (method === 'tcp') {
    await printTcp(buffer, settings.print_host, settings.print_port);
    return { method, bytes: buffer.length };
  }
  printUsb(buffer, settings.print_device || '/dev/usb/lp0');
  return { method: 'usb', bytes: buffer.length };
}

export function deviceExists(device) {
  try {
    return Boolean(device) && fs.statSync(device).isCharacterDevice();
  } catch {
    return false;
  }
}
