import { describe, it, expect } from 'vitest';
import { analyzeMonth, explainMonth, compareMonths, fmtPct, fmtR, fmtDuration, opDurationMs, costModelText } from './monthlyInsights.js';
import { summarizeOps } from './tradeMetrics.js';

const T0 = '2026-11-02T10:00:00.000Z';
const at = (h) => new Date(new Date(T0).getTime() + h * 3600000).toISOString();

// BUY 100, stop 90 (risco 10), exit informado → pnl bruto = exit-100 %.
const mk = (id, symbol, exit, status, hOpen = 0, hClose = 5, side = 'BUY') => ({
  id, symbol, side, status, entry_price: 100, initial_stop: side === 'BUY' ? 90 : 110, current_stop: side === 'BUY' ? 90 : 110,
  tp1: side === 'BUY' ? 110 : 90, tp2: side === 'BUY' ? 120 : 80, exit_price: exit,
  created_date: at(hOpen), closed_at: at(hClose),
});
const win = (id, symbol = 'BTCUSDT', exit = 112) => mk(id, symbol, exit, 'TP2_HIT');
const loss = (id, symbol = 'ETHUSDT', exit = 90) => mk(id, symbol, exit, 'STOP_HIT');

describe('formatadores', () => {
  it('fmtPct/fmtR com sinal e traço para ausente', () => {
    expect(fmtPct(1.234)).toBe('+1.23%');
    expect(fmtPct(-0.5)).toBe('-0.50%');
    expect(fmtPct(null)).toBe('—');
    expect(fmtPct(NaN)).toBe('—');
    expect(fmtR(0.125)).toBe('+0.13R');
    expect(fmtR(undefined)).toBe('—');
  });
  it('fmtDuration cobre minutos, horas e dias; inválido vira null', () => {
    expect(fmtDuration(30 * 1000)).toBe('1 min');
    expect(fmtDuration(35 * 60000)).toBe('35 min');
    expect(fmtDuration(6 * 3600000)).toBe('6 h');
    expect(fmtDuration(50 * 3600000)).toBe('2 d 2 h');
    expect(fmtDuration(48 * 3600000)).toBe('2 d');
    expect(fmtDuration(-1)).toBeNull();
    expect(fmtDuration(NaN)).toBeNull();
  });
  it('opDurationMs: diferença entre abertura e fechamento; sem horário ou negativa = null', () => {
    expect(opDurationMs(win('a'))).toBe(5 * 3600000);
    expect(opDurationMs({ created_date: at(5), closed_at: at(1), status: 'TP2_HIT' })).toBeNull();
    expect(opDurationMs({ status: 'TP2_HIT' })).toBeNull();
  });
});

describe('analyzeMonth — os números são os do summarizeOps (fonte única)', () => {
  const ops = [win('1'), win('2', 'SOLUSDT'), loss('3'), loss('4', 'BTCUSDT', 95)];
  it('bate com summarizeOps campo a campo', () => {
    const a = analyzeMonth(ops);
    const s = summarizeOps(ops);
    expect(a.totalPnl).toBe(s.totalPnlPct);
    expect(a.winRate).toBe(s.winRate);
    expect(a.maxDrawdownPct).toBe(s.maxDrawdownPct);
    expect(a.profitFactor).toBe(s.profitFactor);
    expect(a.n).toBe(4);
  });
  it('por ativo SOMA exatamente o resultado do mês (aditividade) e conta todas as operações', () => {
    const a = analyzeMonth(ops);
    expect(a.byAsset.reduce((x, g) => x + g.pnl, 0)).toBeCloseTo(a.totalPnl, 9);
    expect(a.byAsset.reduce((x, g) => x + g.n, 0)).toBe(a.counted);
    expect(a.bySide.reduce((x, g) => x + g.pnl, 0)).toBeCloseTo(a.totalPnl, 9);
  });
  it('por ativo vem do mais para o menos lucrativo', () => {
    const a = analyzeMonth(ops);
    const pnls = a.byAsset.map((g) => g.pnl);
    expect([...pnls].sort((x, y) => y - x)).toEqual(pnls);
  });
  it('melhor e pior operação são as extremas', () => {
    const a = analyzeMonth(ops);
    expect(a.bestPct).toBeGreaterThan(0);
    expect(a.worstPct).toBeLessThan(0);
    expect(a.bestTrade.pnl).toBe(a.bestPct);
    expect(a.worstTrade.pnl).toBe(a.worstPct);
  });
  it('duração média considera só operações com os dois horários', () => {
    const a = analyzeMonth([win('1'), { ...win('2'), closed_at: null, tp2_hit_at: null }]);
    expect(a.durationsCounted).toBeGreaterThanOrEqual(1);
    expect(a.avgDurationMs).toBe(5 * 3600000);
  });
  it('lista vazia não explode', () => {
    const a = analyzeMonth([]);
    expect(a.n).toBe(0);
    expect(a.byAsset).toEqual([]);
    expect(a.bestTrade).toBeNull();
    expect(a.avgDurationMs).toBeNull();
  });
});

describe('explainMonth — só afirma o que os números sustentam', () => {
  it('amostra pequena: diz que não prova vantagem, mesmo com mês positivo', () => {
    const e = explainMonth(analyzeMonth([win('1'), win('2'), loss('3', 'ETHUSDT', 95)]));
    expect(e.tone).toBe('positive');
    expect(e.headline).toMatch(/^Mês positivo: \+/);
    expect(e.lines[0]).toMatch(/Amostra pequena: 3 operações contadas/);
    expect(e.lines[0]).toMatch(/não prova/);
    expect(e.lines.join(' ')).not.toMatch(/tem vantagem comprovada|a estratégia funciona/);
  });
  it('singular: 1 operação fechada', () => {
    const e = explainMonth(analyzeMonth([win('1')]));
    expect(e.headline).toMatch(/em 1 operação fechada$/);
    expect(e.lines[0]).toMatch(/1 operação contada/);
  });
  it('mês negativo tem tom negativo', () => {
    const e = explainMonth(analyzeMonth([loss('1'), loss('2', 'BTCUSDT')]));
    expect(e.tone).toBe('negative');
    expect(e.headline).toMatch(/^Mês negativo: -/);
    expect(e.lines.join(' ')).toMatch(/Não houve nenhum ganho/);
  });
  it('mês só com ganhos avisa que isso é pouco informativo', () => {
    const e = explainMonth(analyzeMonth([win('1'), win('2')]));
    expect(e.lines.join(' ')).toMatch(/nenhuma perda/);
  });
  it('mês positivo sustentado por UMA operação diz isso e mostra o resultado sem ela', () => {
    const ops = [win('1', 'BTCUSDT', 130), loss('2', 'ETHUSDT', 90), loss('3', 'SOLUSDT', 92)];
    const e = explainMonth(analyzeMonth(ops));
    expect(e.lines.join(' ')).toMatch(/só ficou positivo por causa de uma operação \(BTC/);
    expect(e.lines.join(' ')).toMatch(/sem ela, o resultado seria -/);
  });
  it('concentração ≥50% sem inverter o sinal: mostra a fatia', () => {
    const ops = [win('1', 'BTCUSDT', 120), win('2', 'ETHUSDT', 103), loss('3', 'SOLUSDT', 99)];
    const a = analyzeMonth(ops);
    expect(a.totalPnl - a.bestTrade.pnl).toBeGreaterThan(0);
    const e = explainMonth(a);
    expect(e.lines.join(' ')).toMatch(/responde por \d+% do resultado/);
  });
  it('não menciona concentração quando o ganho é bem distribuído', () => {
    const ops = [win('1', 'BTCUSDT', 105), win('2', 'ETHUSDT', 105), win('3', 'SOLUSDT', 105), loss('4', 'XRPUSDT', 99)];
    const e = explainMonth(analyzeMonth(ops));
    expect(e.lines.join(' ')).not.toMatch(/responde por|só ficou positivo/);
  });
  it('relaciona acerto e tamanho do ganho/perda só quando há ganho E perda', () => {
    const e = explainMonth(analyzeMonth([win('1', 'BTCUSDT', 110), loss('2', 'ETHUSDT', 95)]));
    expect(e.lines.join(' ')).toMatch(/Acertou 50% das operações; cada ganho valeu em média \d,\d\d× cada perda/);
  });
  it('pior trecho e custos aparecem quando existem', () => {
    const e = explainMonth(analyzeMonth([loss('1'), win('2')]));
    expect(e.lines.join(' ')).toMatch(/pior trecho do mês tirou/);
    expect(e.lines.join(' ')).toMatch(/Taxas, slippage e funding estimados já estão descontados/);
  });
  it('onde nasceu o resultado só nomeia quem ajudou/pesou de verdade', () => {
    const e = explainMonth(analyzeMonth([win('1', 'BTCUSDT'), loss('2', 'ETHUSDT')]));
    const txt = e.lines.join(' ');
    expect(txt).toMatch(/Quem mais ajudou: BTC/);
    expect(txt).toMatch(/quem mais pesou: ETH/);
    const so = explainMonth(analyzeMonth([win('1', 'BTCUSDT'), win('2', 'ETHUSDT', 105)])).lines.join(' ');
    expect(so).not.toMatch(/pesou/);
  });
  it('nota: operações abertas, mês em andamento e sem saída registrada', () => {
    const base = analyzeMonth([win('1')]);
    expect(explainMonth(base).note).toBeNull();
    const n = explainMonth(base, { partial: true, openCount: 2 }).note;
    expect(n).toMatch(/2 operações abertas neste mês ainda não fecharam e não entram/);
    expect(n).toMatch(/mês ainda está em andamento/);
    expect(explainMonth(base, { openCount: 1 }).note).toMatch(/1 operação aberta neste mês ainda não fechou e não entra/);
    const unk = analyzeMonth([win('1'), { ...win('2'), exit_price: null }]);
    if (unk.unknown > 0) expect(explainMonth(unk).note).toMatch(/sem preço de saída/);
  });
  it('amostra de 30+ com média dentro da margem de erro: inconclusivo (não conclui vantagem)', () => {
    const ops = [];
    for (let i = 0; i < 30; i++) ops.push(i % 2 === 0 ? win(`w${i}`, 'BTCUSDT', 105) : loss(`l${i}`, 'ETHUSDT', 96));
    const a = analyzeMonth(ops);
    expect(a.inconclusiveReason).toBe('ci_straddles_zero');
    const e = explainMonth(a);
    expect(e.lines[0]).toMatch(/cabe na margem de erro/);
    expect(e.lines[0]).toMatch(/ainda não dá para dizer se há vantagem/);
  });
});

describe('compareMonths', () => {
  it('sem um dos meses não compara', () => {
    expect(compareMonths(analyzeMonth([win('1')]), null)).toBeNull();
    expect(compareMonths(null, analyzeMonth([win('1')]))).toBeNull();
  });
  it('diz quem melhorou, e para "pior trecho" menos é melhor', () => {
    const cur = analyzeMonth([win('1'), win('2')]);
    const prev = analyzeMonth([loss('3'), loss('4', 'BTCUSDT')]);
    const rows = compareMonths(cur, prev);
    const by = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(by['Resultado do mês'].better).toBe(true);
    expect(by['Taxa de acerto'].better).toBe(true);
    expect(by['Operações fechadas'].better).toBeNull(); // 2 × 2
    const more = Object.fromEntries(compareMonths(analyzeMonth([win('1'), win('2'), win('3')]), prev).map((r) => [r.label, r]));
    expect(more['Operações fechadas'].better).toBeNull(); // 3 × 2: mais operações não é melhor nem pior
    expect(by['Pior trecho'].better).toBe(true); // 0 de queda agora × queda antes
  });
  it('igualdade não é nem melhor nem pior', () => {
    const a = analyzeMonth([win('1')]);
    const rows = compareMonths(a, a);
    expect(rows.every((r) => r.better === null)).toBe(true);
  });
});

describe('costModelText', () => {
  it('lê o modelo padrão (não números soltos)', () => {
    expect(costModelText()).toMatch(/taxa de 0,05% na entrada e 0,05% na saída/);
    expect(costModelText()).toMatch(/slippage de 0,01% por lado/);
  });
});
