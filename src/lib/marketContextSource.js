// Contexto de Mercado — Fase 3: a ÚNICA função que faz rede para a faixa de eventos. Lê `events.json` e `status.json`
// da branch pública `context-data` (docs/known-risks.md item 285). Sem chave, sem cabeçalho extra (o CORS do
// raw.githubusercontent.com é `*`, provado pela sonda `raw-github-cors`; sem cabeçalho = sem preflight).
// Falha = lança; quem chama trata como "indisponível". Nenhum log: é informação opcional e `logWarn` grava no banco.
import { CONTEXT_DATA_BASE, parseEvents, parseCheckedAt } from '@/lib/marketContextBand';

const TIMEOUT_MS = 10000;

async function getJson(name, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${CONTEXT_DATA_BASE}/${name}`, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** @returns {Promise<{ events: object[], checkedAtMs: number|null }>} */
export async function fetchMarketContext({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch indisponível');
  const events = parseEvents(await getJson('events.json', fetchImpl));
  let checkedAtMs = null;
  try { checkedAtMs = parseCheckedAt(await getJson('status.json', fetchImpl)); } catch { checkedAtMs = null; }
  return { events, checkedAtMs };
}
