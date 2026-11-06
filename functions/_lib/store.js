// Leitura das páginas de loja (itch.io e Steam). Só aceita URLs desses dois domínios (anti-SSRF).

import { cleanText, decodeEntities, stripTags } from './util.js';

const UA = 'Mozilla/5.0 (compatible; TheIndieIndexBot/1.0; +https://theindieindex.pages.dev)';
const MAX_HTML = 300_000;

/** Valida e normaliza o link. Retorna { store, url, key } ou null. */
export function parseStoreUrl(raw) {
  let u;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(u.protocol) || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();

  if (host.endsWith('.itch.io') && host !== 'www.itch.io') {
    const m = /^\/([a-z0-9][a-z0-9_-]{0,100})\/?$/i.exec(u.pathname);
    if (!m) return null; // precisa ser a página de um jogo: autor.itch.io/jogo
    const sub = host.slice(0, -'.itch.io'.length);
    if (!/^[a-z0-9][a-z0-9-]*$/.test(sub)) return null;
    const slug = m[1].toLowerCase();
    return { store: 'itch', url: `https://${sub}.itch.io/${slug}`, key: `itch:${sub}/${slug}` };
  }

  if (host === 'store.steampowered.com') {
    const m = /^\/app\/(\d{1,10})(?:\/|$)/.exec(u.pathname);
    if (!m) return null;
    return { store: 'steam', url: `https://store.steampowered.com/app/${m[1]}`, key: `steam:${m[1]}` };
  }
  return null;
}

// Hosts de capa permitidos (evita imagens de rastreamento/arbitrárias no catálogo).
export function isAllowedCover(raw) {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'itch.zone' || h.endsWith('.itch.zone') || h.endsWith('.itch.io') ||
      h.endsWith('.steamstatic.com') || h === 'steamstatic.com';
  } catch {
    return false;
  }
}

async function fetchWithTimeout(url, opts = {}, ms = 9000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ------------------------------- itch.io -------------------------------
function metaTags(head) {
  const out = {};
  for (const m of head.matchAll(/<meta\s[^>]*>/gi)) {
    const tag = m[0];
    const key = /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1];
    const val = /content\s*=\s*"([^"]*)"|content\s*=\s*'([^']*)'/i.exec(tag);
    if (key && val && !(key in out)) out[key.toLowerCase()] = decodeEntities(val[1] ?? val[2] ?? '');
  }
  return out;
}

/** Extrai dados úteis do HTML de uma página de jogo do itch.io. (Exportada para testes.) */
export function parseItchHtml(html) {
  const headEnd = html.indexOf('</head>');
  const head = html.slice(0, headEnd > 0 ? headEnd : 20000);
  const meta = metaTags(head);
  const title = cleanText(meta['og:title'] || stripTags(/<title>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? ''), 140);

  // Painel de informações (Genre, Tags, AI disclosure, etc.)
  const rows = {};
  const pIdx = html.indexOf('game_info_panel_widget');
  if (pIdx >= 0) {
    const panel = html.slice(pIdx, pIdx + 12000);
    const end = panel.indexOf('</table>');
    for (const r of panel.slice(0, end > 0 ? end : undefined).matchAll(/<tr>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<\/tr>/gi)) {
      const k = cleanText(stripTags(r[1]), 40);
      const links = [...r[2].matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi)].map((a) => cleanText(stripTags(a[1]), 40)).filter(Boolean);
      if (k) rows[k] = { text: cleanText(stripTags(r[2]), 300), links };
    }
  }

  const dIdx = html.indexOf('formatted_description');
  const body = dIdx >= 0 ? cleanText(stripTags(html.slice(dIdx, dIdx + 14000)), 2500) : '';

  return {
    title,
    description: cleanText(meta['og:description'] || meta['description'] || '', 400),
    cover: meta['og:image'] || '',
    genres: rows['Genre']?.links ?? [],
    tags: rows['Tags']?.links ?? [],
    fields: Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, v.text])),
    body,
  };
}

async function fetchItch(info) {
  const res = await fetchWithTimeout(info.url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.8' }, redirect: 'follow' });
  if (!res.ok) throw new Error(`itch.io respondeu ${res.status}`);
  const finalHost = new URL(res.url || info.url).hostname;
  if (!finalHost.endsWith('.itch.io')) throw new Error('redirecionamento inesperado');
  const html = (await res.text()).slice(0, MAX_HTML);
  const p = parseItchHtml(html);
  if (!p.title && !p.body) throw new Error('página sem conteúdo reconhecível');
  return { store: 'itch', url: info.url, ...p };
}

// -------------------------------- Steam --------------------------------
async function fetchSteam(info) {
  const id = info.key.split(':')[1];
  const res = await fetchWithTimeout(`https://store.steampowered.com/api/appdetails?appids=${id}&l=english`, { headers: { 'user-agent': UA } });
  if (!res.ok) throw new Error(`Steam respondeu ${res.status}`);
  const data = (await res.json())?.[id];
  if (!data?.success || data.data?.type !== 'game') throw new Error('app da Steam não encontrado ou não é um jogo');
  const d = data.data;
  return {
    store: 'steam',
    url: info.url,
    title: cleanText(d.name, 140),
    description: cleanText(d.short_description, 400),
    cover: d.header_image || '',
    genres: (d.genres || []).map((g) => cleanText(g.description, 40)),
    tags: (d.categories || []).map((g) => cleanText(g.description, 40)),
    fields: {},
    body: cleanText(stripTags(d.about_the_game || ''), 2500),
  };
}

export async function fetchStorePage(info) {
  return info.store === 'itch' ? fetchItch(info) : fetchSteam(info);
}
