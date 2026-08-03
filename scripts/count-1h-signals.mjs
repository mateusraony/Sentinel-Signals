// Diagnóstico read-only, disparo manual (.github/workflows/count-signals.yml).
// Não faz parte do relógio de trading nem do backtest — só conta quantos
// SignalEvent range_filter já existem por timeframe no Firestore real.
//
// Contexto: scanner.js já calcula e persiste RF em 1h (e 1d) pra todo ativo,
// mas o Entry Motor bloqueia explicitamente qualquer entrada fora do 4h
// (scanner.js:1696, "Non-4H RF signals ... do NOT trigger entries") — os
// sinais 1h existem e são descartados silenciosamente pra esse propósito.
// Este script só mede a MAGNITUDE bruta desse sinal descartado, pra decidir
// se vale investir numa Fase 1 (backtest experimental com 1h como cascata de
// entrada) — ver docs/known-risks.md item 56, subseção "Retomada
// (2026-08-03)". Não conta como previsão de operações: os sinais 1h nunca
// passaram por confirmação nem pelo gate de regime pensado pra esse
// timeframe, só pelo score.
import { backend } from './adminEntities.js';

const SOURCE = 'range_filter';

function summarize(label, signals) {
  const bySymbol = {};
  for (const s of signals) {
    bySymbol[s.symbol] = (bySymbol[s.symbol] || 0) + 1;
  }
  const dates = signals.map((s) => s.candle_time || s.created_date).filter(Boolean).sort();
  const oldest = dates[0];
  const newest = dates[dates.length - 1];

  console.log(`\n[${label}] total: ${signals.length}`);
  if (oldest && newest && signals.length > 1) {
    const days = Math.max(1, (new Date(newest) - new Date(oldest)) / 86400000);
    console.log(`[${label}] janela: ${oldest} → ${newest} (~${days.toFixed(1)} dias, ~${(signals.length / days).toFixed(3)} sinal/dia no total)`);
  }
  console.log(`[${label}] por símbolo:`, JSON.stringify(bySymbol, null, 2));
}

async function main() {
  const [signals1h, signals4h] = await Promise.all([
    backend.entities.SignalEvent.filter({ source: SOURCE, timeframe: '1h' }),
    backend.entities.SignalEvent.filter({ source: SOURCE, timeframe: '4h' }),
  ]);

  summarize('RF 1h (nunca vira entrada hoje — scanner.js:1696)', signals1h);
  summarize('RF 4h (única que vira entrada hoje)', signals4h);

  const ratio = signals4h.length > 0 ? signals1h.length / signals4h.length : null;
  console.log(`\n[comparação] razão 1h/4h: ${ratio !== null ? `${ratio.toFixed(2)}x` : 'n/d (zero sinais 4h)'}`);
  console.log(
    '[aviso] Contagem de SINAIS BRUTOS (já passaram no score, nunca passaram por ' +
    'confirmação 15m/5m nem pelo gate de regime calibrado pra esse timeframe) — ' +
    'não é previsão de quantas OPERAÇÕES o 1h geraria. Serve só pra medir magnitude ' +
    'antes de investir numa Fase 1 de backtest experimental.'
  );
}

main().catch((err) => {
  console.error('[count-1h-signals] FAILED:', err);
  process.exitCode = 1;
});
