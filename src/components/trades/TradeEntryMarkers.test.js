// item 166 Fase 2 ("UI reimplementando regra do motor"): a cor do ponto de
// saída no gráfico usava `status === 'STOP_HIT' && tp1_hit` pra decidir
// "breakeven" — a MESMA heurística que PerformanceOverview.jsx (mesma tela)
// já tinha removido em favor de `classifyOutcome`, porque o trailing
// (advanceTrailingStop, scanner.js) continua avançando o stop depois do
// TP1: um runner pode travar lucro real, e "tp1_hit" sozinho não distingue
// isso de um breakeven exato. Os dois widgets podiam discordar sobre o
// mesmo trade.
import { describe, it, expect } from 'vitest';
import { exitDotColor } from './TradeEntryMarkers.jsx';

describe('exitDotColor', () => {
  it('STOP_HIT com outcome WIN (stop travou lucro real) é verde, não vermelho/amarelo', () => {
    expect(exitDotColor('STOP_HIT', 'WIN')).toBe('#00ff80');
  });

  it('STOP_HIT com outcome BE (empate real) é amarelo', () => {
    expect(exitDotColor('STOP_HIT', 'BE')).toBe('#ffd166');
  });

  it('STOP_HIT com outcome LOSS é vermelho', () => {
    expect(exitDotColor('STOP_HIT', 'LOSS')).toBe('#ff1478');
  });

  it('TP2_HIT é sempre verde, independente do outcome', () => {
    expect(exitDotColor('TP2_HIT', 'WIN')).toBe('#00ff80');
  });

  it('INVALIDATED é laranja; qualquer outro status cai no cinza neutro', () => {
    expect(exitDotColor('INVALIDATED', 'LOSS')).toBe('#ff9f43');
    expect(exitDotColor('CLOSED', 'BE')).toBe('#64748b');
  });
});
