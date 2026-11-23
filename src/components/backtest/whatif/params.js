// Controles do What-If (compartilhados entre a aba e os painéis): faixa e passo de cada parâmetro, timeframes e quantidades de candles.
export const QBT_TIMEFRAMES = [
  { id: '1h', label: '1H', minutes: 60 },
  { id: '4h', label: '4H', minutes: 240 },
  { id: '1d', label: '1D', minutes: 1440 },
];
export const QBT_CANDLE_OPTIONS = [200, 500, 1000];
export const QBT_SLIDERS = [
  { key: 'atrMult', label: 'Stop (× ATR)', min: 0.5, max: 5, step: 0.1, color: '#e06a5b', help: 'Distância do stop em múltiplos do ATR. Na produção o padrão depende do tier do ativo (2×, 2,5× ou 3×).' },
  { key: 'tp1R', label: 'TP1 (R)', min: 0.5, max: 4, step: 0.1, color: '#e3b45a', help: 'Primeiro alvo, em múltiplos do risco (R). O TP2 fica no dobro.' },
  { key: 'rfPeriod', label: 'RF Period', min: 5, max: 50, step: 1, color: '#8db4e2', help: 'Período do Range Filter (quanto menor, mais sensível).' },
  { key: 'rfMult', label: 'RF Mult', min: 0.5, max: 8, step: 0.1, color: '#5db586', help: 'Multiplicador do Range Filter (quanto maior, mais largo o filtro).' },
  { key: 'minScore', label: 'Min Score', min: 50, max: 100, step: 1, color: '#a78bfa', help: 'Score mínimo (0–100) para abrir a operação.' },
];

/** Interruptores (0/1): o padrão de cada um é o da produção. */
export const QBT_SWITCHES = [
  { key: 'regime', label: 'Filtro de regime (ADX/Choppiness)', help: 'Barra entradas em mercado lateral ou fraco, como o scanner. Padrão: o que a produção tem ligado.' },
  { key: 'timeStop', label: 'Time stop', help: 'Fecha a operação que não bateu o TP1 depois de N candles (48 / 64 / 96 por tier). Padrão: o que a produção tem ligado.' },
];

export const clampToSlider = (key, v) => {
  const def = QBT_SLIDERS.find(s => s.key === key);
  if (!def || !Number.isFinite(v)) return v;
  return Math.min(def.max, Math.max(def.min, v));
};

/** "Stop 2.5× · TP1 1.5R · RF 20/3.5 · Score 75" */
export const formatParams = (p) => `Stop ${p.atrMult}× · TP1 ${p.tp1R}R · RF ${p.rfPeriod}/${p.rfMult} · Score ${p.minScore} · Regime ${p.regime ? 'on' : 'off'} · Time stop ${p.timeStop ? 'on' : 'off'}`;

/** Os padrões (como vêm de buildDefaults) dentro da faixa de cada slider, com as 5 chaves explícitas. */
export const clampDefaults = (d) => ({
  atrMult: clampToSlider('atrMult', d.atrMult),
  tp1R: clampToSlider('tp1R', d.tp1R),
  rfPeriod: clampToSlider('rfPeriod', d.rfPeriod),
  rfMult: clampToSlider('rfMult', d.rfMult),
  minScore: clampToSlider('minScore', d.minScore),
  regime: d.regime ? 1 : 0,
  timeStop: d.timeStop ? 1 : 0,
});
