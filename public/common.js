// Funções compartilhadas pelo catálogo e pelo painel de admin.
// Regra de ouro: nada de innerHTML com dados vindos de usuários — só textContent via el().

export const $ = (sel, root = document) => root.querySelector(sel);

export function el(tag, props = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null) node.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return node;
}

export async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch('/api/' + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  let data = null;
  try { data = await res.json(); } catch { /* resposta sem JSON */ }
  if (!res.ok) throw Object.assign(new Error(data?.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

// Só aceita imagens do próprio site ou https (a CSP restringe os hosts de fato).
export function safeImg(src) {
  return typeof src === 'string' && (src.startsWith('/api/cover/') || src.startsWith('https://')) ? src : '';
}

// ------------------------------ autenticação ------------------------------
export const auth = { user: null, ready: null, onChange: [] };

function notify() { for (const fn of auth.onChange) fn(auth.user); }

function loadGsi() {
  return new Promise((resolve, reject) => {
    if (window.google?.accounts?.id) return resolve();
    const s = el('script', { src: 'https://accounts.google.com/gsi/client', async: true, defer: true });
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load Google sign-in.'));
    document.head.append(s);
  });
}

export async function initAuth() {
  const me = await api('me').catch(() => ({ user: null }));
  auth.user = me.user;
  notify();
  let gsiReady = null;
  auth.ready = () => (gsiReady ??= (async () => {
    const cfg = await api('config');
    if (!cfg.googleClientId) throw new Error('Google sign-in is not configured yet (GOOGLE_CLIENT_ID).');
    await loadGsi();
    window.google.accounts.id.initialize({
      client_id: cfg.googleClientId,
      auto_select: false,
      callback: async ({ credential }) => {
        try {
          const r = await api('auth/google', { method: 'POST', body: { credential } });
          auth.user = r.user;
        } catch (e) {
          auth.user = null;
          alert(e.message);
        }
        notify();
      },
    });
  })());
}

/** Desenha o botão oficial "Sign in with Google" dentro de `container`. */
export async function renderGoogleButton(container) {
  container.replaceChildren(el('span', { class: 'muted', text: 'Loading sign-in…' }));
  try {
    await auth.ready();
    container.replaceChildren();
    window.google.accounts.id.renderButton(container, { theme: 'filled_blue', size: 'large', shape: 'rectangular', text: 'signin_with', logo_alignment: 'left' });
  } catch (e) {
    container.replaceChildren(el('p', { class: 'form-error', text: e.message }));
  }
}

export async function signOut() {
  await api('auth/logout', { method: 'POST' }).catch(() => {});
  window.google?.accounts?.id?.disableAutoSelect();
  auth.user = null;
  notify();
}

export function renderUserChip(container) {
  container.replaceChildren();
  if (!auth.user) return;
  const u = auth.user;
  container.append(...[
    u.picture ? el('img', { class: 'avatar', src: u.picture, alt: '', referrerpolicy: 'no-referrer' }) : null,
    el('span', { class: 'user-name', text: u.name }),
    el('button', { class: 'link-btn', type: 'button', text: 'Sign out', onclick: signOut }),
  ].filter(Boolean));
}
