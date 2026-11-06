import { $, el, api, safeImg, auth, initAuth, renderGoogleButton, renderUserChip } from './common.js';

const STORE = { itch: 'itch.io', steam: 'Steam' };

async function decide(g, action, row) {
  if (action === 'reject' && !confirm(`Reject and delete "${g.name}"?`)) return;
  row.querySelectorAll('button').forEach((b) => (b.disabled = true));
  try {
    await api(`admin/games/${g.id}/${action}`, { method: 'POST' });
    row.remove();
    if (!$('#list').children.length) $('#gate').replaceChildren(el('p', { class: 'muted', text: 'Nothing waiting for review. 🎉' }));
  } catch (e) {
    alert(e.message);
    row.querySelectorAll('button').forEach((b) => (b.disabled = false));
  }
}

function item(g) {
  const row = el('article', { class: 'admin-item' },
    safeImg(g.cover) ? el('img', { src: safeImg(g.cover), alt: '' }) : el('div'),
    el('div', {},
      el('h3', { text: g.name }),
      el('p', { class: 'meta', text: `${STORE[g.store] || g.store} · by ${g.owner_email} · ${new Date(g.created_at).toLocaleString()}` }),
      el('p', { text: g.description }),
      el('ul', { class: 'tags' }, g.tags.map((t) => el('li', {}, el('span', { class: 'tag', text: t })))),
      el('p', {}, el('a', { class: 'btn-card', href: g.url, target: '_blank', rel: 'noopener noreferrer nofollow', text: `Open on ${STORE[g.store]} →` })),
      el('div', { class: 'admin-actions' },
        el('button', { class: 'btn-submit', type: 'button', text: 'Approve', onclick: () => decide(g, 'approve', row) }),
        el('button', { class: 'btn-secondary', type: 'button', text: 'Reject', onclick: () => decide(g, 'reject', row) }),
      ),
    ),
  );
  return row;
}

async function testAi() {
  const btn = $('#testAi');
  const out = $('#aiResult');
  btn.disabled = true;
  out.replaceChildren(el('p', { class: 'muted', text: 'Testing… (can take a few seconds)' }));
  try {
    const r = await api('admin/test-gemini', { method: 'POST' });
    const summary = r.keysFound === 0
      ? el('p', { class: 'form-error', text: 'No keys found. Check the GEMINI_API_KEYS variable (and redeploy after changing it).' })
      : el('p', { text: `${r.keysFound} key(s) found · models: ${r.models.join(', ')}` });
    const rows = r.results.map((x) => el('li', { class: 'ai-row ' + (x.ok ? 'ok' : 'bad') },
      el('strong', { text: `${x.ok ? '✔' : '✘'} ${x.key} · ${x.model}` }),
      el('span', { class: 'muted', text: x.ok ? ` — OK (${x.ms} ms)` : ` — ${x.error}` }),
    ));
    out.replaceChildren(summary, el('ul', { class: 'ai-results' }, rows));
  } catch (e) {
    out.replaceChildren(el('p', { class: 'form-error', text: e.message }));
  } finally {
    btn.disabled = false;
  }
}
$('#testAi').addEventListener('click', testAi);

async function render() {
  renderUserChip($('#userChip'));
  const gate = $('#gate');
  const list = $('#list');
  list.replaceChildren();
  $('#aiSection').hidden = !auth.user?.isAdmin;
  if (!auth.user) {
    gate.replaceChildren(el('p', { text: 'Sign in with an administrator account.' }), el('div', { id: 'gbtn', class: 'google-btn' }));
    return renderGoogleButton($('#gbtn'));
  }
  if (!auth.user.isAdmin) return gate.replaceChildren(el('p', { class: 'form-error', text: `${auth.user.email} is not an administrator.` }));
  gate.replaceChildren(el('p', { class: 'muted', text: 'Loading…' }));
  try {
    const { games } = await api('admin/pending');
    gate.replaceChildren(games.length ? el('p', { class: 'muted', text: `${games.length} game(s) waiting.` }) : el('p', { class: 'muted', text: 'Nothing waiting for review. 🎉' }));
    list.append(...games.map(item));
  } catch (e) {
    gate.replaceChildren(el('p', { class: 'form-error', text: e.message }));
  }
}

auth.onChange.push(render);
await initAuth();
