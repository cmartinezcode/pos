/* =========================================================
   MOSTRADOR · servidor local de desarrollo
   Usa exactamente la misma API portable que Cloudflare.
   No es necesario para producción (allí corre src/worker.js).
   ========================================================= */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

import { SCHEMA_SQL } from './db.js';
import { createNodeDb } from './src/db.node.js';
import { handleApi } from './src/app.js';
import { verifySession } from './src/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'mostrador.db');
const HOST = process.env.HOST || '127.0.0.1';
const BASE_PORT = Number(process.env.PORT) || 3000;
const MAX_BODY = 2 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = createNodeDb(DB_PATH);
await upgradeExistingTables();
await db.exec(SCHEMA_SQL);

/** Añade columnas nuevas a bases locales creadas antes de la migración. */
async function upgradeExistingTables() {
  const wanted = {
    sales: { request_id: 'TEXT' },
    quotes: { request_id: 'TEXT' }
  };
  for (const [table, columns] of Object.entries(wanted)) {
    const exists = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", [table]);
    if (!exists) continue;
    const info = await db.all(`PRAGMA table_info(${table})`);
    const have = new Set(info.map((c) => c.name));
    for (const [name, type] of Object.entries(columns)) {
      if (!have.has(name)) await db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    }
  }
}

const env = {
  AUTH_SECRET: process.env.AUTH_SECRET || '',
  INITIAL_PASSWORD: process.env.INITIAL_PASSWORD || '',
  AUTH_ITERATIONS: process.env.AUTH_ITERATIONS || '',
  COOKIE_SECURE: process.env.AUTH_SECRET ? '0' : '0'
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json'
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('La petición es demasiado grande.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const err = new Error('JSON inválido.');
    err.status = 400;
    throw err;
  }
}

function send(res, result) {
  const headers = { 'Content-Type': result.contentType, ...result.headers };
  res.writeHead(result.status, headers);
  res.end(result.body);
}

function sendFile(res, filePath) {
  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No encontrado');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': 'no-cache'
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

async function isLoggedIn(req) {
  if (!env.AUTH_SECRET) return true;
  const cookie = req.headers.cookie || '';
  const token = cookie
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith('mostrador_session='))
    ?.slice('mostrador_session='.length);
  return Boolean(await verifySession(env.AUTH_SECRET, token));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method || '') ? await readJson(req) : {};
      const result = await handleApi({
        db,
        env,
        method: req.method || 'GET',
        pathname: url.pathname,
        params: url.searchParams,
        body,
        headers: req.headers,
        ip: req.socket.remoteAddress || 'local',
        secure: false
      });
      return send(res, result);
    }

    let pathname = decodeURIComponent(url.pathname);
    if (pathname === '/') pathname = '/index.html';
    if (pathname === '/login') pathname = '/login.html';

    /* En modo con clave, protege también las páginas. */
    if (env.AUTH_SECRET && (pathname === '/index.html' || pathname === '/')) {
      if (!(await isLoggedIn(req))) {
        res.writeHead(302, { Location: '/login.html' });
        return res.end();
      }
    }

    const filePath = path.join(PUBLIC_DIR, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ''));
    if (!filePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Prohibido');
    }
    return sendFile(res, filePath);
  } catch (err) {
    const status = Number(err.status) || 500;
    if (status >= 500) console.error(err);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message || 'Error interno.' }));
  }
});

function lanIP() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return null;
}

function start(port, attempt = 0) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && attempt < 8) {
      start(port + 1, attempt + 1);
      return;
    }
    console.error('No se pudo iniciar el servidor:', err.message);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const ip = lanIP();
    console.log('');
    console.log('  ▣  MOSTRADOR POS · 80 mm (modo local)');
    console.log(`  Local      >  http://localhost:${port}`);
    if (HOST === '0.0.0.0' && ip) console.log(`  En la red  >  http://${ip}:${port}`);
    console.log(`  Datos      >  ${DB_PATH}`);
    console.log(`  Impresión  >  navegador / PDF`);
    if (env.AUTH_SECRET) console.log('  Acceso     >  protegido con clave');
    console.log('');
  });
}

process.on('SIGINT', () => {
  server.close(() => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
  });
});

start(BASE_PORT);
