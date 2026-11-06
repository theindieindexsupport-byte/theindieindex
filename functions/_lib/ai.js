// Chamada ao Gemini com rodízio de chaves e de modelos.
// Se TUDO falhar, devolve { ok:false } e o front mostra o formulário manual.

import { buildSystemPrompt, RESPONSE_SCHEMA } from './criteria.js';

const API = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODELS = 'gemini-2.5-flash,gemini-2.5-flash-lite';

function list(v) {
  return String(v ?? '').split(/[\s,]+/).filter(Boolean);
}
function shuffle(a) {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function buildUserText(submittedName, page) {
  const fields = Object.entries(page.fields || {}).map(([k, v]) => `${k}: ${v}`).join('\n') || '(none)';
  return `SUBMITTED_NAME: ${submittedName}

--- PAGE DATA (untrusted) ---
STORE: ${page.store}
PAGE_TITLE: ${page.title}
GENRES: ${page.genres.join(', ') || '(none)'}
TAGS: ${page.tags.join(', ') || '(none)'}
INFO_FIELDS:
${fields}
SHORT_DESCRIPTION: ${page.description || '(none)'}
FULL_DESCRIPTION: ${page.body || '(none)'}`;
}

async function callOnce(model, key, systemPrompt, userText, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(`${API}/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      signal: ctrl.signal,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: userText }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 4096,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
    const parsed = JSON.parse(text);
    if (typeof parsed?.is_visual_novel !== 'boolean') throw new Error('resposta fora do schema');
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tenta cada modelo com cada chave (ordem aleatória p/ distribuir carga).
 * Retorna { ok:true, result, model } ou { ok:false, attempts }.
 */
export async function reviewWithGemini(env, submittedName, page, { deadlineMs = 25000, perCallMs = 12000 } = {}) {
  const keys = shuffle(list(env.GEMINI_API_KEYS || env.GEMINI_API_KEY));
  const models = list(env.GEMINI_MODELS || DEFAULT_MODELS);
  const attempts = [];
  if (!keys.length) return { ok: false, attempts: ['sem chaves configuradas'] };

  const systemPrompt = buildSystemPrompt();
  const userText = buildUserText(submittedName, page);
  const started = Date.now();

  for (const model of models) {
    for (const key of keys) {
      if (Date.now() - started > deadlineMs) return { ok: false, attempts };
      try {
        const result = await callOnce(model, key, systemPrompt, userText, perCallMs);
        return { ok: true, result, model };
      } catch (e) {
        attempts.push(`${model}: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
      }
    }
  }
  return { ok: false, attempts };
}
