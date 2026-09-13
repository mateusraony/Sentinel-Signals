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
// docs/known-risks.md item 175 addendum — achado investigando um relato real
// do usuário (LDOUSDT preso no backfill): `fetch(url)` sozinho não tinha
// NENHUM limite de tempo por tentativa — só reagia a um erro/status já
// resolvido. Uma conexão que trava sem nunca responder (nem erro, nem dado)
// não caía em nenhum retry — ficava pendurada até o timeout EXTERNO do job
// inteiro (5min em run-backfill-check.mjs) matar o processo, consumindo o
// orçamento inteiro numa única tentativa em vez de falhar rápido e retentar.
// 20s é generoso sobre o tempo de resposta normal da Binance (<1s) e curto o
// bastante para nunca chegar perto do timeout externo mesmo esgotando todas
// as tentativas.
const DEFAULT_ATTEMPT_TIMEOUT_MS = 20_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** `fetch()` com um limite de tempo PRÓPRIO, via AbortController — sem isto,
 * uma conexão pendurada nunca aciona nem sucesso nem os catches de retry
 * abaixo. Um abort vira `AbortError`/`DOMException`, tratado pelo mesmo
 * caminho de "falha de rede pura" que um `TypeError` já usava.
 */
async function fetchComTimeout(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
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
  attemptTimeoutMs = DEFAULT_ATTEMPT_TIMEOUT_MS,
} = {}) {
  let ultimoErro;
  for (let tentativa = 0; tentativa <= maxRetries; tentativa++) {
    let res;
    try {
      res = await fetchComTimeout(url, attemptTimeoutMs);
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
