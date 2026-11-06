// Orquestra a análise: página da loja -> filtros automáticos -> Gemini -> decisão.

import { CRITERIA, HARD_BLOCK_PATTERNS } from './criteria.js';
import { reviewWithGemini } from './ai.js';
import { fetchStorePage, isAllowedCover } from './store.js';
import { cleanText, cleanTags } from './util.js';

const FLAG_MESSAGES = {
  is_visual_novel: 'Visual novels and similar story-only games are not accepted on this portal.',
  ai_generated_content: 'The page indicates AI-generated art, writing, audio or voice inside the game.',
  low_effort_or_spam: 'The page looks like spam, an asset flip, or has no real description of the game.',
  explicit_adult: 'Explicit sexual content is not accepted on this portal.',
  violates_custom_rules: 'The game does not meet the portal\'s curation guidelines.',
  name_mismatch: 'The name you typed does not match the game on that page.',
};

/** Checagem determinística de texto livre (também usada nas submissões manuais). */
export function hardBlockReasons({ name = '', description = '', tags = [], genres = [] }) {
  const reasons = [];
  const hay = [name, description, ...tags, ...genres].join(' | ');
  if (CRITERIA.visualNovels && HARD_BLOCK_PATTERNS.visualNovels.test(hay)) reasons.push(FLAG_MESSAGES.is_visual_novel);
  return reasons;
}

/**
 * @returns {Promise<
 *   {status:'approved', game:object} |
 *   {status:'rejected', reasons:string[]} |
 *   {status:'unavailable', why:'store'|'ai', detail:string[]}>}
 */
export async function reviewSubmission(env, submittedName, storeInfo) {
  let page;
  try {
    page = await fetchStorePage(storeInfo);
  } catch (e) {
    return { status: 'unavailable', why: 'store', detail: [String(e.message || e)] };
  }

  // 1) Filtro automático (grátis, não gasta cota de IA)
  const hard = hardBlockReasons({ name: page.title, description: page.description, tags: page.tags, genres: page.genres });
  if (hard.length) return { status: 'rejected', reasons: hard };

  // 2) Gemini
  const ai = await reviewWithGemini(env, submittedName, page);
  if (!ai.ok) return { status: 'unavailable', why: 'ai', detail: ai.attempts };
  const r = ai.result;

  const reasons = [];
  const on = (flag, enabled = true) => enabled && r[flag] === true && reasons.push(FLAG_MESSAGES[flag]);
  on('is_visual_novel', CRITERIA.visualNovels);
  on('ai_generated_content', CRITERIA.aiGeneratedContent);
  on('low_effort_or_spam', CRITERIA.lowEffort);
  on('explicit_adult', CRITERIA.explicitAdult);
  on('violates_custom_rules', CRITERIA.custom?.length > 0);
  if (r.name_matches_page === false) reasons.push(FLAG_MESSAGES.name_mismatch);
  if (reasons.length) {
    for (const extra of (r.reject_reasons || []).slice(0, 3)) {
      const c = cleanText(extra, 200);
      if (c && !reasons.includes(c)) reasons.push(c);
    }
    return { status: 'rejected', reasons };
  }

  // 3) Aprovado: monta os dados que serão publicados (tudo sanitizado)
  let tags = cleanTags(r.tags);
  if (tags.length < 2) tags = cleanTags([...tags, ...page.genres, ...page.tags]);
  const description = cleanText(r.short_description, 200) || cleanText(page.description, 200);
  if (description.length < 10) return { status: 'unavailable', why: 'ai', detail: ['descrição vazia'] };

  return {
    status: 'approved',
    game: {
      name: cleanText(submittedName, 80),
      description,
      cover_url: isAllowedCover(page.cover) ? page.cover : '',
      store: storeInfo.store,
      store_url: storeInfo.url,
      url_key: storeInfo.key,
      tags,
    },
  };
}
