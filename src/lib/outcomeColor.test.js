// item 166 Fase 2 ("UI reimplementando regra do motor"): a cor do ponto de
// saída no gráfico usava `status === 'STOP_HIT' && tp1_hit` pra decidir
// "breakeven" — a MESMA heurística que PerformanceOverview.jsx (mesma tela)
// já tinha removido em favor de `classifyOutcome`, porque o trailing
// (advanceTrailingStop, scanner.js) continua avançando o stop depois do
// TP1: um runner pode travar lucro real, e "tp1_hit" sozinho não distingue
// isso de um breakeven exato. Os dois widgets podiam discordar sobre o
// mesmo trade.
//
// Round 4 da nova varredura pós-Raio-X (2026-09-27): estes casos migraram
// de TradeEntryMarkers.test.js (onde a função nasceu como `exitDotColor`)
// pra testar a função pura onde ela mora agora.
import { describe, it, expect } from 'vitest';
import { outcomeColor } from './outcomeColor.js';

describe('outcomeColor', () => {
  it('STOP_HIT com outcome WIN (stop travou lucro real) é verde, não vermelho/amarelo', () => {
    expect(outcomeColor('STOP_HIT', 'WIN')).toBe('#5db586');
  });

  it('STOP_HIT com outcome BE (empate real) é amarelo', () => {
    expect(outcomeColor('STOP_HIT', 'BE')).toBe('#e3b45a');
  });

  it('STOP_HIT com outcome LOSS é vermelho', () => {
    expect(outcomeColor('STOP_HIT', 'LOSS')).toBe('#e06a5b');
  });

  it('TP2_HIT é sempre verde, independente do outcome', () => {
    expect(outcomeColor('TP2_HIT', 'WIN')).toBe('#5db586');
  });

  it('INVALIDATED é laranja; qualquer outro status cai no cinza neutro', () => {
    expect(outcomeColor('INVALIDATED', 'LOSS')).toBe('#dd9a4a');
    expect(outcomeColor('CLOSED', 'BE')).toBe('#64748b');
  });
});
