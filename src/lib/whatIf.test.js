import { describe, it, expect } from 'vitest';
import {
  PARAM_KEYS, datasetKey, requestKey, sweepValues, runKey, sameParams, changedKeys, summarizeRun, loadHistory, saveHistory, addRun, toggleStar, removeRun, rankRuns, bestRun, overfitNote,
  compareSummaries, assessCandles, timeframeMs, detectTier, buildDefaults, fidelityRows, reevaluationTargets, sensitivityValues, sweepParam, judgeSensitivity,
  buildTradeChart, rHistogram, exitBreakdown, sideBreakdown, HISTORY_CAP,
} from './whatIf';

const DS = { assetId: 'a1', symbol: 'BTCUSDT', timeframe: '4h', candleCount: 500 };
const P = { atrMult: 2, tp1R: 1.5, rfPeriod: 20, rfMult: 3.5, minScore: 75, minRR: 1.2, regime: 1, timeStop: 1, trail: 1, trailStart: 1, trailDist: 2, runnerTrail: 1, runnerTrailDist: 2, runnerRf: 1 };
const rec = (over = {}, at = '2026-11-22T10:00:00.000Z', exp = 0.1) => ({
  key: runKey(DS, { ...P, ...over }), at, dataset: DS, params: { ...P, ...over },
  summary: { expectancyR: exp, counted: 10, winRate: 50, profitFactor: 1.2, maxDrawdownPct: 5, ciHalfWidth: 0.2 }, starred: false,
});
const mem = () => { const m = {}; return { getItem: (k) => m[k] ?? null, setItem: (k, v) => { m[k] = v; }, _m: m }; };

describe('identidade e parâmetros', () => {
  it('a chave muda com a janela e com cada parâmetro, e ignora ruído de ponto flutuante', () => {
    expect(runKey(DS, P)).toBe(runKey(DS, { ...P, tp1R: 1.5000001 }));
    for (const k of PARAM_KEYS) expect(runKey(DS, { ...P, [k]: P[k] + 1 })).not.toBe(runKey(DS, P));
    expect(runKey({ ...DS, timeframe: '1h' }, P)).not.toBe(runKey(DS, P));
    expect(requestKey(DS)).toBe('a1|4h|500');
    expect(datasetKey(DS)).toBe('a1|4h|500|x');
    expect(datasetKey({ ...DS, windowEnd: 123 })).toBe('a1|4h|500|123');
  });
  it('sameParams / changedKeys', () => {
    expect(sameParams(P, { ...P })).toBe(true);
    expect(changedKeys({ ...P, minScore: 80, tp1R: 2 }, P)).toEqual(['tp1R', 'minScore']);
    expect(changedKeys(P, P)).toEqual([]);
  });
  it('trailing desligado: começo e distância dele NÃO contam (não viram "outro teste" nem "diferente do padrão")', () => {
    const off = { ...P, trail: 0 };
    expect(runKey(DS, { ...off, trailStart: 0.5, trailDist: 4 })).toBe(runKey(DS, { ...off, trailStart: 1, trailDist: 2 }));
    expect(sameParams({ ...off, trailStart: 0.5 }, off)).toBe(true);
    expect(changedKeys({ ...off, trailStart: 0.5, trailDist: 4 }, off)).toEqual([]);
    // ligado, os valores contam; e ligar/desligar é uma mudança
    expect(runKey(DS, { ...P, trailDist: 3 })).not.toBe(runKey(DS, P));
    expect(changedKeys(off, P)).toEqual(['trail']); // ligar/desligar é UMA mudança (começo e distância não contam à parte)
    // o runner segue a mesma regra: desligado, a distância dele não existe
    const runnerOff = { ...P, runnerTrail: 0 };
    expect(changedKeys({ ...runnerOff, runnerTrailDist: 4 }, runnerOff)).toEqual([]);
    expect(changedKeys(runnerOff, P)).toEqual(['runnerTrail']);
    expect(changedKeys({ ...P, runnerTrailDist: 3, minRR: 1.5, runnerRf: 0 }, P)).toEqual(['minRR', 'runnerTrailDist', 'runnerRf']);
    expect(changedKeys({ ...P, trailStart: 1.5, trailDist: 3 }, P)).toEqual(['trailStart', 'trailDist']);
  });
  it('summarizeRun guarda só números válidos', () => {
    const s = summarizeRun({ expectancyR: NaN, winRate: 40, counted: 7, expectancyRCI95HalfWidth: 0.3, conclusive: false });
    expect(s.expectancyR).toBeNull(); expect(s.winRate).toBe(40); expect(s.ciHalfWidth).toBe(0.3); expect(s.counted).toBe(7);
    expect(summarizeRun(undefined).counted).toBe(0);
  });
});

describe('histórico de testes', () => {
  it('grava e relê; dado corrompido ou inválido vira lista vazia/filtrada, sem quebrar', () => {
    const st = mem();
    expect(saveHistory(st, [rec()])).toBe(true);
    expect(loadHistory(st)).toHaveLength(1);
    st.setItem('sentinel_whatif_history_v1', '{ não é json');
    expect(loadHistory(st)).toEqual([]);
    st.setItem('sentinel_whatif_history_v1', JSON.stringify({ v: 1, runs: [rec(), { key: 'x' }, null] }));
    expect(loadHistory(st)).toHaveLength(1);
    expect(loadHistory(null)).toEqual([]);
  });
  it('saveHistory devolve false quando o armazenamento falha (cheio/bloqueado)', () => {
    expect(saveHistory({ setItem() { throw new Error('cheio'); } }, [rec()])).toBe(false);
  });
  it('o mesmo teste (mesma chave) atualiza em vez de duplicar, e preserva a estrela', () => {
    let h = addRun([], rec());
    h = toggleStar(h, h[0].key);
    h = addRun(h, rec({}, '2026-11-22T11:00:00.000Z', 0.3));
    expect(h).toHaveLength(1);
    expect(h[0].starred).toBe(true);
    expect(h[0].summary.expectancyR).toBe(0.3);
    expect(h[0].at).toBe('2026-11-22T11:00:00.000Z');
  });
  it('teto: favoritos nunca saem; do resto ficam os mais recentes', () => {
    let h = [];
    for (let i = 0; i < 10; i++) h = addRun(h, rec({ minScore: 50 + i }, `2026-11-22T10:${String(i).padStart(2, '0')}:00.000Z`), 5);
    expect(h).toHaveLength(5);
    expect(h.map((r) => r.params.minScore)).toEqual([59, 58, 57, 56, 55]);
    const starKey = h[4].key;
    h = toggleStar(h, starKey);
    h = addRun(h, rec({ minScore: 90 }, '2026-11-22T12:00:00.000Z'), 5);
    expect(h.some((r) => r.key === starKey)).toBe(true);
    expect(h).toHaveLength(5);
    expect(HISTORY_CAP).toBeGreaterThan(20);
  });
  it('mesmos valores em outra janela de dados (vela nova fechou) NÃO duplica: o teste é um só, com o resultado mais novo (pedido do usuário, 23/11)', () => {
    const w1 = { ...DS, windowEnd: 1000 }; const w2 = { ...DS, windowEnd: 2000 };
    const a = { ...rec({}, '2026-11-22T10:00:00.000Z', 0.5), dataset: w1, key: runKey(w1, P) };
    const b = { ...rec({}, '2026-11-22T14:00:00.000Z', -0.2), dataset: w2, key: runKey(w2, P) };
    expect(a.key).toBe(b.key); // mesma identidade: só pedido + valores
    const h = addRun(addRun([], a), b);
    expect(h).toHaveLength(1);
    expect(h[0].summary.expectancyR).toBe(-0.2); // ficou o resultado da janela mais nova
    expect(h[0].dataset.windowEnd).toBe(2000);
  });
  it('mesmos valores em outro ATIVO, timeframe ou período continuam sendo testes diferentes', () => {
    expect(runKey({ ...DS, assetId: 'a2' }, P)).not.toBe(runKey(DS, P));
    expect(runKey({ ...DS, timeframe: '1h' }, P)).not.toBe(runKey(DS, P));
    expect(runKey({ ...DS, candleCount: 1000 }, P)).not.toBe(runKey(DS, P));
  });
  it('o ranking continua só comparando a JANELA atual: teste que ainda está com o resultado de uma janela antiga vai à parte (não comparável)', () => {
    const w1 = { ...DS, windowEnd: 1000 }; const w2 = { ...DS, windowEnd: 2000 };
    const old = { ...rec({ minScore: 60 }, '2026-11-22T10:00:00.000Z', 0.5), dataset: w1, key: runKey(w1, { ...P, minScore: 60 }) };
    const now = { ...rec({ minScore: 70 }, '2026-11-22T14:00:00.000Z', -0.2), dataset: w2, key: runKey(w2, { ...P, minScore: 70 }) };
    const r = rankRuns([old, now], w2);
    expect(r.same.map((x) => x.summary.expectancyR)).toEqual([-0.2]);
    expect(r.others.map((x) => x.summary.expectancyR)).toEqual([0.5]);
    expect(bestRun(r.same).summary.expectancyR).toBe(-0.2);
  });
  it('removeRun', () => {
    const h = addRun([], rec());
    expect(removeRun(h, h[0].key)).toEqual([]);
  });
  it('ranking: só compara a MESMA janela; outras vão à parte; melhor ignora quem não tem operação', () => {
    const other = { ...rec({ minScore: 60 }, '2026-11-22T09:00:00.000Z', 0.9), dataset: { ...DS, assetId: 'a2' }, key: 'outro' };
    const semOps = { ...rec({ minScore: 61 }), summary: { expectancyR: null, counted: 0 } };
    let h = [rec({ tp1R: 1 }, '2026-11-22T10:00:00.000Z', -0.1), rec({ tp1R: 2 }, '2026-11-22T10:01:00.000Z', 0.4), rec({ tp1R: 3 }, '2026-11-22T10:02:00.000Z', 0.2), other, semOps];
    const r = rankRuns(h, DS);
    expect(r.same.map((x) => x.summary.expectancyR)).toEqual([0.4, 0.2, -0.1, null]);
    expect(r.others).toHaveLength(1);
    expect(bestRun(r.same).summary.expectancyR).toBe(0.4);
    expect(bestRun([semOps])).toBeNull();
    expect(rankRuns(h, DS, 'recent').same[0].at).toBe('2026-11-22T10:02:00.000Z');
  });
  it('aviso de "melhor entre muitas tentativas" só a partir de 8 combinações', () => {
    expect(overfitNote(7)).toBeNull();
    expect(overfitNote(8)).toMatch(/8 combinações.*sorte/);
    expect(overfitNote(8)).toMatch(/não bloqueia nada/);
  });
});

describe('compareSummaries', () => {
  const a = { expectancyR: 0.12, winRate: 50, profitFactor: 1.4, maxDrawdownPct: 6, counted: 20, ciHalfWidth: 0.25 };
  const b = { expectancyR: 0.05, winRate: 45, profitFactor: 1.1, maxDrawdownPct: 8, counted: 18, ciHalfWidth: 0.3 };
  it('calcula deltas e diz quando a diferença cabe no ruído (maior meia-largura dos dois)', () => {
    const c = compareSummaries(a, b);
    expect(c.expectancyR.delta).toBeCloseTo(0.07);
    expect(c.noiseR).toBe(0.3);
    expect(c.expectancyR.withinNoise).toBe(true);
    expect(c.counted.delta).toBe(2);
    expect(compareSummaries({ ...a, expectancyR: 0.9 }, b).expectancyR.withinNoise).toBe(false);
  });
  it('amostra pequena demais para medir o ruído: noiseR null e NÃO afirma "dentro do ruído"', () => {
    const c = compareSummaries({ ...a, ciHalfWidth: null }, { ...b, ciHalfWidth: null });
    expect(c.noiseR).toBeNull();
    expect(c.expectancyR.withinNoise).toBe(false);
  });
  it('métrica ausente vira delta null', () => {
    expect(compareSummaries({ expectancyR: null }, b).expectancyR.delta).toBeNull();
  });
});

describe('assessCandles — conferência dos dados', () => {
  const H = 4 * 3600e3;
  const mk = (n, start = 1700000000000) => Array.from({ length: n }, (_, i) => ({ openTime: start + i * H, closeTime: start + (i + 1) * H - 1, open: 100, high: 101, low: 99, close: 100.5, volume: 10, isClosed: true }));
  const NOW = 1700000000000 + 100 * H;
  const get = (r, id) => r.checks.find((c) => c.id === id);

  it('série limpa: tudo ok', () => {
    const c = mk(100);
    const r = assessCandles({ raw: c, closed: c, requested: 100, timeframe: '4h', startIndex: 72, now: NOW });
    expect(r.level).toBe('ok');
    expect(get(r, 'span').detail).toMatch(/72 servem só para aquecer.*28 velas operáveis/);
  });
  it('detecta buraco, recebimento menor, vela aberta extra, ordem, preço inválido, volume zero e dado velho', () => {
    const c = mk(100);
    const gap = [...c.slice(0, 50), ...c.slice(53)]; // 3 velas faltando
    expect(get(assessCandles({ raw: gap, closed: gap, requested: 97, timeframe: '4h', now: NOW }), 'gaps')).toMatchObject({ status: 'attention' });
    expect(get(assessCandles({ raw: gap, closed: gap, requested: 97, timeframe: '4h', now: NOW }), 'gaps').detail).toMatch(/3 vela\(s\) faltando/);
    expect(get(assessCandles({ raw: c.slice(0, 90), closed: c.slice(0, 90), requested: 100, timeframe: '4h', now: NOW }), 'received').status).toBe('attention');
    expect(get(assessCandles({ raw: c, closed: c.slice(0, 97), requested: 100, timeframe: '4h', now: NOW }), 'closed').status).toBe('problem');
    const dup = [...c.slice(0, 10), c[9], ...c.slice(10, 20)];
    expect(get(assessCandles({ raw: dup, closed: dup, requested: 21, timeframe: '4h', now: NOW }), 'order').status).toBe('problem');
    const bad = mk(30); bad[5] = { ...bad[5], high: 90 };
    const rb = assessCandles({ raw: bad, closed: bad, requested: 30, timeframe: '4h', now: NOW });
    expect(get(rb, 'values').status).toBe('problem'); expect(rb.level).toBe('problem');
    const noVol = mk(40).map((x, i) => (i % 3 === 0 ? { ...x, volume: 0 } : x));
    expect(get(assessCandles({ raw: noVol, closed: noVol, requested: 40, timeframe: '4h', now: NOW }), 'volume').status).toBe('attention');
    expect(get(assessCandles({ raw: c, closed: c, requested: 100, timeframe: '4h', now: NOW + 10 * H }), 'fresh').status).toBe('attention');
  });
  it('timeframeMs conhece 1h/4h/1d', () => {
    expect([timeframeMs('1h'), timeframeMs('4h'), timeframeMs('1d'), timeframeMs('5m')]).toEqual([3600e3, 4 * 3600e3, 86400e3, null]);
  });
});

describe('tier e padrões', () => {
  const calm = Array.from({ length: 80 }, (_, i) => ({ open: 100, high: 100.2, low: 99.8, close: 100 + (i % 2) * 0.1, volume: 1, closeTime: i, openTime: i }));
  const wild = Array.from({ length: 80 }, (_, i) => ({ open: 100, high: 104, low: 96, close: 100 + (i % 2) * 2, volume: 1, closeTime: i, openTime: i }));
  it('detectTier: ativo calmo = T1 (stop 2x); ativo agitado = T3 (stop 3x); dados curtos = null', () => {
    expect(detectTier(calm, {}).atrStopMult).toBe(2);
    expect(detectTier(wild, {}).atrStopMult).toBe(3);
    expect(detectTier(calm.slice(0, 10), {})).toBeNull();
  });
  it('buildDefaults: stop vem do tier (não do trailAtrMult); RF vem do ATIVO; resto do Pine', () => {
    const d = buildDefaults({ pineConfig: { trailAtrMult: 3, tp1R: 1.8, minScore: 80, rng_per: 20, rng_qty: 3.5 }, asset: { rf_period: 14, rf_multiplier: 3 }, tier: { atrStopMult: 2.5 } });
    expect(d).toEqual({ atrMult: 2.5, tp1R: 1.8, rfPeriod: 14, rfMult: 3, minScore: 80, minRR: 1.2, regime: 1, timeStop: 1, trail: 1, trailStart: 1, trailDist: 2, runnerTrail: 1, runnerTrailDist: 3, runnerRf: 1 });
    expect(buildDefaults({})).toEqual({ atrMult: 2, tp1R: 1.5, rfPeriod: 20, rfMult: 3.5, minScore: 75, minRR: 1.2, regime: 1, timeStop: 1, trail: 1, trailStart: 1, trailDist: 2, runnerTrail: 1, runnerTrailDist: 2, runnerRf: 1 });
    // os interruptores seguem a PRODUÇÃO: tudo desligado no Pine salvo => desligado aqui
    expect(buildDefaults({ pineConfig: { useADX: false, useChop: false, useTimeStop: false } })).toMatchObject({ regime: 0, timeStop: 0 });
    expect(buildDefaults({ pineConfig: { useADX: false, useChop: true } }).regime).toBe(1);
  });
  it('buildDefaults: runner e piso R:R seguem a PRODUÇÃO (exit_mode HYBRID_RF_ATR: trailing por ATR + saída pelo RF; minRR do Pine salvo)', () => {
    expect(buildDefaults({ pineConfig: { trailAtrMult: 2.5, minRR: 1.4 } })).toMatchObject({ runnerTrail: 1, runnerTrailDist: 2.5, runnerRf: 1, minRR: 1.4 });
    expect(buildDefaults({})).toMatchObject({ runnerTrail: 1, runnerTrailDist: 2, runnerRf: 1, minRR: 1.2 });
  });
  it('buildDefaults: trailing pré-TP1 segue a PRODUÇÃO (proteção mestre E modo trailing ligados) e os valores vêm do Pine salvo', () => {
    expect(buildDefaults({ pineConfig: { preTp1StopProtectionEnabled: true, preTp1TrailEnabled: true, preTp1TrailStartAtrMult: 1.5, preTp1TrailAtrMult: 2.5 } })).toMatchObject({ trail: 1, trailStart: 1.5, trailDist: 2.5 });
    expect(buildDefaults({ pineConfig: { preTp1TrailEnabled: false } }).trail).toBe(0);
    expect(buildDefaults({ pineConfig: { preTp1StopProtectionEnabled: false } }).trail).toBe(0); // sem a proteção mestre o scanner nem roda o bloco pré-TP1
  });
  it('fidelityRows: regime e time stop passam a ser feitos pelo simulador; o que falta continua declarado', () => {
    const f = fidelityRows({ useADX: true, useChop: true, useTimeStop: true, preTp1TrailEnabled: true, minRR: 1.2 }, { emaFast: 20, emaSlow: 50 }, { regime: 1, timeStop: 0 });
    expect(f.included.some((t) => /EMA 20\/50/.test(t))).toBe(true);
    expect(f.included.find((t) => /Filtro de regime/.test(t))).toMatch(/ligado neste teste.*produção: ligado/);
    expect(f.included.find((t) => /Time stop/.test(t))).toMatch(/desligado neste teste.*produção: ligado/);
    expect(f.notIncluded.some((n) => /ADX/.test(n.label))).toBe(false);
    expect(f.notIncluded.some((n) => /Trailing do stop antes do TP1/.test(n.label))).toBe(false); // agora é feito pelo simulador
    expect(fidelityRows({ preTp1TrailEnabled: true }, undefined, { regime: 1, timeStop: 1, trail: 1 }).included.find((t) => /Trailing do stop ANTES do TP1/.test(t))).toMatch(/ligado neste teste.*produção: ligado/);
    expect(fidelityRows({ preTp1TrailEnabled: false }, undefined, { regime: 1, timeStop: 1, trail: 0 }).included.find((t) => /Trailing do stop ANTES do TP1/.test(t))).toMatch(/desligado neste teste.*produção: desligado/);
    // runner e piso R:R agora são feitos pelo simulador; sobra o que a produção também não usa por padrão e o filtro 4h/15m
    expect(f.notIncluded.some((n) => /minRR|Piso/.test(n.label))).toBe(false);
    expect(f.notIncluded.some((n) => /Saída do runner/.test(n.label))).toBe(false);
    expect(f.included.find((t) => /Trailing do stop do RUNNER/.test(t))).toMatch(/desligado neste teste|ligado neste teste/);
    expect(f.included.find((t) => /Piso de risco\/retorno/.test(t))).toMatch(/1\.2R/);
    expect(f.notIncluded.find((n) => /Chop Exit/.test(n.label)).production).toMatch(/desligados por padrão/);
    expect(fidelityRows({ useADX: false, useChop: false, useTimeStop: false }).included.find((t) => /Filtro de regime/.test(t))).toMatch(/produção: desligado/);
  });
});

describe('sensibilidade', () => {
  it('sensitivityValues: 9 pontos, respeitando o passo e sem repetir', () => {
    const v = sensitivityValues({ min: 0.5, max: 5, step: 0.1 });
    expect(v).toHaveLength(9); expect(v[0]).toBe(0.5); expect(v[8]).toBe(5);
    expect(sensitivityValues({ min: 5, max: 50, step: 1 })).toEqual([5, 11, 16, 22, 28, 33, 39, 44, 50]);
    expect(sensitivityValues({ min: 1, max: 2, step: 1 })).toEqual([1, 2]); // sem repetir
  });
  it('REGRESSÃO (Codex, PR #617): a varredura SEMPRE inclui o valor atual (ex.: RF 20 não está nos 9 pontos padrão)', () => {
    const def = { min: 5, max: 50, step: 1 };
    expect(sensitivityValues(def)).not.toContain(20);
    const v = sweepValues(def, 20);
    expect(v).toContain(20);
    expect(v).toEqual([...v].sort((a, b) => a - b));
    expect(new Set(v).size).toBe(v.length);
    expect(sweepValues({ min: 0.5, max: 5, step: 0.1 }, 2.5)).toContain(2.5); // decimais sem ruído de ponto flutuante
    expect(sweepValues(def, 22)).toHaveLength(9); // já estava na grade: não duplica
  });
  it('sweepParam roda o simulador variando só UMA chave', () => {
    const seen = [];
    const r = sweepParam({ runSummary: (p) => { seen.push(p); return { expectancyR: p.tp1R, counted: 12 }; }, params: P, key: 'tp1R', values: [1, 2, 3] });
    expect(r.map((x) => x.summary.expectancyR)).toEqual([1, 2, 3]);
    expect(seen.every((p) => p.minScore === 75 && p.atrMult === 2)).toBe(true);
  });
  it('judgeSensitivity: ponta isolada × platô × amostra pequena', () => {
    const pt = (value, e, counted = 20, hw = 0.05) => ({ value, summary: { expectancyR: e, counted, ciHalfWidth: hw } });
    expect(judgeSensitivity([pt(1, -0.2), pt(2, 0.6), pt(3, -0.3)], 2).verdict).toBe('peak');
    expect(judgeSensitivity([pt(1, 0.2), pt(2, 0.22), pt(3, 0.21)], 2).verdict).toBe('plateau');
    expect(judgeSensitivity([pt(1, 0.3), pt(2, -0.1), pt(3, 0.3)], 2).verdict).toBe('mixed');
    expect(judgeSensitivity([pt(1, 0.2, 5), pt(2, 0.9, 5), pt(3, 0.2, 5)], 2).verdict).toBe('unknown');
    expect(judgeSensitivity([pt(1, 0.2)], 1).verdict).toBe('unknown');
    // o veredito é do valor EXATO da tela: valor ausente da varredura, ou sem operações, vira "unknown" (nunca avalia um vizinho no lugar)
    expect(judgeSensitivity([pt(1, -0.2), pt(2, 0.6), pt(3, -0.3)], 2.4).verdict).toBe('unknown');
    expect(judgeSensitivity([pt(1, 0.2), { value: 2, summary: { expectancyR: null, counted: 0 } }, pt(3, 0.2), pt(4, 0.2)], 2).verdict).toBe('unknown');
    // ordem de entrada não importa
    expect(judgeSensitivity([pt(3, -0.3), pt(1, -0.2), pt(2, 0.6)], 2).verdict).toBe('peak');
  });
});

describe('dados dos gráficos', () => {
  const op = (over) => ({ side: 'BUY', entry_price: 100, initial_stop: 98, tp1: 103, tp2: 106, partial_percent: 50, status: 'STOP_HIT', tp1_hit: false, exit_price: 98, created_date: 1000, closed_at: 2000, ...over });
  it('rHistogram: cada operação cai em exatamente 1 faixa', () => {
    const ops = [op(), op({ exit_price: 106, status: 'TP2_HIT', tp1_hit: true }), op({ exit_price: 100 })];
    const h = rHistogram(ops);
    expect(h.reduce((s, b) => s + b.count, 0)).toBe(3);
    expect(h.find((b) => b.label.startsWith('≤')).count).toBeGreaterThanOrEqual(1);
  });
  it('exitBreakdown separa TP2, TP1+breakeven e stop cheio, e as partes somam o total', () => {
    const ops = [op(), op(), op({ status: 'TP2_HIT', exit_price: 106, tp1_hit: true }), op({ tp1_hit: true, exit_price: 100 })];
    const b = exitBreakdown(ops);
    expect(b.map((x) => x.count)).toEqual([1, 1, 0, 0, 2, 0]); // TP2, TP1+stop do runner, saída RF, stop do trailing, stop cheio, time stop
    expect(b.reduce((s, x) => s + x.count, 0)).toBe(4);
    const withTs = exitBreakdown([...ops, op({ status: 'CLOSED', closed_reason: 'TIME_STOP', exit_price: 101, tp1_hit: false })]);
    expect(withTs.find((x) => x.key === 'time_stop').count).toBe(1);
    expect(withTs.reduce((s, x) => s + x.count, 0)).toBe(5);
    const withTrail = exitBreakdown([...ops, op({ pre_tp1_trailed: true, exit_price: 101 })]);
    expect(exitBreakdown([...ops, op({ status: 'INVALIDATED', tp1_hit: true, exit_price: 104 })]).find((x) => x.key === 'rf_exit').count).toBe(1); // saída do runner pelo Range Filter
    expect(withTrail.find((x) => x.key === 'stop_trail').count).toBe(1); // stop que subiu pelo trailing antes do TP1 não é "stop cheio"
    expect(withTrail.find((x) => x.key === 'stop').count).toBe(2);
    expect(b.find((x) => x.key === 'stop').avgR).toBeLessThan(0);
    expect(b.find((x) => x.key === 'tp2').avgR).toBeGreaterThan(0);
  });
  it('sideBreakdown e buildTradeChart', () => {
    const ops = [op(), op({ side: 'SELL', initial_stop: 102, entry_price: 100, exit_price: 94, tp1: 97, tp2: 94, status: 'TP2_HIT', tp1_hit: true, created_date: 3000, closed_at: 4000 })];
    const s = sideBreakdown(ops);
    expect(s.map((x) => x.count)).toEqual([1, 1]);
    const candles = [1000, 2000, 3000, 4000].map((t, i) => ({ closeTime: t, close: 100 + i }));
    const ch = buildTradeChart(candles, ops, 0);
    expect(ch.points).toHaveLength(4);
    expect(ch.trades).toHaveLength(2);
    expect(ch.trades[0]).toMatchObject({ entryI: 0, exitI: 1, side: 'BUY' });
    expect(buildTradeChart(candles, [op({ created_date: 99999 })], 0).trades).toEqual([]); // op fora da série: ignorada
  });
});

describe('migração e reavaliação do histórico', () => {
  it('teste gravado ANTES dos interruptores vale como regime=0/timeStop=0 e a chave é recalculada (sem perder nem duplicar)', () => {
    const st = mem();
    const legacyParams = { atrMult: 2, tp1R: 1.5, rfPeriod: 20, rfMult: 3.5, minScore: 75 };
    const legacy = { key: 'chave-antiga', at: '2026-11-22T10:00:00.000Z', dataset: DS, params: legacyParams, summary: { expectancyR: 0.3, counted: 9 }, starred: true };
    st.setItem('sentinel_whatif_history_v1', JSON.stringify({ v: 1, runs: [legacy] }));
    const h = loadHistory(st);
    expect(h).toHaveLength(1);
    expect(h[0].params).toMatchObject({ regime: 0, timeStop: 0, minScore: 75 });
    expect(h[0].key).toBe(runKey(DS, { ...legacyParams, regime: 0, timeStop: 0, trail: 0, runnerTrail: 0, runnerRf: 0, minRR: 0 }));
    expect(h[0].params).toMatchObject({ regime: 0, timeStop: 0, trail: 0, runnerTrail: 0, runnerRf: 0, minRR: 0 }); // runner só no TP2/breakeven e sem piso R:R: vale tudo desligado // antes do trailing o stop ficava parado: vale trailing desligado
    expect(h[0].starred).toBe(true);
    // o mesmo teste, agora COM os filtros ligados, é OUTRO teste (chave diferente)
    expect(runKey(DS, { ...P, ...legacyParams })).not.toBe(h[0].key);
    // registro sem os cinco números continua inválido
    st.setItem('sentinel_whatif_history_v1', JSON.stringify({ v: 1, runs: [{ ...legacy, params: { atrMult: 2 } }] }));
    expect(loadHistory(st)).toEqual([]);
  });
  it('reevaluationTargets: só testes do mesmo pedido cujo resultado é de OUTRA janela (cada parâmetro uma vez só)', () => {
    const w1 = { ...DS, windowEnd: 1000 }; const w2 = { ...DS, windowEnd: 2000 };
    const mk = (ds, over, at) => { const params = { ...P, ...over }; return { key: runKey(ds, params), at, dataset: ds, params, summary: { expectancyR: 0.1, counted: 5 }, starred: false }; };
    const h = [
      mk(w1, { minScore: 60 }, '2026-11-22T10:00:00.000Z'), mk(w1, { minScore: 80 }, '2026-11-22T10:02:00.000Z'),
      mk(w2, { minScore: 70 }, '2026-11-22T14:00:00.000Z'), // já tem resultado na janela atual
      { ...mk({ ...DS, assetId: 'a2', windowEnd: 1000 }, { minScore: 99 }, '2026-11-22T10:03:00.000Z') }, // outro ativo: fora
    ];
    const t = reevaluationTargets(h, w2);
    expect(t.map((x) => x.params.minScore).sort()).toEqual([60, 80]);
    expect(reevaluationTargets(h, { ...DS })).toEqual([]); // sem janela (dados ainda não carregaram): nada a fazer
    expect(reevaluationTargets(h, null)).toEqual([]);
    // depois de reavaliar (o resultado novo SUBSTITUI o antigo, mesma chave) não sobra nada e o histórico não cresce
    let done = h;
    for (const x of t) done = addRun(done, { ...mk(w2, { minScore: x.params.minScore }, '2026-11-22T14:01:00.000Z'), starred: x.starred });
    expect(done).toHaveLength(h.length);
    expect(reevaluationTargets(done, w2)).toEqual([]);
  });
  it('histórico antigo com o MESMO teste gravado em janelas diferentes (duplicado) vira um só ao carregar: fica o mais recente, mantendo a estrela', () => {
    const w1 = { ...DS, windowEnd: 1000 }; const w2 = { ...DS, windowEnd: 2000 };
    const mk = (ds, at, starred, exp) => ({ key: 'x', at, dataset: ds, params: { ...P }, summary: { expectancyR: exp, counted: 5 }, starred });
    const st = { getItem: () => JSON.stringify({ v: 1, runs: [mk(w1, '2026-11-22T10:00:00.000Z', true, 0.5), mk(w2, '2026-11-22T14:00:00.000Z', false, -0.2)] }) };
    const h = loadHistory(st);
    expect(h).toHaveLength(1);
    expect(h[0].dataset.windowEnd).toBe(2000);
    expect(h[0].summary.expectancyR).toBe(-0.2);
    expect(h[0].starred).toBe(true);
  });
});
