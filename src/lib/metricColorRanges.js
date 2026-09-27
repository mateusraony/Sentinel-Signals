// Round 4 da nova varredura pós-Raio-X (2026-09-27): unifica as faixas de
// cor de Win Rate/Drawdown/Profit Factor, hoje reimplementadas com valores
// levemente divergentes em Backtest.jsx, MonthlyReport.jsx,
// PerformanceReport.jsx, PerformanceMetricsBar.jsx, VirtualAccountCard.jsx
// e TradeHistory.jsx.

// Escalona por magnitude — já era a lógica correta em
// PerformanceMetricsBar.jsx/VirtualAccountCard.jsx (idênticas entre si);
// os outros 3 arquivos usavam vermelho fixo, sem relação com o tamanho do
// drawdown.
export function drawdownColor(maxDrawdownPct) {
  if (maxDrawdownPct > 15) return '#ff1478';
  if (maxDrawdownPct > 8) return '#ff9f43';
  return '#00ff80';
}

// Decisão do usuário (AskUserQuestion, 2026-09-27): 2 níveis/50% vira o
// padrão canônico — já era a lógica da maioria (Backtest.jsx,
// MonthlyReport.jsx, PerformanceReport.jsx). PerformanceMetricsBar.jsx
// perde os 3 níveis (45/60%) que tinha sozinho, pra convergir.
// TradeHistory.jsx continua tratando "0 operações contadas" como um caso
// neutro À PARTE, antes de chamar esta função (decisão intencional de
// rodada anterior — não é responsabilidade desta função).
export function winRateColor(winRatePct) {
  return winRatePct >= 50 ? '#00ff80' : '#ff9f43';
}

// pf: profit factor (null quando a amostra não teve nenhuma perda —
// ver summarizeOps/classifyOutcome). hasWins só é consultado quando pf é
// null, pra distinguir "só vitórias" (∞, saudável) de "só empates, sem
// vitória nem perda" (sem dado suficiente pra chamar de saudável).
//
// Decisão do usuário: o estado "Marginal" (1 ≤ pf < 1,5), que já existia
// só em PerformanceReport.jsx, passou a valer também em Backtest.jsx/
// MonthlyReport.jsx — os 3 arquivos agora têm o mesmo texto de 3 estados
// e, com isso, ganham a 3ª cor que o levantamento original já pedia pro
// estado "Baixo" (antes Marginal e Baixo dividiam a mesma cor laranja).
export function profitFactorColor(pf, hasWins = false) {
  if (pf === null) return hasWins ? '#00ff80' : '#ff1478';
  if (pf >= 1.5) return '#00ff80';
  if (pf >= 1) return '#ff9f43';
  return '#ff1478';
}

export function profitFactorLabel(pf, hasWins = false) {
  if (pf === null) return hasWins ? '✓ Saudável' : '✗ Baixo';
  if (pf >= 1.5) return '✓ Saudável';
  if (pf >= 1) return '⚠ Marginal';
  return '✗ Baixo';
}

const GLOW_04 = {
  '#00ff80': 'rgba(0,255,128,0.4)',
  '#ff9f43': 'rgba(255,159,67,0.4)',
  '#ff1478': 'rgba(255,20,120,0.4)',
};

// Glow (opacidade 0.4) pareado com as 3 cores acima — usado pelos cards da
// família "glow card" (MetricSummaryCard), que sempre casam a cor do glow
// decorativo com a cor do valor. Existe pra não deixar, por exemplo, um
// Drawdown que virou verde (baixo) com glow vermelho fixo — mesma classe de
// divergência já encontrada no card de Win Rate de Backtest.jsx.
export function metricGlow(color) {
  return GLOW_04[color];
}
