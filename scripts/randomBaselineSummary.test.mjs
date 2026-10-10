// docs/known-risks.md item 264 — resumo "entrada da RF × entradas aleatórias".
// Relatórios sintéticos com valores calculados à mão.
import { describe, it, expect } from 'vitest';
import {
  quantile,
  distribution,
  rankAgainst,
  buyAndHold,
  summarizeRandomBaseline,
  formatRandomBaselineMarkdown,
} from './randomBaselineSummary.mjs';

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const SYMBOLS = ['AAAUSDT', 'BBBUSDT'];
const COSTS = { feeBpsEntry: 5, feeBpsExit: 5, slippageBpsPerSide: 1, fundingBpsPer8h: 1, fundingSeries: null, applied: true };

// Relatório mínimo com a expectância dada; `seed` null = controle (RF).
function report(expectancyR, { seed = null, commit = 'a'.repeat(40), label } = {}) {
  return {
    trialLabel: label ?? (seed == null ? 'R0' : `rand_${seed}`),
    trialArgs: `--symbols ${SYMBOLS.join(',')} --from x --to y`,
    range: { fromMs: T0, toMs: T0 + 10 * DAY, from: '2026-01-01', to: '2026-01-11' },
    dataIntegrity: { valid: true },
    reproducibility: {
      commitSha: commit,
      pineConfig: seed == null
        ? { tp1R: 1.5 }
        : { tp1R: 1.5, randomEntryEnabled: true, randomEntrySeed: seed, randomEntryProb: 0.0075, skip15mConfirmationEnabled: true, useADX: false, useChop: false },
    },
    costs: { model: COSTS, netExpectancyR: expectancyR, countedTrades: 100 },
    overall: { curve: [{ r: expectancyR, op: { id: `op_${seed ?? 'r0'}` } }], expectancyR, expectancyRSd: 1, profitFactor: 1, winRate: 40 },
    equityCurve: { totalReturnPct: 0, maxDrawdownPct: 10 },
  };
}
const seedsWith = (values) => values.map((v, i) => report(v, { seed: i + 1 }));

describe('quantile / distribution', () => {
  it('interpolação linear (convenção do numpy)', () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.05)).toBeCloseTo(1.15, 12);
    expect(distribution([3, 1, 2])).toMatchObject({ n: 3, mean: 2, sd: 1, min: 1, p50: 2, max: 3 });
  });
});

describe('rankAgainst', () => {
  it('p empírico = (1 + nº de seeds ≥ controle)/(N+1); percentil conta empate como meio', () => {
    // Controle 0,5 contra [0, 0,5, 1, 2]: seeds ≥ 0,5 → 3 → p = 4/5; supera 1, empata 1 → (1 + 0,5)/4.
    const r = rankAgainst(0.5, [0, 0.5, 1, 2]);
    expect(r.pEmpirical).toBeCloseTo(4 / 5, 12);
    expect(r.percentile).toBeCloseTo(1.5 / 4, 12);
    expect(r.minPossibleP).toBeCloseTo(1 / 5, 12);
  });

  it('menor é melhor (drawdown): o sentido do p inverte', () => {
    const r = rankAgainst(5, [10, 20, 30], { higherIsBetter: false });
    expect(r.pEmpirical).toBeCloseTo(1 / 4, 12);
    expect(r.percentile).toBe(1);
  });
});

describe('buyAndHold', () => {
  it('cesto de peso igual normalizado no início: +100% e −50% → 25%; drawdown pelo caminho', () => {
    const c = (day, close) => ({ closeTime: T0 + day * DAY, close });
    const r = buyAndHold({
      AAAUSDT: [c(0, 10), c(1, 20), c(2, 20)],
      BBBUSDT: [c(0, 10), c(1, 2), c(2, 5)],
    }, { fromMs: T0, toMs: T0 + 2 * DAY });
    // Caminho: 1 → (2 + 0,2)/2 = 1,1 → (2 + 0,5)/2 = 1,25.
    expect(r.totalReturnPct).toBe(25);
    expect(r.maxDrawdownPct).toBe(0);
    expect(r.symbols).toBe(2);
  });
});

describe('summarizeRandomBaseline', () => {
  it('controle acima de todas as 40 seeds → p = 1/41 ≤ 0,025 → entrada melhor que aleatória', () => {
    const s = summarizeRandomBaseline(report(0.3), seedsWith(Array.from({ length: 40 }, (_, i) => -0.2 + i * 0.01)));
    expect(s.comparable).toBe(true);
    expect(s.rank.expectancyR.pEmpirical).toBeCloseTo(1 / 41, 12);
    expect(s.verdict).toBe('entrada_melhor_que_aleatoria');
  });

  it('controle no meio da distribuição → indistinguível do aleatório', () => {
    const s = summarizeRandomBaseline(report(0), seedsWith(Array.from({ length: 40 }, (_, i) => -0.2 + i * 0.01)));
    expect(s.verdict).toBe('indistinguivel_do_aleatorio');
    expect(s.rank.expectancyR.percentile).toBeGreaterThan(0.4);
  });

  it('controle abaixo de todas → pior que aleatória', () => {
    const s = summarizeRandomBaseline(report(-1), seedsWith(Array.from({ length: 40 }, () => 0)));
    expect(s.verdict).toBe('entrada_pior_que_aleatoria');
  });

  it('recusa poucas seeds para o limiar (30 seeds: p mínimo 1/31 > 0,025)', () => {
    const s = summarizeRandomBaseline(report(1), seedsWith(Array.from({ length: 30 }, () => 0)));
    expect(s.comparable).toBe(false);
    expect(s.errors.join(' ')).toMatch(/menor p possível/);
  });

  it('recusa seed repetida, relatório sem a chave ligada, controle com a chave e commit diferente', () => {
    const randoms = seedsWith(Array.from({ length: 40 }, () => 0));
    randoms[1].reproducibility.pineConfig.randomEntrySeed = 1; // repete a seed 1
    randoms[2].reproducibility.pineConfig.randomEntryEnabled = false;
    randoms[3].reproducibility.commitSha = 'b'.repeat(40);
    const control = report(0);
    control.reproducibility.pineConfig = { randomEntryEnabled: true };
    const s = summarizeRandomBaseline(control, randoms);
    const msg = s.errors.join(' | ');
    expect(s.comparable).toBe(false);
    expect(msg).toMatch(/seed 1 repetida/);
    expect(msg).toMatch(/randomEntryEnabled precisa ser true/);
    expect(msg).toMatch(/controle tem randomEntryEnabled ligado/);
    expect(msg).toMatch(/commits diferentes/);
  });

  // Review do Codex (PR #481) — os 3 casos abaixo davam veredito errado.
  it('recusa braço aleatório com config efetiva diferente (além da seed) e braço que difere do controle nas saídas', () => {
    const randoms = seedsWith(Array.from({ length: 40 }, () => 0));
    randoms[5].reproducibility.pineConfig.randomEntryProb = 0.02; // outra distribuição nula
    randoms[6].reproducibility.pineConfig.tp1R = 2; // outra saída
    const msg = summarizeRandomBaseline(report(0), randoms).errors.join(' | ');
    expect(msg).toMatch(/rand_6: configuração efetiva diferente/);
    expect(msg).toMatch(/rand_7: configuração difere do controle fora das chaves de entrada/);
  });

  it('com expectedSeeds, recusa quando falta seed (39 de 40 chegaram)', () => {
    const randoms = seedsWith(Array.from({ length: 40 }, () => 0)).filter((r) => r.reproducibility.pineConfig.randomEntrySeed !== 17);
    const s = summarizeRandomBaseline(report(1), randoms, { expectedSeeds: 40 });
    expect(s.comparable).toBe(false);
    expect(s.errors.join(' ')).toMatch(/chegaram 39; faltam: 17/);
    expect(summarizeRandomBaseline(report(1), seedsWith(Array.from({ length: 40 }, () => 0)), { expectedSeeds: 40 }).comparable).toBe(true);
  });

  it('recusa controle ou seed sem expectância finita (nenhuma operação com R)', () => {
    const randoms = seedsWith(Array.from({ length: 40 }, () => 0));
    randoms[0].costs.netExpectancyR = null;
    randoms[0].overall.expectancyR = null;
    const control = report(null);
    const msg = summarizeRandomBaseline(control, randoms).errors.join(' | ');
    expect(msg).toMatch(/o controle não tem expectância finita/);
    expect(msg).toMatch(/rand_1: sem expectância finita/);
  });

  it('o texto mostra percentil e veredito; recusado não traz número de resultado', () => {
    const ok = summarizeRandomBaseline(report(0), seedsWith(Array.from({ length: 40 }, (_, i) => i * 0.01)));
    const okMd = formatRandomBaselineMarkdown(ok);
    expect(okMd).toMatch(/Percentil do controle/);
    // Todas as seeds no bloco recolhível, em ordem (40 linhas de tabela).
    expect(okMd).toMatch(/<details><summary>Cada seed aleatória/);
    expect(okMd).toMatch(/\| 1 \| 0\.0000 \| 1\.0000 \| 10\.00 \| 100 \|/);
    expect(okMd).toMatch(/\| 40 \| 0\.3900 \|/);
    expect(ok.seeds).toHaveLength(40);
    const refused = summarizeRandomBaseline(report(0), seedsWith([0, 0]));
    const md = formatRandomBaselineMarkdown(refused);
    expect(md).toMatch(/Resumo recusado/);
    expect(md).not.toMatch(/Percentil/);
    expect(md).not.toMatch(/<details>/);
  });
});
