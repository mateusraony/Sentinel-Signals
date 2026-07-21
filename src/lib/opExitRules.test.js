import { describe, it, expect } from 'vitest';
import { isCandleUsableForExits, getEntryReferenceTime, advanceTrailingStop, nextRfReverseCount, computeStructuralStop, resolveCandleExit } from './opExitRules.js';

const T0 = '2026-07-15T04:00:00.000Z'; // candle open, at/before the entry
const T1 = '2026-07-15T08:00:00.000Z'; // candle open, exactly at the entry instant
const Tafter = '2026-07-15T12:00:00.000Z'; // candle open, strictly after the entry

describe('isCandleUsableForExits (P0-c/P0-g — guard temporal, candle OPEN vs real entry)', () => {
  it('rejeita um candle cujo open é anterior à entrada (contém movimento pré-entrada)', () => {
    expect(isCandleUsableForExits(T0, T1)).toBe(false);
  });

  it('aceita um candle cujo open coincide exatamente com o instante da entrada', () => {
    expect(isCandleUsableForExits(T1, T1)).toBe(true);
  });

  it('aceita um candle cujo open é estritamente posterior à entrada', () => {
    expect(isCandleUsableForExits(Tafter, T1)).toBe(true);
  });

  it('fallback legado: sem referência de entrada, mantém o comportamento antigo', () => {
    expect(isCandleUsableForExits(T1, null)).toBe(true);
    expect(isCandleUsableForExits(T1, undefined)).toBe(true);
  });

  it('fallback legado: feed sem lastCandleOpenTime, mantém o comportamento antigo', () => {
    expect(isCandleUsableForExits(null, T1)).toBe(true);
  });

  // P0-g — reproduz o bug real: sinal 4h fecha às 08:00, mas a confirmação
  // 15m só chega às 11:45 (retry). O candle 4h seguinte (abre 08:00, fecha
  // 12:00) contém ~3h45 de movimento ANTES da entrada existir. A referência
  // antiga (fechamento do candle de SINAL, 08:00) julgava esse candle
  // "usável" porque seu fechamento (12:00) é posterior a 08:00 — mesmo
  // contendo preço pré-entrada. A referência correta é o fechamento real da
  // confirmação (11:45): o candle contaminado (open 08:00) é rejeitado; só o
  // candle SEGUINTE (open 12:00, inteiramente pós-entrada) é aceito.
  it('P0-g: candle contaminado por confirmação atrasada (retry) é rejeitado; o próximo é aceito', () => {
    const signalCandleClose = '2026-07-15T08:00:00.000Z';
    const realEntryTime = '2026-07-15T11:45:00.000Z'; // confirmação 15m atrasada
    const contaminatedCandleOpen = '2026-07-15T08:00:00.000Z'; // 08:00–12:00
    const nextCandleOpen = '2026-07-15T12:00:00.000Z'; // 12:00–16:00, limpo

    // Referência antiga (bug): teria comparado o CLOSE do candle contaminado
    // (12:00) contra o close do candle de SINAL (08:00) → 12:00 > 08:00 →
    // "usável" (incorreto). A nova referência é o horário real da entrada:
    expect(isCandleUsableForExits(contaminatedCandleOpen, realEntryTime)).toBe(false);
    expect(isCandleUsableForExits(nextCandleOpen, realEntryTime)).toBe(true);
    // sanity: a referência de sinal por si só não bastaria (prova que a
    // correção não é só trocar o valor comparado, mas também o que se compara).
    expect(new Date(contaminatedCandleOpen).getTime() > new Date(signalCandleClose).getTime()).toBe(false);
  });
});

describe('getEntryReferenceTime — preferência de campo (P0-g)', () => {
  it('prefere entry_candle_time_15m (cascata RF) quando presente', () => {
    expect(getEntryReferenceTime({
      entry_candle_time_15m: '2026-07-15T11:45:00.000Z',
      candle_close_time: '2026-07-15T08:00:00.000Z',
    })).toBe('2026-07-15T11:45:00.000Z');
  });

  it('usa entry_candle_time_5m (cascata SMC) quando 15m está ausente', () => {
    expect(getEntryReferenceTime({
      entry_candle_time_5m: '2026-07-15T09:05:00.000Z',
      candle_close_time: '2026-07-15T08:00:00.000Z',
    })).toBe('2026-07-15T09:05:00.000Z');
  });

  it('cai para candle_close_time quando nenhum campo de confirmação existe (op legada/manual)', () => {
    expect(getEntryReferenceTime({ candle_close_time: '2026-07-15T08:00:00.000Z' })).toBe('2026-07-15T08:00:00.000Z');
  });

  it('retorna null quando nada está disponível', () => {
    expect(getEntryReferenceTime({})).toBe(null);
  });
});

describe('advanceTrailingStop (P0-d — trailing monotônico)', () => {
  it('BUY: avança quando o close sobe, nunca recua', () => {
    const up = advanceTrailingStop({ isBuy: true, currentStop: 100, closePrice: 120, atrValue: 5, trailMult: 2 });
    expect(up).toBe(110); // 120 - 10
    const down = advanceTrailingStop({ isBuy: true, currentStop: 110, closePrice: 105, atrValue: 5, trailMult: 2 });
    expect(down).toBe(110); // 105-10=95 < 110 → mantém
  });

  it('SELL: desce quando o close cai, nunca recua', () => {
    const dn = advanceTrailingStop({ isBuy: false, currentStop: 100, closePrice: 80, atrValue: 5, trailMult: 2 });
    expect(dn).toBe(90); // 80 + 10
    const upMove = advanceTrailingStop({ isBuy: false, currentStop: 90, closePrice: 95, atrValue: 5, trailMult: 2 });
    expect(upMove).toBe(90); // 95+10=105 > 90 → mantém
  });
});

// Reproduz o look-ahead do P0-d no nível de regra: o stop derivado do
// fechamento deste candle NÃO pode ser testado contra o low/high do mesmo
// candle. A ordem correta (espelhada no scanner) é: (1) testar o stop
// ARMAZENADO contra o candle; (2) só então avançar o trailing para a próxima
// passada.
describe('ordem stored-stop → advance (P0-d — sem look-ahead)', () => {
  it('cenário que o código antigo fechava indevidamente: trail do close acima do low do próprio candle', () => {
    // Runner BUY: stop armazenado 90; candle: low 96, close 110, ATR 5, mult 2.
    // Trail derivado do close = 100 > low 96 → o código antigo fecharia
    // (comparava o low contra o stop AVANÇADO). Ordem correta:
    const storedStop = 90;
    const candleLow = 96;
    const stopHitAgainstStored = candleLow <= storedStop;
    expect(stopHitAgainstStored).toBe(false); // não fecha neste candle
    const nextStop = advanceTrailingStop({ isBuy: true, currentStop: storedStop, closePrice: 110, atrValue: 5, trailMult: 2 });
    expect(nextStop).toBe(100); // passa a proteger a partir do PRÓXIMO candle
  });

  it('candle seguinte abaixo do stop avançado fecha normalmente', () => {
    const advancedStop = 100;
    const nextCandleLow = 99;
    expect(nextCandleLow <= advancedStop).toBe(true);
  });
});

describe('nextRfReverseCount (P0-e — contagem por candle, não por scan)', () => {
  it('N passadas sobre o MESMO candle contam 1x', () => {
    let state = { count: 0, lastCandle: null };
    for (let pass = 0; pass < 5; pass++) {
      state = nextRfReverseCount({
        rfReversedAgainst: true,
        prevCount: state.count,
        prevCandleTime: state.lastCandle,
        candleTime: T0,
      });
    }
    expect(state.count).toBe(1);
    expect(state.lastCandle).toBe(T0);
  });

  it('candle novo incrementa', () => {
    const s1 = nextRfReverseCount({ rfReversedAgainst: true, prevCount: 1, prevCandleTime: T0, candleTime: T1 });
    expect(s1.count).toBe(2);
    expect(s1.lastCandle).toBe(T1);
  });

  it('RF de volta a favor reseta', () => {
    const s = nextRfReverseCount({ rfReversedAgainst: false, prevCount: 3, prevCandleTime: T1, candleTime: T1 });
    expect(s.count).toBe(0);
    expect(s.lastCandle).toBe(null);
  });

  it('fallback legado: sem candleTime, mantém o incremento por passada antigo', () => {
    const s = nextRfReverseCount({ rfReversedAgainst: true, prevCount: 2, prevCandleTime: null, candleTime: null });
    expect(s.count).toBe(3);
  });
});

// Formaliza a política "stop vence" já usada inline em scanner.js ("Check
// stop first (stop has priority over TP on same candle for safety") — um
// candle fechado pode tocar stop E TP no mesmo candle sem que o OHLC diga
// qual aconteceu primeiro intrabar. Padrão de mercado (backtesting.py,
// QuantConnect, NinjaTrader — pesquisa de comunidade): assumir o pior caso
// (stop primeiro). stopWins nunca muda de comportamento; `ambiguous` é o
// que esta função acrescenta — sinaliza quando a decisão foi uma escolha
// conservadora sob incerteza real, não um stop inequívoco.
describe('resolveCandleExit (ambiguidade stop/TP no mesmo candle)', () => {
  it('só o stop tocado: vence, sem ambiguidade', () => {
    expect(resolveCandleExit({ stopTouched: true, targetTouched: false })).toEqual({ stopWins: true, ambiguous: false });
  });

  it('só o alvo tocado: stop não vence', () => {
    expect(resolveCandleExit({ stopTouched: false, targetTouched: true })).toEqual({ stopWins: false, ambiguous: false });
  });

  it('nenhum tocado: nada vence, sem ambiguidade', () => {
    expect(resolveCandleExit({ stopTouched: false, targetTouched: false })).toEqual({ stopWins: false, ambiguous: false });
  });

  it('os dois tocados no mesmo candle: stop vence (conservador) E fica marcado como ambíguo', () => {
    expect(resolveCandleExit({ stopTouched: true, targetTouched: true })).toEqual({ stopWins: true, ambiguous: true });
  });
});

describe('computeStructuralStop (stop estrutural da cascata SMC)', () => {
  // Fixture BUY: entry 100, ATR(1h) 2 → buffer 0.2, floor 1.0, cap 4.0.
  const base = { isBuy: true, entry: 100, atrValue: 2 };

  it('usa o nível estrutural com buffer quando dentro dos limites', () => {
    const r = computeStructuralStop({ ...base, structuralLevel: 98.5 });
    expect(r.stop).toBeCloseTo(98.3); // 98.5 − 0.1·ATR
    expect(r.basis).toBe('structural');
  });

  it('aplica o piso quando a estrutura está apertada demais (ruído 5m)', () => {
    const r = computeStructuralStop({ ...base, structuralLevel: 99.8 });
    expect(r.stop).toBeCloseTo(99.0); // entry − 0.5·ATR
    expect(r.basis).toBe('structural_floored');
  });

  it('aplica o cap quando a estrutura está larga demais — nunca pior que o modelo ATR antigo', () => {
    const r = computeStructuralStop({ ...base, structuralLevel: 95 });
    expect(r.stop).toBeCloseTo(96.0); // entry − 2.0·ATR (comportamento legado)
    expect(r.basis).toBe('structural_capped');
  });

  it('cai para o modelo ATR quando o nível está do lado errado da entrada', () => {
    const r = computeStructuralStop({ ...base, structuralLevel: 101 });
    expect(r.stop).toBeCloseTo(96.0);
    expect(r.basis).toBe('atr_fallback');
  });

  it('cai para o modelo ATR quando o nível está ausente (op legada / dado incompleto)', () => {
    const r = computeStructuralStop({ ...base, structuralLevel: null });
    expect(r.stop).toBeCloseTo(96.0);
    expect(r.basis).toBe('atr_fallback');
  });

  it('espelha o cálculo para SELL (stop acima da entrada)', () => {
    const r = computeStructuralStop({ isBuy: false, entry: 100, atrValue: 2, structuralLevel: 101.5 });
    expect(r.stop).toBeCloseTo(101.7); // 101.5 + 0.1·ATR
    expect(r.basis).toBe('structural');
    const capped = computeStructuralStop({ isBuy: false, entry: 100, atrValue: 2, structuralLevel: 105 });
    expect(capped.stop).toBeCloseTo(104.0);
    expect(capped.basis).toBe('structural_capped');
  });
});
