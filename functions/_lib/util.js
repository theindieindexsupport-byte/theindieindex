// Utilitários compartilhados: respostas JSON, tokens assinados (HMAC) e sanitização.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const b64u = {
  enc(bytes) {
    let s = '';
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  dec(str) {
    str = str.replace(/-/g, '+').replace(/_/g, '/');
    while (str.length % 4) str += '=';
    return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
  },
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

async function hmacKey(secret) {
  if (!secret || secret.length < 16) throw new HttpError(500, 'Server misconfigured: SESSION_SECRET is missing or too short.');
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

/** Cria um token "payload.assinatura". `purpose` impede reuso entre sessão e ticket. */
export async function signToken(secret, purpose, payload, ttlSec) {
  const body = { ...payload, p: purpose, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const data = b64u.enc(enc.encode(JSON.stringify(body)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return data + '.' + b64u.enc(new Uint8Array(sig));
}

export async function verifyToken(secret, purpose, token) {
  if (typeof token !== 'string' || token.length > 8000) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), b64u.dec(sig), enc.encode(data));
  } catch (e) {
    if (e instanceof HttpError) throw e;
    return null;
  }
  if (!ok) return null;
  let body;
  try {
    body = JSON.parse(dec.decode(b64u.dec(data)));
  } catch {
    return null;
  }
  if (body.p !== purpose || !(body.exp > Date.now() / 1000)) return null;
  return body;
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

// ---------- sanitização ----------
export function cleanText(s, max = 200) {
  return String(s ?? '')
    .replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function cleanTag(s) {
  return cleanText(s, 24)
    .toLowerCase()
    .replace(/[^\p{L}\p{N} -]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function cleanTags(list, max = 6) {
  const seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const c = cleanTag(t);
    if (c.length >= 2) seen.add(c);
    if (seen.size >= max) break;
  }
  return [...seen];
}

export function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m);
}
function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return ' ';
  }
}
export function stripTags(html) {
  return decodeEntities(String(html).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}
