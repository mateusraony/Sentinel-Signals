import { describe, it, expect } from 'vitest';
import { buildScannerPlan, appliable, scannerPayload, assetPayload, applyWarnings } from './whatIfApply.js';
import { buildDefaults } from './whatIf.js';

const LIVE = { tp1R: 1.5, minScore: 75, minRR: 1.2, useADX: true, useChop: true, useTimeStop: true, preTp1StopProtectionEnabled: true, preTp1TrailEnabled: true, preTp1TrailStartAtrMult: 1, preTp1TrailAtrMult: 2, trailAtrMult: 2, useChopExit: false, useInvalidation: false, invalidRFBars: 2 };
const D = buildDefaults({ pineConfig: LIVE, asset: { rf_period: 20, rf_multiplier: 3.5 }, tier: { atrStopMult: 3 } });
const ASSET = { symbol: 'BTCUSDT', rf_period: 20, rf_multiplier: 3.5 };
const plan = (over, live = LIVE, asset = ASSET) => buildScannerPlan({ params: { ...D, ...over }, defaults: D, live, asset });
const ids = (p, keys) => new Set(p.items.filter((i) => keys.includes(i.key)).map((i) => i.id));
const diffs = (p) => appliable(p).map((i) => [i.key, i.from, i.to]);

describe('buildScannerPlan — TODOS os parâmetros aplicáveis, para o usuário escolher', () => {
  it('sem mexer em nada: lista tudo com o valor atual do scanner, mas nada difere (não há o que aplicar) e nada é bloqueado', () => {
    const p = plan({});
    expect(p.items.map((i) => i.key)).toEqual(['tp1R', 'minScore', 'minRR', 'useADX', 'useChop', 'useTimeStop', 'useChopExit', 'useInvalidation', 'preTp1TrailEnabled', 'preTp1TrailStartAtrMult', 'preTp1TrailAtrMult', 'trailAtrMult', 'rf_period', 'rf_multiplier']);
    expect(appliable(p)).toEqual([]);
    expect(p.blocked).toEqual([]);
  });

  it('o que você mexeu aparece como diferente: valor atual (da config ao vivo) → novo', () => {
    expect(diffs(plan({ tp1R: 2, minScore: 80, minRR: 1.5 }))).toEqual([['tp1R', 1.5, 2], ['minScore', 75, 80], ['minRR', 1.2, 1.5]]);
  });

  it('regime e time stop viram as chaves reais (useADX+useChop; useTimeStop)', () => {
    expect(diffs(plan({ regime: 0, timeStop: 0 }))).toEqual([['useADX', true, false], ['useChop', true, false], ['useTimeStop', true, false]]);
  });

  it('Chop Exit e invalidação viram as chaves reais; as velas da invalidação só entram com ela ligada', () => {
    expect(diffs(plan({ chopExit: 1 }))).toEqual([['useChopExit', false, true]]);
    expect(diffs(plan({ invalidation: 1, invalidBars: 3 }))).toEqual([['useInvalidation', false, true], ['invalidRFBars', 2, 3]]);
    expect(plan({ invalidBars: 4 }).items.some((i) => i.key === 'invalidRFBars')).toBe(false); // invalidação desligada: nº de velas não é aplicável
    expect(diffs(plan({ chopExit: 1 }, { ...LIVE, useChopExit: true }))).toEqual([]); // já igual ao scanner
  });

  it('trailing pré-TP1: distância mexida aparece sozinha; desligado, começo e distância nem entram na lista', () => {
    expect(diffs(plan({ trailDist: 3 }))).toEqual([['preTp1TrailAtrMult', 2, 3]]);
    const off = plan({ trail: 0 });
    expect(diffs(off)).toEqual([['preTp1TrailEnabled', true, false]]);
    expect(off.items.some((i) => i.key === 'preTp1TrailStartAtrMult')).toBe(false);
  });

  it('você pode aplicar um valor que difere do scanner mesmo sem ter mexido na tela hoje (a config ao vivo mudou depois)', () => {
    const p = plan({}, { ...LIVE, tp1R: 1.2 });
    expect(diffs(p)).toEqual([['tp1R', 1.2, 1.5]]);
  });

  it('stop (× ATR), trailing do runner e saída RF NÃO são configuráveis: "não dá para aplicar", com o motivo', () => {
    const p = plan({ atrMult: 4, runnerTrail: 0, runnerRf: 0 });
    expect(p.blocked.map((b) => b.key)).toEqual(['atrMult', 'runnerTrail', 'runnerRf']);
    expect(p.blocked.find((b) => b.key === 'atrMult').why).toMatch(/tier/);
    expect(p.items.some((i) => i.key === 'trailAtrMult')).toBe(false); // trailing do runner desligado na tela: não há distância a aplicar
  });

  it('configuração ao vivo não lida (null): todos os itens ficam como "diferentes" sem inventar o valor antigo', () => {
    const p = plan({ tp1R: 2 }, null);
    expect(p.items.find((i) => i.key === 'tp1R')).toMatchObject({ from: undefined, to: 2, differs: true });
  });

  it('Range Filter é POR ATIVO: itens à parte, só quando há ativo com os valores', () => {
    const p = plan({ rfPeriod: 25 });
    expect(p.items.filter((i) => i.scope === 'asset').map((i) => [i.key, i.from, i.to, i.differs])).toEqual([['rf_period', 20, 25, true], ['rf_multiplier', 3.5, 3.5, false]]);
    expect(plan({ rfPeriod: 25 }, LIVE, null).items.some((i) => i.scope === 'asset')).toBe(false);
  });
});

describe('scannerPayload / assetPayload — só o que o USUÁRIO escolheu', () => {
  it('payload tem SÓ os ids marcados (e a data); o que não foi marcado não vai, mesmo que difira', () => {
    const p = plan({ tp1R: 2, minScore: 80 });
    const payload = scannerPayload(p, ids(p, ['tp1R']), '2026-11-23T20:00:00.000Z');
    expect(Object.keys(payload).sort()).toEqual(['tp1R', 'updated_at']);
    expect(payload.tp1R).toBe(2);
  });
  it('nada marcado = só a data (a tela não grava nada nesse caso)', () => {
    const p = plan({ tp1R: 2 });
    expect(Object.keys(scannerPayload(p, new Set(), 'x'))).toEqual(['updated_at']);
  });
  it('id que não difere do scanner não vai mesmo se marcado à força', () => {
    const p = plan({ tp1R: 2 });
    expect(Object.keys(scannerPayload(p, ids(p, ['minScore']), 'x'))).toEqual(['updated_at']);
  });
  it('ligar o trailing pré-TP1 (estava desligado no scanner) também liga a proteção mestre — só se o usuário marcou o interruptor', () => {
    const off = { ...LIVE, preTp1TrailEnabled: false };
    const d = buildDefaults({ pineConfig: off, asset: ASSET, tier: { atrStopMult: 3 } });
    const p = buildScannerPlan({ params: { ...d, trail: 1 }, defaults: d, live: off, asset: ASSET });
    expect(scannerPayload(p, ids(p, ['preTp1TrailEnabled']), 'x')).toMatchObject({ preTp1TrailEnabled: true, preTp1StopProtectionEnabled: true });
    expect(scannerPayload(p, new Set(), 'x').preTp1StopProtectionEnabled).toBeUndefined();
  });
  it('Range Filter por ativo: assetPayload só com os campos marcados', () => {
    const p = plan({ rfPeriod: 25, rfMult: 4 });
    expect(assetPayload(p, ids(p, ['rf_period']))).toEqual({ rf_period: 25 });
    expect(assetPayload(p, ids(p, ['rf_period', 'rf_multiplier']))).toEqual({ rf_period: 25, rf_multiplier: 4 });
    expect(assetPayload(p, new Set())).toEqual({});
  });
});

describe('applyWarnings', () => {
  it('avisos: sem operação, inconclusivo, muitas tentativas — e sempre a ressalva da simulação simplificada', () => {
    expect(applyWarnings({ summary: { counted: 0 }, testedCount: 1 })[0]).toMatch(/nenhuma operação/);
    expect(applyWarnings({ summary: { counted: 5, conclusive: false }, testedCount: 1 })[0]).toMatch(/inconclusivo \(5 operações\)/);
    expect(applyWarnings({ summary: { counted: 1, conclusive: false }, testedCount: 1 })[0]).toMatch(/\(1 operação\)/);
    const many = applyWarnings({ summary: { counted: 50, conclusive: true }, testedCount: 10 });
    expect(many[0]).toMatch(/testou 10 combinações/);
    expect(many.at(-1)).toMatch(/simplificada/);
    expect(applyWarnings({ summary: { counted: 50, conclusive: true }, testedCount: 2 })).toHaveLength(1);
  });
});
