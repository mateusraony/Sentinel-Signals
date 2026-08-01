// Benchmarks pro gráfico "Carteira vs Mercado" (src/components/trades/PortfolioVsMarket.jsx).
// Fase A (docs/known-risks.md item pendente de registro nesta rodada): só
// fontes gratuitas, sem chave, sem novo "secret no navegador" — BTC (já
// existia, via Binance) + CDI/IPCA/Selic via a API pública do Banco Central
// (SGS, https://dadosabertos.bcb.gov.br), mesma família de fetch direto do
// browser que o resto do painel já usa pro BTC (marketDataProvider.js).
//
// Fora de escopo desta rodada (Fase B, decisão separada do usuário):
// Dólar/IBOV (API diferente, formato OData, não pesquisado com o mesmo rigor
// nesta sessão) e SP500/T-BILL/US10Y (exigiriam uma chave de API nova
// embutida no navegador — bate de frente com ".claude/rules/security.md",
// "secrets de terceiros nunca no client", mesma categoria de exceção que só
// o token do Telegram tem hoje).
import { fetchCandles } from './marketDataProvider';

const BCB_BASE_URL = 'https://api.bcb.gov.br/dados/serie/bcdata.sgs';

// CDI (12) e Selic efetiva diária (11) vêm como taxa % AO DIA; IPCA (433)
// vem como taxa % AO MÊS. computeAccrualCurve não distingue periodicidade —
// só acumula observações na ordem em que a série já as reporta.
export const BCB_SERIES = {
  CDI: 12,
  SELIC: 11,
  IPCA: 433,
};

function toBcbDate(ms) {
  const d = new Date(ms);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}

// BCB devolve `data` em "dd/MM/yyyy" e `valor` como string (ponto ou vírgula
// decimal, dependendo da série/época — aceita os dois). Filtra entradas não
// numéricas em vez de derrubar a série inteira por um ponto ruim.
export function parseBcbSeries(json) {
  if (!Array.isArray(json)) return [];
  return json
    .map((entry) => {
      const [dd, mm, yyyy] = String(entry.data || '').split('/');
      if (!dd || !mm || !yyyy) return null;
      const timestamp = Date.UTC(Number(yyyy), Number(mm) - 1, Number(dd));
      const ratePct = parseFloat(String(entry.valor).replace(',', '.'));
      if (!Number.isFinite(timestamp) || !Number.isFinite(ratePct)) return null;
      return { timestamp, ratePct };
    })
    .filter(Boolean)
    .sort((a, b) => a.timestamp - b.timestamp);
}

// Acumula uma série de taxas periódicas (% por período, qualquer
// periodicidade) em juros compostos, devolvendo uma curva de % acumulado
// comparável com a curva de PnL da carteira (`cumulativePct` em
// tradeMetrics.summarizeOps — mesma convenção: 0% no ponto de partida).
export function computeAccrualCurve(rateSeries) {
  let factor = 1;
  return rateSeries.map(({ timestamp, ratePct }) => {
    factor *= 1 + ratePct / 100;
    return { timestamp, market: (factor - 1) * 100 };
  });
}

// Normaliza uma série de preço (ex.: candles do BTC) contra um preço-base,
// mesma fórmula que já estava inline em PortfolioVsMarket.jsx antes desta
// rodada — extraída aqui só pra ficar testável e reutilizável por outros
// benchmarks do tipo "preço" (Fase B, quando vierem).
export function computePriceChangeCurve(pricePoints, basePrice) {
  if (!Number.isFinite(basePrice) || basePrice === 0) return [];
  return pricePoints.map(({ timestamp, close }) => ({
    timestamp,
    market: ((close - basePrice) / basePrice) * 100,
  }));
}

async function fetchBcbAccrualCurve(seriesCode, fromMs, toMs) {
  const url = `${BCB_BASE_URL}.${seriesCode}/dados?formato=json`
    + `&dataInicial=${toBcbDate(fromMs)}&dataFinal=${toBcbDate(toMs)}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`BCB API error (${response.status}) série ${seriesCode}`);
  }
  const json = await response.json();
  return computeAccrualCurve(parseBcbSeries(json));
}

async function fetchBtcCurve(fromMs, toMs) {
  const candles = await fetchCandles('BTCUSDT', '1d', 60);
  const closed = candles.filter((c) => c.isClosed);
  if (closed.length < 2) return [];
  const startIdx = closed.findIndex((c) => c.closeTime >= fromMs);
  const baseIdx = startIdx > 0 ? startIdx - 1 : 0;
  const basePrice = closed[baseIdx].close;
  const pricePoints = closed
    .filter((c) => c.closeTime >= closed[baseIdx].closeTime && c.closeTime <= toMs)
    .map((c) => ({ timestamp: c.closeTime, close: c.close }));
  return computePriceChangeCurve(pricePoints, basePrice);
}

// Registro dos benchmarks selecionáveis no gráfico — `fetchCurve` sempre
// devolve `[{timestamp, market}]` (% acumulado desde o início do período),
// mesmo shape independente da fonte (preço normalizado ou taxa acumulada).
export const BENCHMARK_OPTIONS = [
  { key: 'BTC', label: 'BTC', fetchCurve: fetchBtcCurve },
  { key: 'CDI', label: 'CDI', fetchCurve: (from, to) => fetchBcbAccrualCurve(BCB_SERIES.CDI, from, to) },
  { key: 'SELIC', label: 'Selic', fetchCurve: (from, to) => fetchBcbAccrualCurve(BCB_SERIES.SELIC, from, to) },
  { key: 'IPCA', label: 'IPCA', fetchCurve: (from, to) => fetchBcbAccrualCurve(BCB_SERIES.IPCA, from, to) },
];
