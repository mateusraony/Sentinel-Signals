// Wrapper de retry+backoff para chamadas fetch() a APIs públicas (Binance),
// compartilhado entre o browser (marketDataProvider.js) e o cron
// (scripts/adminMarketDataProvider.js). JS puro (fetch/setTimeout, ambos
// nativos no browser e no Node 20) — não precisa de redirecionamento em
// scripts/build-scan.mjs, é só mais um import de src/lib/.
//
// Extraído do padrão já em produção em scripts/fetch-backtest-data.mjs
// (fetchWithRetry/esperaAntesDeRetentar/sleep) — o motor de backtest nunca
// perde dado por falha transitória de rede porque baixa tudo com retry uma
// vez; a busca ao vivo (persistScanResults/priceCheckActiveOps, a cada
// ~5min) fazia um fetch() só, sem segunda tentativa — uma falha transitória
// (a mesma classe de "Failed to fetch" observada em produção) derrubava a
// avaliação daquele timeframe/ativo até o próximo scan. Ver
// docs/known-risks.md para o achado completo.

const DEFAULT_RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY_MS = 250;
const DEFAULT_MAX_RETRY_AFTER_MS = 120_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A janela de rate limit da Binance é por MINUTO — honrar o `Retry-After`
// do servidor tem precedência sobre o backoff exponencial, que só entra
// quando o header não vem (5xx sem header, falha de rede). Aceita tanto
// segundos (RFC 7231) quanto uma data HTTP.
function esperaAntesDeRetentar(res, tentativa, baseDelayMs, maxRetryAfterMs) {
  const header = res?.headers?.get?.('retry-after');
  if (header) {
    const segundos = Number(header);
    if (Number.isFinite(segundos) && segundos >= 0) {
      return Math.min(segundos * 1000, maxRetryAfterMs);
    }
    const quando = Date.parse(header);
    if (Number.isFinite(quando)) {
      return Math.min(Math.max(quando - Date.now(), 0), maxRetryAfterMs);
    }
  }
  return baseDelayMs * 2 ** (tentativa + 1);
}

/**
 * fetch() com retry em erro transitório (429/5xx/falha de rede pura).
 * Um 4xx que não seja 429 (símbolo inválido, parâmetro errado) falha na
 * hora, como deve — não é retentável. Devolve a Response ok; lança o
 * último erro se esgotar as tentativas.
 */
export async function fetchWithRetry(url, {
  context = url,
  maxRetries = DEFAULT_MAX_RETRIES,
  retryStatuses = DEFAULT_RETRY_STATUSES,
  baseDelayMs = DEFAULT_BASE_DELAY_MS,
  maxRetryAfterMs = DEFAULT_MAX_RETRY_AFTER_MS,
} = {}) {
  let ultimoErro;
  for (let tentativa = 0; tentativa <= maxRetries; tentativa++) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      ultimoErro = err;
      if (tentativa === maxRetries) break;
      await sleep(baseDelayMs * 2 ** (tentativa + 1));
      continue;
    }
    if (res.ok) return res;
    if (!retryStatuses.has(res.status) || tentativa === maxRetries) {
      return res; // caller decide o que fazer com um !ok não-retentável
    }
    const espera = esperaAntesDeRetentar(res, tentativa, baseDelayMs, maxRetryAfterMs);
    console.warn(`[httpRetry] ${context}: HTTP ${res.status}, retentando em ${espera}ms (${tentativa + 1}/${maxRetries})`);
    await sleep(espera);
  }
  throw ultimoErro;
}
