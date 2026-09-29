/**
 * Auditoria do Telegram (2026-09-29), Fase 2 item 2.11 — fonte única dos
 * pares id→rótulo de `SignalEvent.source`, antes duplicados (com grafias
 * levemente diferentes) em `src/lib/telegram.js`, `scripts/adminTelegram.js`
 * e `src/pages/Alerts.jsx`.
 *
 * Deliberadamente NÃO muda o texto exibido em nenhum lugar nesta rodada —
 * cada consumidor escolhe `short` (Telegram, sigla) ou `long`/`tooltip`
 * (Alerts.jsx, já tinha nome/explicação mais longos de propósito, achado
 * M-17 do Raio-X de UI/UX). `confluence` só existe pro lado `long` — nunca
 * apareceu como `SignalEvent.source` real em código de sinal/trade do
 * Telegram, mas a página Alertas já o listava.
 */
export const SIGNAL_SOURCES = {
  range_filter: {
    short: 'RF',
    long: 'Range Filter',
    tooltip: 'Indicador que filtra o ruído do preço e define uma banda de tendência: o sistema só considera um movimento válido quando o preço rompe essa banda de forma consistente.',
  },
  smc_structure: {
    short: 'SMC',
    long: 'SMC Structure',
    tooltip: 'Smart Money Concepts: análise de topos/fundos e zonas de rompimento, usada como fonte alternativa de sinal além do Range Filter.',
  },
  macd: {
    short: 'MACD',
    long: 'MACD',
    tooltip: 'Compara duas médias de preço pra indicar se a força do movimento está aumentando ou diminuindo.',
  },
  ema_cross: {
    short: 'EMA',
    long: 'EMA Cross',
    tooltip: 'Média móvel exponencial — reage mais rápido a mudanças recentes que uma média comum. Quando uma EMA curta cruza uma longa, é sinal de mudança de tendência.',
  },
  rsi: {
    short: 'RSI',
    long: 'RSI',
    tooltip: 'Índice de Força Relativa: mede se o ativo está sendo comprado ou vendido com força incomum (0 a 100) — aqui vira alerta próprio, de prioridade baixa, quando entra em sobrecompra/sobrevenda.',
  },
  confluence: {
    short: 'Confl.',
    long: 'Confluência',
    tooltip: 'Pontuação de 0 a 100 somando quantos indicadores concordam na mesma direção ao mesmo tempo. Quanto mais alto, mais confirmações.',
  },
};

/** Sigla curta (Telegram) — fallback "Outra fonte", nunca inventa a origem. */
export function shortSourceLabel(source) {
  return SIGNAL_SOURCES[source]?.short || 'Outra fonte';
}

/** Nome longo (Alerts.jsx) — fallback no próprio `source` cru, como já era. */
export function longSourceLabel(source) {
  return SIGNAL_SOURCES[source]?.long || source;
}
