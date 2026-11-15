/* =========================================================
   MOSTRADOR · Worker de Cloudflare
   - /api/*   -> API portable sobre D1
   - páginas  -> Static Assets, con acceso privado
   ========================================================= */

import { createD1Db } from './db.d1.js';
import { handleApi } from './app.js';
import { sessionTokenFrom, verifySession } from './auth.js';

const MAX_BODY = 2 * 1024 * 1024;
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()'
};

function errorResponse(status, message) {
  return new Response(message, {
    status,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY_HEADERS }
  });
}

async function hasSession(request, env) {
  const token = sessionTokenFrom(request.headers);
  return Boolean(await verifySession(env.AUTH_SECRET, token));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (!env.AUTH_SECRET) {
      return errorResponse(
        503,
        'Falta el secreto AUTH_SECRET. Configúralo con: wrangler secret put AUTH_SECRET'
      );
    }

    if (url.pathname.startsWith('/api/')) {
      let body = {};
      if (['POST', 'PUT', 'PATCH'].includes(request.method)) {
        const declared = Number(request.headers.get('content-length') || 0);
        if (declared > MAX_BODY) return errorResponse(413, 'La petición es demasiado grande.');
        const raw = await request.text();
        if (raw.length > MAX_BODY) return errorResponse(413, 'La petición es demasiado grande.');
        if (raw) {
          try {
            body = JSON.parse(raw);
          } catch {
            return errorResponse(400, 'JSON inválido.');
          }
        }
      }

      const db = createD1Db(env.DB);
      const result = await handleApi({
        db,
        env,
        method: request.method,
        pathname: url.pathname,
        params: url.searchParams,
        body,
        headers: request.headers,
        ip: request.headers.get('cf-connecting-ip') || 'desconocida',
        secure: true
      });

      return new Response(result.body, {
        status: result.status,
        headers: {
          'Content-Type': result.contentType,
          'Cache-Control': 'no-store',
          ...SECURITY_HEADERS,
          ...result.headers
        }
      });
    }

    /* Páginas privadas: sin sesión se va al login. */
    if (url.pathname === '/' || url.pathname === '/index.html') {
      if (!(await hasSession(request, env))) {
        return Response.redirect(new URL('/login', url).toString(), 302);
      }
    }

    const asset = await env.ASSETS.fetch(request);
    const headers = new Headers(asset.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
    const ext = url.pathname.split('.').pop()?.toLowerCase();
    if (!ext || ['html', 'js', 'css'].includes(ext)) headers.set('Cache-Control', 'no-cache');
    return new Response(asset.body, { status: asset.status, headers });
  }
};
