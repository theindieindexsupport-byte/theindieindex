// API única do portal (Cloudflare Pages Functions). Roteia /api/*.
// Bindings/variáveis esperados em `env`:
//   DB (D1) · GOOGLE_CLIENT_ID · SESSION_SECRET · GEMINI_API_KEYS · ADMIN_EMAILS
//   opcionais: GEMINI_MODELS · DAILY_ANALYSES_PER_USER · DAILY_SUBMISSIONS_PER_USER · DAILY_ANALYSES_GLOBAL

import {
  HttpError, json, cleanText, cleanTag, cleanTags, escapeLike, signToken, verifyToken, b64u,
} from '../_lib/util.js';
import {
  verifyGoogleCredential, createSessionCookie, clearSessionCookie, getUser, isAdmin, assertSameOrigin,
} from '../_lib/auth.js';
import { parseStoreUrl } from '../_lib/store.js';
import { reviewSubmission, hardBlockReasons } from '../_lib/review.js';
import { testGeminiKeys } from '../_lib/ai.js';

const PAGE_SIZE = 24;
const TICKET_TTL = 30 * 60;

// ----------------------------- helpers -----------------------------
const today = () => new Date().toISOString().slice(0, 10);
const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);

async function readJson(request) {
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw new HttpError(415, 'JSON expected.');
  const raw = await request.text();
  if (raw.length > 400_000) throw new HttpError(413, 'Payload too large.');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Invalid JSON.');
  }
}

function requireUser(user) {
  if (!user) throw new HttpError(401, 'Please sign in first.');
  return user;
}

/** Incrementa um contador diário e devolve o novo valor. */
async function bump(env, sub, column) {
  const col = column === 'analyses' ? 'analyses' : 'submissions';
  const row = await env.DB.prepare(
    `INSERT INTO usage(user_sub, day, ${col}) VALUES(?, ?, 1)
     ON CONFLICT(user_sub, day) DO UPDATE SET ${col} = ${col} + 1 RETURNING ${col} AS n`,
  ).bind(sub, today()).first();
  return row.n;
}
async function peek(env, sub, column) {
  const col = column === 'analyses' ? 'analyses' : 'submissions';
  const row = await env.DB.prepare(`SELECT ${col} AS n FROM usage WHERE user_sub = ? AND day = ?`).bind(sub, today()).first();
  return row?.n ?? 0;
}

function publicGame(row, viewer) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    cover: row.has_cover_data ? `/api/cover/${row.id}` : row.cover_url || '',
    store: row.store,
    url: row.store_url,
    tags: JSON.parse(row.tags || '[]'),
    status: row.status,
    ...(viewer ? { source: row.source, owner_email: viewer.admin ? row.owner_email : undefined } : {}),
    created_at: row.created_at,
  };
}
const GAME_COLS = `id, name, description, cover_url, store, store_url, tags, status, source, owner_email, created_at,
  CASE WHEN cover_data IS NOT NULL AND cover_data != '' THEN 1 ELSE 0 END AS has_cover_data`;

// Cache de borda (reduz leituras no D1). Ignorado fora do Cloudflare.
async function cached(request, ttl, produce) {
  const cache = globalThis.caches?.default;
  const key = new Request(request.url, { method: 'GET' });
  if (cache) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  const res = await produce();
  if (cache && res.status === 200) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set('cache-control', `public, max-age=${ttl}`);
    await cache.put(key, copy.clone());
    return copy;
  }
  return res;
}

// ------------------------------ rotas ------------------------------
async function listGames(request, env) {
  const url = new URL(request.url);
  const q = cleanText(url.searchParams.get('q'), 60).toLowerCase();
  const tag = cleanTag(url.searchParams.get('tag') || '');
  const offset = Math.max(0, Math.min(5000, parseInt(url.searchParams.get('offset') || '0', 10) || 0));
  const order = url.searchParams.get('sort') === 'az' ? 'name COLLATE NOCASE ASC' : 'created_at DESC, id DESC';

  const where = ["status = 'approved'"];
  const binds = [];
  if (q) {
    const p = '%' + escapeLike(q) + '%';
    where.push("(name LIKE ? ESCAPE '\\' OR description LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')");
    binds.push(p, p, p);
  }
  if (tag) {
    where.push("tags LIKE ? ESCAPE '\\'");
    binds.push('%"' + escapeLike(tag) + '"%');
  }
  const W = where.join(' AND ');
  const total = (await env.DB.prepare(`SELECT COUNT(*) AS n FROM games WHERE ${W}`).bind(...binds).first()).n;
  const { results } = await env.DB.prepare(`SELECT ${GAME_COLS} FROM games WHERE ${W} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .bind(...binds, PAGE_SIZE, offset).all();
  return json({ games: results.map((r) => publicGame(r)), total, hasMore: offset + results.length < total }, 200);
}

async function listTags(env) {
  const { results } = await env.DB.prepare("SELECT tags FROM games WHERE status = 'approved'").all();
  const counts = new Map();
  for (const r of results) for (const t of JSON.parse(r.tags || '[]')) counts.set(t, (counts.get(t) || 0) + 1);
  const tags = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 30).map(([tag, count]) => ({ tag, count }));
  return json({ tags });
}

async function serveCover(env, user, id) {
  const row = await env.DB.prepare('SELECT cover_data, status, owner_sub FROM games WHERE id = ?').bind(id).first();
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(row?.cover_data || '');
  if (!m) throw new HttpError(404, 'Not found.');
  const visible = row.status === 'approved' || (user && (user.sub === row.owner_sub || isAdmin(env, user)));
  if (!visible) throw new HttpError(404, 'Not found.');
  const bytes = Uint8Array.from(atob(m[2]), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'content-type': m[1],
      'x-content-type-options': 'nosniff',
      'cache-control': row.status === 'approved' ? 'public, max-age=86400' : 'private, no-store',
    },
  });
}

async function authGoogle(request, env) {
  const { credential } = await readJson(request);
  const user = await verifyGoogleCredential(env, credential);
  if (!user) throw new HttpError(401, 'Google sign-in could not be verified.');
  const cookie = await createSessionCookie(env, user, request);
  return json({ user: { ...user, isAdmin: isAdmin(env, user) } }, 200, { 'set-cookie': cookie });
}

async function analyze(request, env, user) {
  requireUser(user);
  const body = await readJson(request);
  const name = cleanText(body.name, 80);
  if (name.length < 2) throw new HttpError(400, 'Please type the game name.');
  const store = parseStoreUrl(body.url);
  if (!store) throw new HttpError(400, 'Use a game page link from itch.io (author.itch.io/game) or Steam (store.steampowered.com/app/ID).');

  const dup = await env.DB.prepare('SELECT status FROM games WHERE url_key = ?').bind(store.key).first();
  if (dup) throw new HttpError(409, dup.status === 'approved' ? 'This game is already in the catalog.' : 'This game was already submitted and is waiting for review.');

  const perUser = num(env.DAILY_ANALYSES_PER_USER, 15);
  const global = num(env.DAILY_ANALYSES_GLOBAL, 300);
  if ((await bump(env, user.sub, 'analyses')) > perUser) throw new HttpError(429, 'Daily analysis limit reached. Try again tomorrow, or fill in the details manually.', { manual: true });

  // Cota global: se estourar, manda direto para o formulário manual (sem gastar IA).
  if ((await bump(env, '_global', 'analyses')) > global) return json({ status: 'unavailable', why: 'quota' });

  const result = await reviewSubmission(env, name, store);
  if (result.status === 'unavailable') {
    console.error('Review unavailable:', result.why, result.detail);
    return json({ status: 'unavailable', why: result.why });
  }
  if (result.status !== 'approved') return json(result);

  // Ticket assinado: prova que ESTES dados foram aprovados pela IA para ESTE usuário.
  const ticket = await signToken(env.SESSION_SECRET, 'ticket', { u: user.sub, g: result.game }, TICKET_TTL);
  const { url_key, ...game } = result.game;
  return json({ status: 'approved', game, ticket });
}

const COVER_MAGIC = [
  ['image/webp', (b) => b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
];
function validateCoverData(dataUrl) {
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl || '');
  if (!m || dataUrl.length > 260_000) throw new HttpError(400, 'Cover image is invalid or too large (max ~190 KB).');
  const head = Uint8Array.from(atob(m[2].slice(0, 24)), (c) => c.charCodeAt(0));
  const ok = COVER_MAGIC.some(([type, test]) => type === m[1] && test(head));
  if (!ok) throw new HttpError(400, 'Cover image is not a valid image file.');
  return dataUrl;
}

async function insertGame(env, user, g, status, source) {
  try {
    const r = await env.DB.prepare(
      `INSERT INTO games(name, description, cover_url, cover_data, store, store_url, url_key, tags, status, source, owner_sub, owner_email, created_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(g.name, g.description, g.cover_url || null, g.cover_data || null, g.store, g.store_url, g.url_key,
      JSON.stringify(g.tags), status, source, user.sub, user.email, Date.now()).run();
    return r.meta.last_row_id;
  } catch (e) {
    if (/UNIQUE/i.test(String(e.message))) throw new HttpError(409, 'This game is already in the catalog.');
    throw e;
  }
}

async function submit(request, env, user) {
  requireUser(user);
  const body = await readJson(request);
  const limit = num(env.DAILY_SUBMISSIONS_PER_USER, 5);
  if ((await peek(env, user.sub, 'submissions')) >= limit && !isAdmin(env, user)) throw new HttpError(429, 'Daily submission limit reached.');

  let game, status, source;
  if (body.ticket) {
    const t = await verifyToken(env.SESSION_SECRET, 'ticket', body.ticket);
    if (!t || t.u !== user.sub) throw new HttpError(400, 'The analysis expired. Please analyze the game again.');
    game = t.g;
    status = 'approved';
    source = 'ai';
  } else if (body.manual) {
    const m = body.manual;
    const store = parseStoreUrl(m.url);
    if (!store) throw new HttpError(400, 'Use a game page link from itch.io or Steam.');
    game = {
      name: cleanText(m.name, 80),
      description: cleanText(m.description, 200),
      tags: cleanTags(m.tags),
      cover_data: validateCoverData(m.cover_data),
      store: store.store, store_url: store.url, url_key: store.key,
    };
    if (game.name.length < 2) throw new HttpError(400, 'Please type the game name.');
    if (game.description.length < 10) throw new HttpError(400, 'Description must have at least 10 characters.');
    if (game.tags.length < 1) throw new HttpError(400, 'Add at least one tag.');
    const blocked = hardBlockReasons(game);
    if (blocked.length) return json({ status: 'rejected', reasons: blocked }, 422);
    status = 'pending'; // sem IA: um admin precisa aprovar
    source = 'manual';
  } else {
    throw new HttpError(400, 'Nothing to submit.');
  }

  const id = await insertGame(env, user, game, status, source);
  await bump(env, user.sub, 'submissions');
  return json({ ok: true, id, status });
}

async function myGames(env, user) {
  requireUser(user);
  const { results } = await env.DB.prepare(`SELECT ${GAME_COLS} FROM games WHERE owner_sub = ? ORDER BY created_at DESC LIMIT 50`).bind(user.sub).all();
  return json({ games: results.map((r) => publicGame(r, { admin: false })) });
}

async function deleteGame(env, user, id) {
  requireUser(user);
  const row = await env.DB.prepare('SELECT owner_sub FROM games WHERE id = ?').bind(id).first();
  if (!row) throw new HttpError(404, 'Not found.');
  if (row.owner_sub !== user.sub && !isAdmin(env, user)) throw new HttpError(403, 'Not allowed.');
  await env.DB.prepare('DELETE FROM games WHERE id = ?').bind(id).run();
  return json({ ok: true });
}

async function adminPending(env, user) {
  requireUser(user);
  if (!isAdmin(env, user)) throw new HttpError(403, 'Admins only.');
  const { results } = await env.DB.prepare(`SELECT ${GAME_COLS} FROM games WHERE status = 'pending' ORDER BY created_at ASC LIMIT 100`).all();
  return json({ games: results.map((r) => publicGame(r, { admin: true })) });
}

async function adminTestGemini(env, user) {
  requireUser(user);
  if (!isAdmin(env, user)) throw new HttpError(403, 'Admins only.');
  return json(await testGeminiKeys(env));
}

async function adminDecide(env, user, id, action) {
  requireUser(user);
  if (!isAdmin(env, user)) throw new HttpError(403, 'Admins only.');
  if (action === 'reject') await env.DB.prepare('DELETE FROM games WHERE id = ? AND status = ?').bind(id, 'pending').run();
  else await env.DB.prepare("UPDATE games SET status = 'approved' WHERE id = ? AND status = 'pending'").bind(id).run();
  return json({ ok: true });
}

// ------------------------------ roteador ------------------------------
export async function onRequest({ request, env, params }) {
  try {
    if (!env.DB) throw new HttpError(500, 'Server misconfigured: D1 binding "DB" is missing.');
    assertSameOrigin(request);
    const seg = [].concat(params.route ?? []);
    const method = request.method;
    const [a, b, c] = seg;
    const user = await getUser(request, env);
    const id = (s) => (/^\d{1,12}$/.test(s || '') ? Number(s) : (() => { throw new HttpError(404, 'Not found.'); })());

    if (a === 'config' && method === 'GET') return json({ googleClientId: env.GOOGLE_CLIENT_ID || '' });
    if (a === 'me' && method === 'GET') return json({ user: user ? { ...user, isAdmin: isAdmin(env, user) } : null });
    if (a === 'auth' && b === 'google' && method === 'POST') return await authGoogle(request, env);
    if (a === 'auth' && b === 'logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });

    if (a === 'games' && !b && method === 'GET') return await cached(request, 30, () => listGames(request, env));
    if (a === 'tags' && method === 'GET') return await cached(request, 300, () => listTags(env));
    if (a === 'cover' && b && method === 'GET') return await serveCover(env, user, id(b));

    if (a === 'analyze' && method === 'POST') return await analyze(request, env, user);
    if (a === 'submit' && method === 'POST') return await submit(request, env, user);
    if (a === 'my' && b === 'games' && method === 'GET') return await myGames(env, user);
    if (a === 'games' && b && !c && method === 'DELETE') return await deleteGame(env, user, id(b));

    if (a === 'admin' && b === 'pending' && method === 'GET') return await adminPending(env, user);
    if (a === 'admin' && b === 'games' && c && seg[3] && method === 'POST' && ['approve', 'reject'].includes(seg[3])) return await adminDecide(env, user, id(c), seg[3]);

    if (a === 'admin' && b === 'test-gemini' && method === 'POST') return await adminTestGemini(env, user);

    throw new HttpError(404, 'Not found.');
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message, ...e.extra }, e.status);
    console.error('API error', e);
    return json({ error: 'Internal error.' }, 500);
  }
}
