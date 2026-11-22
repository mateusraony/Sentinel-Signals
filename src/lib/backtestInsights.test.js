import { describe, it, expect } from 'vitest';
import { explainReport, SOURCE_NOTE, reasonLabel, REASON_LABEL, diffAppliedConfig } from './backtestInsights';

const base = (over = {}, costs = {}, extra = {}) => ({
  overall: { counted: 10, wins: 6, losses: 4, be: 0, expectancyR: 0.12, grossExpectancyR: 0.15, avgWinR: 1.5, avgLossR: -1, expectancyRCI95: [-0.2, 0.44], ...over },
  costs: { conclusive: false, inconclusiveReason: 'sample_too_small', minTrades: 30, countedTrades: 10, avgCostR: 0.03, ...costs },
  ...extra,
});

describe('explainReport', () => {
  it('amostra pequena: diz o mínimo e que taxa de acerto/profit factor são ruído — nunca conclui vantagem', () => {
    const r = explainReport(base(), 'json');
    expect(r.tone).toBe('inconclusive');
    expect(r.headline).toMatch(/Ainda não dá para dizer/);
    expect(r.lines[0]).toMatch(/Amostra pequena: 10 operações \(o mínimo para tirar conclusão é 30\)/);
    expect(r.lines[0]).toMatch(/ruído/);
  });
  it('intervalo cruza zero: mostra o intervalo e continua inconclusivo', () => {
    const r = explainReport(base({}, { inconclusiveReason: 'ci_straddles_zero', countedTrades: 400 }));
    expect(r.tone).toBe('inconclusive');
    expect(r.lines[0]).toMatch(/400 operações.*\+0\.12R.*de -0\.20R a \+0\.44R/);
  });
  it('conclusivo positivo e negativo seguem o sinal da expectância líquida', () => {
    expect(explainReport(base({ expectancyR: 0.2, expectancyRCI95: [0.1, 0.3] }, { conclusive: true })).tone).toBe('positive');
    const neg = explainReport(base({ expectancyR: -0.2, expectancyRCI95: [-0.3, -0.1] }, { conclusive: true }));
    expect(neg.tone).toBe('negative');
    expect(neg.lines[0]).toMatch(/não cruza zero/);
  });
  it('custos: mostra bruto → líquido e avisa quando o custo vira o sinal', () => {
    const r = explainReport(base({ expectancyR: -0.02, grossExpectancyR: 0.03 }, { avgCostR: 0.05 }));
    const c = r.lines.find((l) => l.includes('custos'));
    expect(c).toMatch(/de \+0\.03R bruto para -0\.02R líquido/);
    expect(c).toMatch(/transformaram um resultado bruto positivo em negativo/);
  });
  it('ganho e perda médios e operações em aberto entram só quando existem', () => {
    const r = explainReport(base({}, {}, { stillOpenAtCutoff: 2 }));
    expect(r.lines.some((l) => /6 vitórias, 4 derrotas e 0 empates.*\+1\.50R.*\+1\.00R/.test(l))).toBe(true);
    expect(r.lines.some((l) => /2 operação\(ões\) ainda aberta\(s\)/.test(l))).toBe(true);
    const semAbertas = explainReport(base());
    expect(semAbertas.lines.some((l) => /ainda aberta/.test(l))).toBe(false);
  });
  it('sem operações: estado vazio, sem números inventados', () => {
    const r = explainReport({ overall: { counted: 0 }, costs: { countedTrades: 0 } }, 'real');
    expect(r.tone).toBe('empty');
    expect(r.lines).toEqual([]);
    expect(r.note).toBe(SOURCE_NOTE.real);
  });
  it('a nota da fonte diz o que cada origem NÃO é', () => {
    expect(SOURCE_NOTE.real).toMatch(/nenhuma ordem foi enviada/);
    expect(SOURCE_NOTE.quick).toMatch(/não é o resultado exato do motor/);
    expect(SOURCE_NOTE.json).toMatch(/passado não garante/);
    expect(explainReport(base(), 'xyz').note).toBeNull();
  });
  it('relatório vazio/undefined não quebra', () => {
    expect(() => explainReport(undefined)).not.toThrow();
    expect(explainReport({}).tone).toBe('empty');
  });
});

describe('reasonLabel', () => {
  it('traduz os motivos conhecidos e devolve null para os desconhecidos (a tela mostra o código cru)', () => {
    expect(reasonLabel('regime_rejected')).toMatch(/ADX\/Choppiness/);
    expect(reasonLabel('motivo_novo_qualquer')).toBeNull();
    expect(Object.keys(REASON_LABEL).length).toBeGreaterThan(10);
  });
});

describe('diffAppliedConfig — o que muda ao aplicar ao scanner', () => {
  const DEF = { minScore: 75, tp1R: 1.5, newFlag: false };
  it('lista só o que difere; chave ausente no trial usa o padrão (como o doApply)', () => {
    const d = diffAppliedConfig({ minScore: 82, tp1R: 1.5 }, { minScore: 75, tp1R: 1.5, newFlag: true }, ['minScore', 'tp1R', 'newFlag'], DEF);
    expect(d).toEqual([{ key: 'minScore', from: 75, to: 82 }, { key: 'newFlag', from: true, to: false }]);
  });
  it('nada muda: lista vazia (diferente de "não sei")', () => {
    expect(diffAppliedConfig({ minScore: 75 }, { minScore: 75 }, ['minScore'], DEF)).toEqual([]);
  });
  it('sem a configuração atual (leitura falhou) devolve null — a tela não afirma nada', () => {
    expect(diffAppliedConfig({ minScore: 75 }, null, ['minScore'], DEF)).toBeNull();
    expect(diffAppliedConfig(null, { minScore: 75 }, ['minScore'], DEF)).toBeNull();
  });
});
