// item 166 Fase 2: a cor do STOP_HIT usava `tp1_hit` pra decidir "breakeven"
// — exatamente a heurística que PerformanceOverview.jsx já removeu em favor
// do outcome REALIZADO (classifyOutcome), porque um runner pode travar lucro
// real bem depois do TP1 (advanceTrailingStop, scanner.js). Sem essa troca,
// os dois widgets da mesma tela podiam discordar sobre o mesmo trade. Função
// pura exportada pra testar sem precisar renderizar o gráfico inteiro.
//
// Round 4 da nova varredura pós-Raio-X (2026-09-27): movida de
// TradeEntryMarkers.jsx (onde nasceu como `exitDotColor`) pra cá, já que
// MonthlyReport.jsx/TradeHistory.jsx/Backtest.jsx também precisavam da
// mesma lógica e reimplementavam versões parciais/divergentes dela.
export function outcomeColor(status, outcome) {
  if (status === 'STOP_HIT' && outcome === 'WIN') return '#00ff80';
  if (status === 'STOP_HIT' && outcome === 'BE') return '#ffd166';
  if (status === 'STOP_HIT') return '#ff1478';
  if (status === 'TP2_HIT') return '#00ff80';
  if (status === 'INVALIDATED') return '#ff9f43';
  return '#64748b';
}
