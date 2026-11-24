import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTvTrades, compareTvToSentinel, tvExitReason, sentinelExitReason, tvChartCsvToCandles, aggregateDailyFrom4h, splitCsvLine } from './tvParity.js';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '__fixtures__/tv');
const REAL_CSV = fs.readFileSync(path.join(DIR, 'tv-trades-ne-rf-v13.2-btcusdt-4h-2026-11-24.csv'), 'utf8');
const SEN = JSON.parse(fs.readFileSync(path.join(DIR, 'sentinel-modo-pine-btc4h-2025-02-a-2026-11.json'), 'utf8'));

const PT_HEAD = 'Número da negociação,Tipo,Data e hora,Sinal,Preço USDT,Tamanho (qtd),Tamanho (valor),L&P líquido USDT';
const EN_HEAD = 'Trade #,Type,Date/Time,Signal,Price USDT,Size (qty),Size (value),Net P&L USDT';

describe('parseTvTrades', () => {
  it('lista real do usuário (português, com BOM): 311 negociações viram 183 posições; 128 têm 2 fatias (TP1 + o resto)', () => {
    const { positions, tradeRows } = parseTvTrades(REAL_CSV);
    expect(tradeRows).toBe(311);
    expect(positions).toHaveLength(183);
    expect(positions.filter((p) => p.exits.length === 2)).toHaveLength(128);
    expect(positions[0]).toMatchObject({ entryTime: '2017-09-02 12:00', side: 'SELL', entryPrice: 4460.18 });
    expect(positions.at(-1)).toMatchObject({ entryTime: '2026-11-05 12:00', side: 'SELL' });
    // o resultado líquido total da lista (a última linha acumulada do TradingView é -31,23)
    expect(positions.reduce((s, p) => s + p.pnl, 0)).toBeCloseTo(-31.24, 1);
  });

  it('também lê os cabeçalhos em inglês', () => {
    const csv = [EN_HEAD, '1,Exit long,2025-01-02 08:00,TP1,110,1,100,10', '1,Entry long,2025-01-01 00:00,BUY,100,1,100,10'].join('\n');
    const { positions } = parseTvTrades(csv);
    expect(positions).toEqual([expect.objectContaining({ entryTime: '2025-01-01 00:00', side: 'BUY', pnl: 10, pct: 10 })]);
  });

  it('coluna obrigatória ausente: erro claro (nada de adivinhar)', () => {
    expect(() => parseTvTrades('A,B\n1,2')).toThrow(/coluna obrigatória ausente/);
  });

  it('splitCsvLine respeita aspas', () => {
    expect(splitCsvLine('a,"b,c",d')).toEqual(['a', 'b,c', 'd']);
  });
});

describe('motivos de saída', () => {
  const pos = (...signals) => ({ exits: signals.map((s, i) => ({ time: `2025-01-0${i + 2} 00:00`, signal: s, price: 1, pnl: 0 })) });
  it('TradingView', () => {
    expect(tvExitReason(pos('TP1', 'RUNNER'))).toBe('stop_after_tp1');
    expect(tvExitReason(pos('TP1', 'RF EXIT'))).toBe('rf_exit');
    expect(tvExitReason(pos('SL', 'SL'))).toBe('stop');
    expect(tvExitReason(pos('TIME STOP 64b'))).toBe('time_stop');
    expect(tvExitReason(pos('SELL'))).toBe('reversal');
  });
  it('Sentinel', () => {
    expect(sentinelExitReason({ status: 'STOP_HIT', tp1_hit: true })).toBe('stop_after_tp1');
    expect(sentinelExitReason({ status: 'STOP_HIT', tp1_hit: false })).toBe('stop');
    expect(sentinelExitReason({ status: 'INVALIDATED', tp1_hit: true })).toBe('rf_exit');
    expect(sentinelExitReason({ status: 'CLOSED', closed_reason: 'TIME_STOP' })).toBe('time_stop');
    expect(sentinelExitReason({ status: 'TP2_HIT' })).toBe('tp2');
  });
});

describe('compareTvToSentinel com os dados reais (modo Pine do Sentinel × a lista do usuário, BTC 4h, 02/2025 a 11/2026)', () => {
  const { positions } = parseTvTrades(REAL_CSV);
  const r = compareTvToSentinel(positions, SEN.overall.curve, { from: '2025-02-03 00:00' });

  it('as 33 entradas coincidem (hora da barra + lado), nenhuma só de um lado', () => {
    expect(r.tvPositions).toBe(33);
    expect(r.sentinelOps).toBe(33);
    expect(r.sameEntry).toBe(33);
    expect(r.onlyTv).toHaveLength(0);
    expect(r.onlySentinel).toHaveLength(0);
  });

  it('a maioria das saídas finais coincide no preço (27 de 33) e as 6 diferentes têm causa nomeada', () => {
    expect(r.sameExit).toBe(27);
    expect(r.differing).toHaveLength(6);
    // causas conhecidas (item 308): time stop com o tier lido a cada barra no Pine (congelado na entrada no Sentinel) e a ordem entre stop e virada de sinal na mesma barra
    for (const k of Object.keys(r.byCause)) expect(k).toMatch(/time_stop|reversal|stop/);
  });

  it('o retorno somado das posições fica na mesma ordem de grandeza', () => {
    expect(Math.abs(r.tvPctSum - r.sentinelPctSum)).toBeLessThan(5);
  });

  it('não-vacuidade: uma entrada trocada de lado aparece como "só de um lado"', () => {
    const curve = JSON.parse(JSON.stringify(SEN.overall.curve));
    curve[0].op.side = curve[0].op.side === 'BUY' ? 'SELL' : 'BUY';
    const bad = compareTvToSentinel(positions, curve, { from: '2025-02-03 00:00' });
    expect(bad.sameEntry).toBe(32);
    expect(bad.onlyTv).toHaveLength(1);
    expect(bad.onlySentinel).toHaveLength(1);
  });

  it('não-vacuidade: preço de saída diferente derruba a conta de "mesma saída"', () => {
    const curve = JSON.parse(JSON.stringify(SEN.overall.curve));
    const alvo = r.rows.find((x) => x.sameExit).entryTime;
    const item = curve.find((c) => c.op.candle_open_time.slice(0, 16).replace('T', ' ') === alvo);
    item.op.exit_price *= 1.05;
    expect(compareTvToSentinel(positions, curve, { from: '2025-02-03 00:00' }).sameExit).toBe(26);
  });
});

describe('conversão do CSV do gráfico para candles do backtest', () => {
  const H = 4 * 3600 * 1000;
  const csv = ['time,open,high,low,close,Volume', '2025-01-01T00:00:00Z,1,2,0.5,1.5,10', '2025-01-01T04:00:00Z,1.5,3,1,2,20', '2025-01-01T08:00:00Z,2,2,2,2,5'].join('\n');
  it('descarta a última linha (barra ao vivo) e calcula closeTime', () => {
    const c = tvChartCsvToCandles(csv, H);
    expect(c).toHaveLength(2);
    expect(c[0]).toMatchObject({ openTime: Date.parse('2025-01-01T00:00:00Z'), closeTime: Date.parse('2025-01-01T04:00:00Z') - 1, isClosed: true, volume: 10 });
  });
  it('1d a partir do 4h: só dias com as 6 barras', () => {
    const mk = (n) => Array.from({ length: n }, (_, i) => ({ openTime: Date.parse('2025-01-01T00:00:00Z') + i * H, open: i, high: i + 1, low: i - 1, close: i + 0.5, volume: 1, closeTime: 0, isClosed: true }));
    expect(aggregateDailyFrom4h(mk(5))).toHaveLength(0);
    const d = aggregateDailyFrom4h(mk(6));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ open: 0, high: 6, low: -1, close: 5.5, volume: 6 });
  });
});
