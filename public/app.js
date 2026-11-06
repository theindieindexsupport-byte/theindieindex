import { $, el, api, safeImg, auth, initAuth, renderGoogleButton, renderUserChip } from './common.js';

// ============================ catálogo ============================
const state = { q: '', tag: '', sort: 'new', offset: 0, loading: false };
const grid = $('#grid');

const STORE_LABEL = { itch: 'itch.io', steam: 'Steam' };

export function gameCard(g, { preview = false } = {}) {
  const cover = safeImg(g.cover);
  const link = preview ? { href: '#', onclick: (e) => e.preventDefault() } : { href: g.url, target: '_blank', rel: 'noopener noreferrer nofollow' };
  const isAdmin = !preview && auth.user?.isAdmin;
  return el('article', { class: 'game-card' },
    el('a', { class: 'cover', ...link, 'aria-label': `${g.name} on ${STORE_LABEL[g.store]}` },
      cover ? el('img', { src: cover, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : el('div', { class: 'cover-fallback', text: g.name.slice(0, 1).toUpperCase() }),
    ),
    el('div', { class: 'card-body' },
      el('span', { class: 'store-badge', text: STORE_LABEL[g.store] || g.store }),
      el('h3', { text: g.name }),
      el('p', { class: 'card-desc', text: g.description }),
      el('ul', { class: 'tags' }, g.tags.map((t) => el('li', {}, el('button', { type: 'button', class: 'tag', text: t, onclick: () => !preview && setTag(t) })))),
      el('div', { class: 'card-actions' },
        el('a', { class: 'btn-card', ...link, text: `View on ${STORE_LABEL[g.store]} →` }),
        isAdmin ? el('button', { class: 'link-btn danger', type: 'button', text: 'Remove', onclick: () => removeGame(g) }) : null,
      ),
    ),
  );
}

async function removeGame(g) {
  if (!confirm(`Remove "${g.name}" from the catalog?`)) return;
  try { await api(`games/${g.id}`, { method: 'DELETE' }); loadGames(true); loadTags(); } catch (e) { alert(e.message); }
}

async function loadGames(reset = false) {
  if (state.loading) return;
  state.loading = true;
  if (reset) { state.offset = 0; grid.replaceChildren(); }
  const params = new URLSearchParams({ sort: state.sort, offset: String(state.offset) });
  if (state.q) params.set('q', state.q);
  if (state.tag) params.set('tag', state.tag);
  try {
    const data = await api('games?' + params);
    grid.append(...data.games.map((g) => gameCard(g)));
    state.offset += data.games.length;
    $('#loadMore').hidden = !data.hasMore;
    $('#emptyState').hidden = data.total > 0;
    const filtered = state.q || state.tag;
    $('#resultInfo').textContent = data.total === 0 ? (filtered ? 'No games match your search.' : '') : `${data.total} game${data.total === 1 ? '' : 's'}${filtered ? ' found' : ''}`;
    if (data.total === 0 && filtered) $('#emptyState').hidden = true;
  } catch (e) {
    $('#resultInfo').textContent = 'Could not load games. Please try again in a moment.';
  } finally {
    state.loading = false;
  }
}

async function loadTags() {
  try {
    const { tags } = await api('tags');
    const bar = $('#tagBar');
    bar.replaceChildren(
      el('button', { type: 'button', class: 'chip' + (state.tag ? '' : ' active'), text: 'All', onclick: () => setTag('') }),
      ...tags.slice(0, 16).map(({ tag, count }) =>
        el('button', { type: 'button', class: 'chip' + (state.tag === tag ? ' active' : ''), onclick: () => setTag(tag) }, tag, el('span', { class: 'chip-count', text: String(count) }))),
    );
  } catch { /* barra de tags é opcional */ }
}

function setTag(tag) {
  state.tag = state.tag === tag ? '' : tag;
  loadTags();
  loadGames(true);
  $('#catalog').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  state.q = $('#searchInput').value.trim();
  loadGames(true);
  $('#catalog').scrollIntoView({ behavior: 'smooth' });
});
$('#sortSelect').addEventListener('change', (e) => { state.sort = e.target.value; loadGames(true); });
$('#loadMore').addEventListener('click', () => loadGames());

// ============================ envio de jogo ============================
const dlg = $('#submitDialog');
const STEPS = ['stepSignin', 'stepForm', 'stepWorking', 'stepApproved', 'stepRejected', 'stepManual', 'stepDone'];
let pending = { name: '', url: '', ticket: '' };

function show(step) {
  for (const id of STEPS) $('#' + id).hidden = id !== step;
}
function setError(id, msg) {
  const n = $('#' + id);
  n.textContent = msg || '';
  n.hidden = !msg;
}

function openSubmit() {
  if (!dlg.open) dlg.showModal();
  routeSubmit();
}
function routeSubmit() {
  if (!auth.user) {
    show('stepSignin');
    renderGoogleButton($('#googleBtn'));
  } else {
    show('stepForm');
    setError('formError', '');
    loadMyGames();
  }
}

$('#openSubmit').addEventListener('click', openSubmit);
document.addEventListener('click', (e) => { if (e.target.closest('[data-open-submit]')) openSubmit(); });
$('#closeSubmit').addEventListener('click', () => dlg.close());
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
dlg.addEventListener('click', (e) => { if (e.target.closest('[data-back]')) routeSubmit(); });
$('#doneBtn').addEventListener('click', () => dlg.close());

auth.onChange.push((user) => {
  renderUserChip($('#userChip'));
  if (dlg.open) routeSubmit();
  loadGames(true); // admins passam a ver o botão "Remove"
});

async function loadMyGames() {
  try {
    const { games } = await api('my/games');
    const box = $('#myGames');
    box.hidden = games.length === 0;
    const label = { approved: 'Published', pending: 'Waiting for review' };
    $('#myGamesList').replaceChildren(...games.map((g) => el('li', {},
      el('span', { class: 'my-name', text: g.name }),
      el('span', { class: 'status status-' + g.status, text: label[g.status] || g.status }),
      el('button', { class: 'link-btn danger', type: 'button', text: 'Delete', onclick: async () => {
        if (!confirm(`Delete "${g.name}"?`)) return;
        await api(`games/${g.id}`, { method: 'DELETE' }).catch((e) => alert(e.message));
        loadMyGames(); loadGames(true); loadTags();
      } }),
    )));
  } catch { /* lista é opcional */ }
}

function startManual(intro) {
  $('#manualIntro').textContent = intro;
  setError('manualError', '');
  show('stepManual');
}

$('#analyzeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#gName').value.trim();
  const url = $('#gUrl').value.trim();
  if (name.length < 2) return setError('formError', 'Please type the game name.');
  if (!/^https?:\/\//i.test(url)) return setError('formError', 'Please paste the full link to your game page.');
  setError('formError', '');
  pending = { name, url, ticket: '' };
  show('stepWorking');
  const slow = setTimeout(() => { $('#workingText').textContent = 'Still working — the review can take up to 30 seconds…'; }, 8000);
  try {
    const r = await api('analyze', { method: 'POST', body: { name, url } });
    if (r.status === 'approved') {
      pending.ticket = r.ticket;
      $('#previewSlot').replaceChildren(gameCard(r.game, { preview: true }));
      setError('publishError', '');
      show('stepApproved');
    } else if (r.status === 'rejected') {
      $('#rejectReasons').replaceChildren(...r.reasons.map((t) => el('li', { text: t })));
      show('stepRejected');
    } else {
      const why = {
        store: "We couldn't read that store page automatically.",
        ai: 'Our automatic review is unavailable right now.',
        quota: "We've reached today's automatic review capacity.",
      }[r.why] || 'Automatic review is unavailable.';
      startManual(`${why} No problem: fill in the details below and our team will review it manually.`);
    }
  } catch (err) {
    if (err.data?.manual) startManual(err.message + ' You can send it for manual review below.');
    else { show('stepForm'); setError('formError', err.message); }
  } finally {
    clearTimeout(slow);
    $('#workingText').textContent = 'Reading your store page and reviewing it…';
  }
});

$('#publishBtn').addEventListener('click', async () => {
  const btn = $('#publishBtn');
  btn.disabled = true;
  try {
    await api('submit', { method: 'POST', body: { ticket: pending.ticket } });
    $('#doneTitle').textContent = 'Your game is live!';
    $('#doneText').textContent = 'It is already in the catalog. Thanks for being part of The Indie Index.';
    show('stepDone');
    loadGames(true); loadTags();
  } catch (err) {
    setError('publishError', err.message);
  } finally {
    btn.disabled = false;
  }
});

// ---- capa manual: redimensiona no navegador (16:9, ~640px) ----
let coverData = '';
async function fileToCover(file) {
  const bmp = await createImageBitmap(file);
  const W = 640, H = 360;
  const canvas = Object.assign(document.createElement('canvas'), { width: W, height: H });
  const ctx = canvas.getContext('2d');
  const scale = Math.max(W / bmp.width, H / bmp.height);
  const w = bmp.width * scale, h = bmp.height * scale;
  ctx.drawImage(bmp, (W - w) / 2, (H - h) / 2, w, h);
  for (const [type, qualities] of [['image/webp', [0.85, 0.7, 0.55]], ['image/jpeg', [0.8, 0.65, 0.5]]]) {
    for (const q of qualities) {
      const data = canvas.toDataURL(type, q);
      if (data.startsWith('data:' + type) && data.length < 200_000) return data;
    }
  }
  throw new Error('Image is too complex to compress. Try a smaller image.');
}
$('#mCover').addEventListener('change', async (e) => {
  coverData = '';
  $('#mCoverPreview').hidden = true;
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 12 * 1024 * 1024) return setError('manualError', 'Image is too large (max 12 MB).');
  try {
    coverData = await fileToCover(file);
    $('#mCoverPreview').src = coverData;
    $('#mCoverPreview').hidden = false;
    setError('manualError', '');
  } catch (err) {
    setError('manualError', err.message || 'Could not read that image.');
  }
});

$('#manualForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const description = $('#mDesc').value.trim();
  const tags = $('#mTags').value.split(',').map((t) => t.trim()).filter(Boolean);
  if (description.length < 10) return setError('manualError', 'Please write a short description (at least 10 characters).');
  if (!tags.length) return setError('manualError', 'Add at least one tag.');
  if (!coverData) return setError('manualError', 'Please choose a cover image.');
  const btn = e.submitter; if (btn) btn.disabled = true;
  try {
    await api('submit', { method: 'POST', body: { manual: { name: pending.name, url: pending.url, description, tags, cover_data: coverData } } });
    $('#doneTitle').textContent = 'Sent for review';
    $('#doneText').textContent = 'Our team will review your game soon. You can follow its status under "Your submissions".';
    $('#manualForm').reset(); coverData = ''; $('#mCoverPreview').hidden = true;
    show('stepDone');
  } catch (err) {
    if (err.data?.reasons) { $('#rejectReasons').replaceChildren(...err.data.reasons.map((t) => el('li', { text: t }))); show('stepRejected'); }
    else setError('manualError', err.message);
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ============================ início ============================
await initAuth();
loadTags();
loadGames(true);
