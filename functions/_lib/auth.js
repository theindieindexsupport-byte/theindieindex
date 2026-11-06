// Login com Google (Google Identity Services) + sessão própria assinada em cookie HttpOnly.

import { HttpError, cleanText, parseCookies, signToken, verifyToken } from './util.js';

export const COOKIE = 'ii_session';
const SESSION_TTL = 7 * 24 * 3600;

/** Valida o ID token do Google no servidor. Retorna o usuário ou null. */
export async function verifyGoogleCredential(env, credential) {
  if (!env.GOOGLE_CLIENT_ID) throw new HttpError(500, 'Server misconfigured: GOOGLE_CLIENT_ID is missing.');
  if (typeof credential !== 'string' || credential.length > 4000) return null;
  let t;
  try {
    const r = await fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(credential));
    if (!r.ok) return null;
    t = await r.json();
  } catch {
    return null;
  }
  if (t.aud !== env.GOOGLE_CLIENT_ID) return null;
  if (!['accounts.google.com', 'https://accounts.google.com'].includes(t.iss)) return null;
  if (String(t.email_verified) !== 'true' || !t.email || !t.sub) return null;
  if (!(Number(t.exp) > Date.now() / 1000)) return null;
  const picture = typeof t.picture === 'string' && t.picture.startsWith('https://lh3.googleusercontent.com/') ? t.picture : '';
  return { sub: String(t.sub), email: String(t.email).toLowerCase(), name: cleanText(t.name || String(t.email).split('@')[0], 60), picture };
}

export async function createSessionCookie(env, user, request) {
  const token = await signToken(env.SESSION_SECRET, 'session', user, SESSION_TTL);
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}${secure}`;
}

export function clearSessionCookie() {
  return `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

export async function getUser(request, env) {
  const token = parseCookies(request.headers.get('cookie'))[COOKIE];
  if (!token) return null;
  const s = await verifyToken(env.SESSION_SECRET, 'session', token);
  if (!s) return null;
  return { sub: s.sub, email: s.email, name: s.name, picture: s.picture || '' };
}

export function isAdmin(env, user) {
  if (!user) return false;
  return String(env.ADMIN_EMAILS || '').toLowerCase().split(/[\s,]+/).filter(Boolean).includes(user.email);
}

/** Proteção CSRF: requisições que alteram dados precisam vir do próprio site. */
export function assertSameOrigin(request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return;
  const origin = request.headers.get('origin');
  const self = new URL(request.url).origin;
  const site = request.headers.get('sec-fetch-site');
  if (origin ? origin !== self : !(site === 'same-origin' || site === 'none')) throw new HttpError(403, 'Cross-site request blocked.');
}
