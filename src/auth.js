/* =========================================================
   MOSTRADOR · autenticación portable (Web Crypto)
   Funciona igual en Workers y en Node (>= 20).
   ========================================================= */

import { ApiError } from './errors.js';
import { getAuthRow, saveAuthRow } from './store.js';

const COOKIE = 'mostrador_session';
const SESSION_TTL = 60 * 60 * 24 * 30; // 30 días
const MAX_FAILURES = 8;
const WINDOW_MS = 15 * 60 * 1000;
const CLEAN_MS = 7 * 24 * 60 * 60 * 1000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/* ---------------- base64url ---------------- */

export function toB64url(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64url(value) {
  const s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n) {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/** Comparación en tiempo constante sobre cadenas ya codificadas. */
export function safeEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  let diff = left.length ^ right.length;
  const len = Math.max(left.length, right.length);
  for (let i = 0; i < len; i++) {
    diff |= (left.charCodeAt(i) || 0) ^ (right.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/* ---------------- contraseña ---------------- */

export async function hashPassword(password, iterations = 10000, saltInput = null) {
  const iter = Math.max(1000, Number(iterations) || 10000);
  const salt = saltInput ? fromB64url(saltInput) : randomBytes(16);
  const key = await crypto.subtle.importKey('raw', encoder.encode(String(password)), 'PBKDF2', false, [
    'deriveBits'
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' },
    key,
    256
  );
  return {
    algo: 'pbkdf2-sha256',
    iter,
    salt: toB64url(salt),
    hash: toB64url(new Uint8Array(bits))
  };
}

export async function verifyPassword(record, password) {
  if (!record?.salt || !record?.hash) return false;
  const test = await hashPassword(password, record.iter || 10000, record.salt);
  return safeEqual(test.hash, record.hash);
}

/** Crea la clave inicial si aún no existe (solo la primera vez). */
export async function ensureAuth(db, env = {}) {
  const existing = await getAuthRow(db);
  if (existing?.hash) return existing;
  const password = String(env.INITIAL_PASSWORD || '');
  if (password.length < 8) {
    throw new ApiError(
      503,
      'Falta configurar la clave inicial del panel (secreto INITIAL_PASSWORD, mínimo 8 caracteres).'
    );
  }
  const record = await hashPassword(password, Number(env.AUTH_ITERATIONS) || 10000);
  await saveAuthRow(db, record);
  return record;
}

export async function changePassword(db, currentPassword, nextPassword, env = {}) {
  const record = await ensureAuth(db, env);
  if (!(await verifyPassword(record, currentPassword))) {
    throw new ApiError(401, 'La clave actual no es correcta.');
  }
  const next = String(nextPassword || '');
  if (next.length < 8) throw new ApiError(400, 'La nueva clave debe tener al menos 8 caracteres.');
  const updated = await hashPassword(next, Number(env.AUTH_ITERATIONS) || 10000);
  await saveAuthRow(db, updated);
  return true;
}

/* ---------------- sesión firmada (HMAC) ---------------- */

async function sign(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(String(secret)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(String(data)));
  return toB64url(new Uint8Array(sig));
}

export async function signSession(secret, { ttl = SESSION_TTL, now = Date.now() } = {}) {
  const payload = toB64url(
    encoder.encode(JSON.stringify({ sub: 'admin', iat: now, exp: now + ttl * 1000 }))
  );
  return `${payload}.${await sign(secret, payload)}`;
}

export async function verifySession(secret, token, now = Date.now()) {
  if (!token || !secret) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = await sign(secret, payload);
  if (!safeEqual(signature, expected)) return null;
  try {
    const data = JSON.parse(decoder.decode(fromB64url(payload)));
    if (!data?.exp || Number(data.exp) < now) return null;
    return data;
  } catch {
    return null;
  }
}

/* ---------------- cookies ---------------- */

export function parseCookies(header) {
  const out = {};
  const raw = String(header || '');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

export function sessionCookie(token, { secure = true, ttl = SESSION_TTL } = {}) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttl}${
    secure ? '; Secure' : ''
  }`;
}

export function clearCookie({ secure = true } = {}) {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure ? '; Secure' : ''}`;
}

export function sessionTokenFrom(headers) {
  return parseCookies(headers?.get ? headers.get('cookie') : headers?.cookie)?.[COOKIE] || '';
}

/* ---------------- límite de intentos ---------------- */

export async function isRateLimited(db, ip) {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const row = await db.get('SELECT COUNT(*) AS c FROM login_attempts WHERE ip = ? AND at >= ?', [
    ip,
    since
  ]);
  return Number(row?.c || 0) >= MAX_FAILURES;
}

export async function recordFailure(db, ip) {
  const now = new Date();
  await db.run('INSERT INTO login_attempts (ip, at) VALUES (?, ?)', [ip, now.toISOString()]);
  await db.run('DELETE FROM login_attempts WHERE at < ?', [
    new Date(now.getTime() - CLEAN_MS).toISOString()
  ]);
}

export async function clearFailures(db, ip) {
  await db.run('DELETE FROM login_attempts WHERE ip = ?', [ip]);
}

export { COOKIE, SESSION_TTL, MAX_FAILURES };
