import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  inverseNormalCDF,
  bonferroniZ,
  ciAtZ,
  stdErrFromCI95,
  recordFromReport,
  createSeedRecord,
  appendTrial,
  appendSeed,
  loadRegistry,
  summarizeFamily,
  correctedConclusiveVerdict,
} from './backtest-trial-registry.mjs';

describe('inverseNormalCDF', () => {
  it('bate com quantis conhecidos da normal padrão (literatura)', () => {
    expect(inverseNormalCDF(0.5)).toBeCloseTo(0, 9);
    expect(inverseNormalCDF(0.975)).toBeCloseTo(1.959963985, 8);
    expect(inverseNormalCDF(0.995)).toBeCloseTo(2.575829304, 8);
    expect(inverseNormalCDF(0.025)).toBeCloseTo(-1.959963985, 8);
  });

  it('rejeita p fora de (0,1)', () => {
    expect(() => inverseNormalCDF(0)).toThrow();
    expect(() => inverseNormalCDF(1)).toThrow();
    expect(() => inverseNormalCDF(-0.1)).toThrow();
  });
});

describe('bonferroniZ', () => {
  it('familySize=1 reproduz exatamente o z=1.96 já usado em tradeMetrics.js', () => {
    expect(bonferroniZ(1)).toBeCloseTo(1.959963985, 8);
  });

  it('cresce com o tamanho da família (correção fica mais conservadora)', () => {
    const z1 = bonferroniZ(1);
    const z2 = bonferroniZ(2);
    const z6 = bonferroniZ(6);
    expect(z2).toBeGreaterThan(z1);
    expect(z6).toBeGreaterThan(z2);
  });

  it('bate com o valor de referência de Bonferroni p/ m=2, alpha=0.05 (~2.241)', () => {
    expect(bonferroniZ(2)).toBeCloseTo(2.241, 2);
  });

  it('rejeita familySize inválido', () => {
    expect(() => bonferroniZ(0)).toThrow();
    expect(() => bonferroniZ(-1)).toThrow();
    expect(() => bonferroniZ(1.5)).toThrow();
  });
});

describe('stdErrFromCI95 / ciAtZ', () => {
  it('recupera o stdErr original a partir do IC95 publicado', () => {
    const expectancyR = 0.1;
    const stdErr = 0.05;
    const ci95 = [expectancyR - 1.959963985 * stdErr, expectancyR + 1.959963985 * stdErr];
    expect(stdErrFromCI95(ci95)).toBeCloseTo(stdErr, 6);
  });

  it('ciAtZ com z maior produz um intervalo mais largo', () => {
    const narrow = ciAtZ(0.1, 0.05, 1.96);
    const wide = ciAtZ(0.1, 0.05, 2.6);
    expect(wide[1] - wide[0]).toBeGreaterThan(narrow[1] - narrow[0]);
  });

  it('devolve null quando falta expectancyR ou stdErr', () => {
    expect(ciAtZ(null, 0.05, 1.96)).toBeNull();
    expect(stdErrFromCI95(null)).toBeNull();
  });
});

describe('recordFromReport', () => {
  it('extrai os campos do relatório do backtest.yml', () => {
    const report = {
      trialLabel: 'runner-off-baseline',
      reproducibility: { runStartedAt: '2026-08-15T00:00:00Z', commitSha: 'abc123', configHash: 'deadbeef', pineConfig: { runnerEnabled: false } },
      costs: {
        netExpectancyR: 0.041,
        countedTrades: 109,
        minTrades: 30,
        conclusive: true,
        expectancyRCI95: [0.010, 0.072],
      },
    };
    const record = recordFromReport(report, 'exit-runner-fix');
    expect(record.family).toBe('exit-runner-fix');
    expect(record.trialLabel).toBe('runner-off-baseline');
    expect(record.n).toBe(109);
    expect(record.expectancyR).toBeCloseTo(0.041, 6);
    expect(record.expectancyRStdErr).not.toBeNull();
    expect(record.pineConfigOverride).toEqual({ runnerEnabled: false });
  });

  it('lança erro quando trialLabel está ausente (relatório incompleto)', () => {
    expect(() => recordFromReport({ costs: {} }, 'x')).toThrow(/trialLabel/);
  });
});

describe('createSeedRecord', () => {
  it('cria um registro histórico com proveniência (source) obrigatória', () => {
    const record = createSeedRecord({
      family: 'sell-only-hypothesis',
      trialLabel: 'baixa-baseline-20symbols-sell-slice',
      source: 'known-risks.md item 45.9',
      n: 166,
      expectancyR: 0.199,
      expectancyRCI95: [0.0193, 0.3787],
    });
    expect(record.source).toBe('seed');
    expect(record.seedSource).toBe('known-risks.md item 45.9');
    expect(record.n).toBe(166);
    expect(record.expectancyRStdErr).not.toBeNull();
  });

  it('aceita n e CI95 ausentes (medição publicada só com R médio)', () => {
    const record = createSeedRecord({
      family: 'sell-only-hypothesis',
      trialLabel: 'bloco0-janela3-sell-slice',
      source: 'known-risks.md item 48',
      expectancyR: 0.147,
    });
    expect(record.n).toBeNull();
    expect(record.expectancyRCI95).toBeNull();
    expect(record.expectancyRStdErr).toBeNull();
  });

  it('exige family/trialLabel/source/expectancyR', () => {
    expect(() => createSeedRecord({ trialLabel: 'x', source: 's', expectancyR: 0.1 })).toThrow(/family/);
    expect(() => createSeedRecord({ family: 'f', source: 's', expectancyR: 0.1 })).toThrow(/trialLabel/);
    expect(() => createSeedRecord({ family: 'f', trialLabel: 'x', expectancyR: 0.1 })).toThrow(/source/);
    expect(() => createSeedRecord({ family: 'f', trialLabel: 'x', source: 's' })).toThrow(/expectancyR/);
  });
});

describe('correctedConclusiveVerdict — não resgata amostra pequena demais (achado Codex, PR #189)', () => {
  it('devolve false quando n < minTrades, mesmo com IC corrigido excluindo zero', () => {
    // Construído para que o IC corrigido exclua zero (expectancyR alto,
    // stdErr pequeno) mas n fique abaixo do minTrades do próprio relatório
    // original — reproduz o padrão que o Codex apontou.
    const record = { n: 10, minTrades: 30, expectancyR: 0.5, expectancyRStdErr: 0.05 };
    const correctedCI = [0.5 - 2.6 * 0.05, 0.5 + 2.6 * 0.05]; // exclui zero com folga
    expect(correctedConclusiveVerdict(record, correctedCI)).toBe(false);
  });

  it('devolve true quando n >= minTrades E o IC corrigido exclui zero', () => {
    const record = { n: 100, minTrades: 30, expectancyR: 0.5, expectancyRStdErr: 0.05 };
    const correctedCI = [0.5 - 2.6 * 0.05, 0.5 + 2.6 * 0.05];
    expect(correctedConclusiveVerdict(record, correctedCI)).toBe(true);
  });

  it('devolve false quando o IC corrigido cruza zero, independente da amostra', () => {
    const record = { n: 100, minTrades: 30, expectancyR: 0.05, expectancyRStdErr: 0.1 };
    const correctedCI = [-0.2, 0.3]; // cruza zero
    expect(correctedConclusiveVerdict(record, correctedCI)).toBe(false);
  });

  it('devolve null quando não há como calcular o IC corrigido', () => {
    expect(correctedConclusiveVerdict({ n: 100, minTrades: 30 }, null)).toBeNull();
  });

  it('devolve null (nunca true) quando minTrades é desconhecido mas o IC exclui zero — seeds sem minTrades', () => {
    const record = { n: 166, minTrades: null, expectancyR: 0.5, expectancyRStdErr: 0.05 };
    const correctedCI = [0.5 - 2.6 * 0.05, 0.5 + 2.6 * 0.05];
    expect(correctedConclusiveVerdict(record, correctedCI)).toBeNull();
  });
});

describe('appendTrial / loadRegistry / summarizeFamily (ledger em arquivo temporário)', () => {
  let tmpDir;
  let registryPath;
  let reportPath;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'backtest-trial-registry-test-'));
    registryPath = path.join(tmpDir, 'registry.json');
    reportPath = path.join(tmpDir, 'report.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeReport(overrides) {
    const report = {
      trialLabel: 'trial-a',
      reproducibility: { runStartedAt: '2026-08-15T00:00:00Z', commitSha: 'x', configHash: 'y', pineConfig: {} },
      costs: {
        netExpectancyR: 0.05,
        countedTrades: 100,
        minTrades: 30,
        conclusive: true,
        expectancyRCI95: [0.02, 0.08],
      },
      ...overrides,
    };
    fs.writeFileSync(reportPath, JSON.stringify(report));
    return report;
  }

  it('registro começa vazio quando o arquivo não existe', () => {
    expect(loadRegistry(registryPath)).toEqual([]);
  });

  it('appendTrial grava e loadRegistry lê de volta', () => {
    writeReport();
    const record = appendTrial(reportPath, 'exit-runner-fix', registryPath);
    expect(record.trialLabel).toBe('trial-a');
    const loaded = loadRegistry(registryPath);
    expect(loaded).toHaveLength(1);
    expect(loaded[0].family).toBe('exit-runner-fix');
  });

  it('rejeita duplicar o mesmo trialLabel na mesma família', () => {
    writeReport();
    appendTrial(reportPath, 'exit-runner-fix', registryPath);
    expect(() => appendTrial(reportPath, 'exit-runner-fix', registryPath)).toThrow(/Já existe registro/);
  });

  it('permite o mesmo trialLabel em famílias diferentes', () => {
    writeReport();
    appendTrial(reportPath, 'family-a', registryPath);
    expect(() => appendTrial(reportPath, 'family-b', registryPath)).not.toThrow();
    expect(loadRegistry(registryPath)).toHaveLength(2);
  });

  it('summarizeFamily aplica correção Bonferroni proporcional a N e devolve markdown', () => {
    writeReport({ trialLabel: 'trial-a' });
    appendTrial(reportPath, 'exit-runner-fix', registryPath);
    writeReport({ trialLabel: 'trial-b' });
    appendTrial(reportPath, 'exit-runner-fix', registryPath);
    writeReport({ trialLabel: 'trial-c' });
    appendTrial(reportPath, 'exit-runner-fix', registryPath);

    const summary = summarizeFamily('exit-runner-fix', registryPath);
    expect(summary.n).toBe(3);
    expect(summary.z).toBeCloseTo(bonferroniZ(3), 8);
    expect(summary.rows).toHaveLength(3);
    expect(summary.markdown).toContain('N=3');
    expect(summary.markdown).toContain('trial-a');
    // IC corrigido tem que ser mais largo que o original (z maior)
    const row = summary.rows[0];
    expect(row.correctedCI[1] - row.correctedCI[0]).toBeGreaterThan(row.expectancyRCI95[1] - row.expectancyRCI95[0]);
  });

  it('summarizeFamily de família vazia não lança erro', () => {
    const summary = summarizeFamily('nunca-usada', registryPath);
    expect(summary.n).toBe(0);
    expect(summary.rows).toEqual([]);
  });

  it('appendSeed grava um registro histórico e conta para o tamanho da família', () => {
    const record = appendSeed({
      family: 'sell-only-hypothesis',
      trialLabel: 'baixa-baseline-20symbols-sell-slice',
      source: 'known-risks.md item 45.9',
      n: 166,
      expectancyR: 0.199,
      expectancyRCI95: [0.0193, 0.3787],
    }, registryPath);
    expect(record.source).toBe('seed');
    expect(loadRegistry(registryPath)).toHaveLength(1);
  });

  it('rejeita seed duplicado (mesmo trialLabel + família)', () => {
    const input = {
      family: 'sell-only-hypothesis',
      trialLabel: 'bloco0-janela3-sell-slice',
      source: 'known-risks.md item 48',
      expectancyR: 0.147,
    };
    appendSeed(input, registryPath);
    expect(() => appendSeed(input, registryPath)).toThrow(/Já existe registro/);
  });

  it('família mista (seeds + trial novo) reflete o N combinado — regressão do achado do Codex, PR #189', () => {
    // Reproduz o cenário real do item 88/89: a família "sell-only-hypothesis"
    // já teria histórico publicado antes de qualquer trial novo rodar. Sem o
    // seed, registrar só o trial novo reportaria N=1 (z=1,96) em vez do N
    // real da família — exatamente o que o Codex apontou como risco de
    // "desbloquear produto sem contar as tentativas que motivaram a
    // correção".
    appendSeed({
      family: 'sell-only-hypothesis',
      trialLabel: 'seed-1',
      source: 'known-risks.md item 48',
      n: 129,
      expectancyR: 0.169,
    }, registryPath);
    appendSeed({
      family: 'sell-only-hypothesis',
      trialLabel: 'seed-2',
      source: 'known-risks.md item 71',
      n: 150,
      expectancyR: 0.078,
      expectancyRCI95: [-0.115, 0.270],
    }, registryPath);
    writeReport({ trialLabel: 'allowedside-sell-followup', costs: { netExpectancyR: 0.15, countedTrades: 120, minTrades: 30, conclusive: true, expectancyRCI95: [0.05, 0.25] } });
    appendTrial(reportPath, 'sell-only-hypothesis', registryPath);

    const summary = summarizeFamily('sell-only-hypothesis', registryPath);
    expect(summary.n).toBe(3);
    expect(summary.z).toBeCloseTo(bonferroniZ(3), 8);
    expect(summary.z).toBeGreaterThan(bonferroniZ(1)); // mais conservador que tratar como N=1
  });
});
