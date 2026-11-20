// Contexto de Mercado — a taxa de juros ATUAL do Fed (faixa-alvo dos fundos federais), para o "Anterior" do FOMC (docs/known-risks.md item 285, addendum 36).
//
// Lê a API pública do NY Fed (taxa efetiva dos fundos federais; a resposta traz também a faixa-alvo). Observada pelo coletor desde 19/11; o formato real foi
// CONFERIDO no log da coleta de 20/11 (faixa-alvo de 3,75% a 4,00%, taxa efetiva 3,88%) e os termos de uso foram lidos: quem republica a taxa precisa avisar que o
// dado está sujeito aos Termos de Uso do NY Fed (newyorkfed.org) — o aviso do Telegram traz essa linha (`POLICY_RATE_SOURCE_NOTE`, addendum 42).
// USO: só o aviso de ANTES do FOMC no Telegram (`context-alert.mjs`), lido na hora; NUNCA entra no `events.json` (a regra pública de formato não muda).
//
// Formato (conferido): { refRates: [{ effectiveDate: 'AAAA-MM-DD', percentRate: 3.88, targetRateFrom: 3.75, targetRateTo: 4.0 }] }.
// Validação: faixa de 0,25 ponto, em passos de 0,25, entre 0 e 10; data recente. Qualquer coisa fora disso = null (nunca um número duvidoso).
// Módulo puro + `fetch` injetável. Sem chave, sem banco, sem Telegram.
import { buildUserAgent, MAX_BODY_BYTES } from './contextProbe.mjs';

export const NYFED_EFFR_URL = 'https://markets.newyorkfed.org/api/rates/unsecured/effr/last/1.json';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Uma leitura mais velha que isto é descartada (a taxa efetiva sai todo dia útil). */
export const MAX_AGE_DAYS = 10;

const isQuarter = (x) => Number.isFinite(x) && Math.abs(x * 4 - Math.round(x * 4)) < 1e-9;
export const fmt = (x) => `${x.toFixed(2).replace('.', ',')}%`;

/** A linha de atribuição que os termos de uso do NY Fed pedem para quem republica a taxa (vai no aviso do Telegram, sempre que a taxa aparece). */
export const POLICY_RATE_SOURCE_NOTE = 'Juros: Federal Reserve Bank of New York — dado sujeito aos Termos de Uso publicados em newyorkfed.org.';

/**
 * A faixa-alvo da resposta do NY Fed. `{ date, from, to, effective }` (números em %) ou null se o corpo não serve ou foge das conferências.
 * @param {string} body @param {number} nowMs
 */
export function parseEffr(body, nowMs) {
  let j;
  try { j = JSON.parse(body ?? ''); } catch { return null; }
  const row = Array.isArray(j?.refRates) ? j.refRates[0] : null;
  if (!row || typeof row !== 'object') return null;
  const date = String(row.effectiveDate ?? '');
  const from = Number(row.targetRateFrom);
  const to = Number(row.targetRateTo);
  const effective = Number(row.percentRate);
  if (!DATE_RE.test(date) || !Number.isFinite(Date.parse(`${date}T00:00:00Z`))) return null;
  if (Number.isFinite(nowMs) && (nowMs - Date.parse(`${date}T00:00:00Z`) > MAX_AGE_DAYS * DAY_MS || Date.parse(`${date}T00:00:00Z`) - nowMs > 2 * DAY_MS)) return null;
  if (![from, to].every(isQuarter) || from < 0 || to > 10 || Math.abs(to - from - 0.25) > 1e-9) return null;
  if (!Number.isFinite(effective) || effective < from - 0.5 || effective > to + 0.5) return null; // a taxa efetiva fica perto da faixa; longe = outra série
  return { date, from, to, effective };
}

/**
 * Busca a taxa. Nunca lança; falha vira `{ rate: null, reason }` com um código curto (nunca texto de erro).
 * @returns {Promise<{ rate: ReturnType<typeof parseEffr>, reason: 'ok'|'http'|'formato'|'rede' }>}
 */
export async function fetchPolicyRate({ fetchImpl = fetch, env = {}, nowMs = Date.now(), timeoutMs = 15000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(NYFED_EFFR_URL, { headers: { 'User-Agent': buildUserAgent(env), Accept: 'application/json' }, signal: controller.signal });
    const text = await res.text();
    if (!(res.status >= 200 && res.status < 300) || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) return { rate: null, reason: 'http' };
    const rate = parseEffr(text, nowMs);
    return rate ? { rate, reason: 'ok' } : { rate: null, reason: 'formato' };
  } catch {
    return { rate: null, reason: 'rede' };
  } finally {
    clearTimeout(timer);
  }
}

/** A linha do resumo do coletor (observação). */
export function describePolicyRate(result) {
  if (!result) return null;
  const head = 'Juros do Fed (NY Fed; usados só no aviso do Telegram antes do FOMC, nunca no events.json):';
  if (!result.rate) {
    const why = { http: 'a API não respondeu', formato: 'a resposta não está no formato esperado', rede: 'erro de rede' }[result.reason] ?? 'falhou';
    return `${head} ${why}.`;
  }
  const { date, from, to, effective } = result.rate;
  return `${head} faixa-alvo de ${fmt(from)} a ${fmt(to)} (limite superior ${fmt(to)}), taxa efetiva ${fmt(effective)} em ${date}.`;
}
