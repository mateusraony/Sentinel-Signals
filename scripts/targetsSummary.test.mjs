// docs/known-risks.md item 281 — resumo automático do teste dos alvos.
// Relatórios sintéticos no formato que o compareReports lê.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { summarizeTargetsExperiment, formatTargetsMarkdown, checkControls, formatControlsMarkdown, opIdsHash } from './targetsSummary.mjs';
import { mulberry32 } from './backtest-correlation-check.mjs';

const prereg = JSON.parse(readFileSync(new URL('../docs/experiments/targets-prereg.json', import.meta.url), 'utf-8'));
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const COSTS = { feeBpsEntry: 5, feeBpsExit: 5, slippageBpsPerSide: 1, fundingBpsPer8h: 1, fundingSeries: null, applied: true };
const BASE_CFG = { tp1R: 1.5, targetMode: 'r_multiple', targetNearPolicy: 'literal' };

// n operações sem sobreposição (cada uma é um cluster), R alternando em torno de `mean`.
function curve(n, mean) {
  return Array.from({ length: n }, (_, i) => ({
    r: mean + (i % 2 ? 0.5 : -0.5),
    op: { id: `op${i}`, symbol: ['AUSDT', 'BUSDT', 'CUSDT', 'DUSDT'][i % 4], status: 'STOP_HIT',
      created_date: new Date(T0 + 2 * i * DAY).toISOString(), closed_at: new Date(T0 + (2 * i + 1) * DAY).toISOString() },
  }));
}
const WIN = Object.fromEntries(prereg.windows.map((w) => [w.label, w]));
function report({ w = 'W1', n = 40, mean = 0, cfg = BASE_CFG, valid = true, countedTrades, netExpectancyR, targets } = {}) {
  const win = WIN[w];
  return {
    trialLabel: 'x',
    trialArgs: `--symbols ${win.symbols.join(',')} --from a --to b`,
    range: { fromMs: Date.parse(`${win.from}T00:00:00Z`), toMs: Date.parse(`${win.to}T00:00:00Z`) },
    dataIntegrity: { valid },
    reproducibility: { commitSha: 'a'.repeat(40), pineConfig: cfg },
    costs: { model: COSTS, countedTrades: countedTrades ?? n, netExpectancyR: netExpectancyR ?? mean },
    overall: { curve: curve(n, mean), expectancyR: mean, winRate: 50, profitFactor: 1 },
    equityCurve: { riskPct: 1, maxDrawdownPct: 3, totalReturnPct: -1 },
    ...(targets ? { targets } : {}),
  };
}
const armCfg = (label) => {
  const a = prereg.arms.find((x) => x.label === label);
  return { ...BASE_CFG, targetMode: a.targetMode, targetNearPolicy: a.targetNearPolicy };
};
const T_OK = { ops: 40, inconclusiveByFallback: false, fallbackRate: 0.1, medianTp1R: 0.4, tp1Rate: 0.6 };

// Controles que reproduzem o item 270 em W1/W2.
function controls() {
  return {
    W1: report({ w: 'W1', countedTrades: 115, netExpectancyR: -0.0483 }),
    W2: report({ w: 'W2', countedTrades: 119, netExpectancyR: 0.0537 }), // registrado como 0,054 (3 casas)
    W0: report({ w: 'W0' }),
  };
}
function build(armMeans = {}, armTargets = {}) {
  const c = controls();
  const out = {};
  for (const w of ['W1', 'W2', 'W0']) {
    out[w] = { control: c[w], arms: {} };
    for (const a of prereg.arms) {
      out[w].arms[a.label] = report({ w, mean: armMeans[a.label]?.[w] ?? 0, cfg: armCfg(a.label), targets: armTargets[a.label]?.[w] ?? T_OK });
    }
  }
  return out;
}
const run = (reports) => summarizeTargetsExperiment({ prereg, reports, rand: mulberry32(281), iterations: 200 });

describe('summarizeTargetsExperiment (item 281)', () => {
  it('controle que não reproduz o item 270: PARADO e nenhum número de braço', () => {
    const reports = build();
    reports.W1.control = report({ w: 'W1', countedTrades: 113, netExpectancyR: -0.051 });
    const s = run(reports);
    expect(s.status).toBe('PARADO');
    expect(s.arms).toBeNull();
    expect(s.reasons[0]).toMatch(/W1: controle não reproduziu o item 270/);
    expect(formatTargetsMarkdown(s, prereg)).not.toMatch(/fib_literal/);
  });

  it('melhora clara em W1, W2 e W0: APROVADO; sem diferença: SEM_DIFERENCA', () => {
    const better = { W1: 1.0, W2: 1.0, W0: 0.3 };
    const s = run(build({ swing_next: better }));
    expect(s.status).toBe('OK');
    const byLabel = Object.fromEntries(s.arms.map((a) => [a.label, a]));
    expect(byLabel.swing_next.verdict).toBe('APROVADO');
    expect(byLabel.swing_next.cells.W1.outcome).toBe('melhor');
    expect(byLabel.fib_literal.verdict).toBe('SEM_DIFERENCA');
  });

  it('melhor em W1/W2 mas sinal contrário em W0: NAO_REPLICOU; pior nas três: PIOR', () => {
    const s = run(build({ fib_next: { W1: 1, W2: 1, W0: -0.3 }, fib_minr: { W1: -1, W2: -1, W0: -0.2 } }));
    const v = Object.fromEntries(s.arms.map((a) => [a.label, a.verdict]));
    expect(v.fib_next).toBe('NAO_REPLICOU');
    expect(v.fib_minr).toBe('PIOR');
  });

  it('mais de 50% no alvo de hoje numa janela que decide: INCONCLUSIVO', () => {
    const s = run(build({ swing_minr: { W1: 1, W2: 1, W0: 0.3 } }, { swing_minr: { W1: { ops: 40, inconclusiveByFallback: true, fallbackRate: 0.8 } } }));
    const a = s.arms.find((x) => x.label === 'swing_minr');
    expect(a.cells.W1.outcome).toBe('inconclusivo_fallback');
    expect(a.verdict).toBe('INCONCLUSIVO');
  });

  it('braço com procedência errada (outra chave mudou) é recusado, sem número', () => {
    const reports = build();
    reports.W2.arms.swing_literal = report({ w: 'W2', cfg: { ...armCfg('swing_literal'), tp1R: 2 }, targets: T_OK });
    const a = run(reports).arms.find((x) => x.label === 'swing_literal');
    expect(a.cells.W2.outcome).toBe('recusado');
    expect(a.cells.W2.deltaR).toBeUndefined();
    expect(a.verdict).toBe('INCONCLUSIVO');
  });

  it('braço faltando ou inválido: INCONCLUSIVO; markdown lista o veredito de cada braço', () => {
    const reports = build();
    delete reports.W1.arms.fib_literal;
    reports.W2.arms.fib_next = report({ w: 'W2', cfg: armCfg('fib_next'), valid: false });
    const s = run(reports);
    const v = Object.fromEntries(s.arms.map((a) => [a.label, a]));
    expect(v.fib_literal.cells.W1.outcome).toBe('faltando');
    expect(v.fib_next.cells.W2.outcome).toBe('invalido');
    expect(v.fib_literal.verdict).toBe('INCONCLUSIVO');
    const md = formatTargetsMarkdown(s, prereg);
    for (const a of prereg.arms) expect(md).toMatch(new RegExp(`\\*\\*${a.label}\\*\\*`));
  });
});

describe('checkControls e casos da revisão (item 281)', () => {
  const ctl = () => Object.fromEntries(Object.entries(build()).map(([w, v]) => [w, v.control]));

  it('reprodução na precisão registrada: 0,0537 bate com 0,054; 0,0531 não', () => {
    expect(checkControls({ prereg, controls: ctl() }).status).toBe('OK');
    const c = ctl();
    c.W2 = report({ w: 'W2', countedTrades: 119, netExpectancyR: 0.0531 });
    expect(checkControls({ prereg, controls: c })).toMatchObject({ status: 'PARADO' });
  });

  it('controle ausente, inválido ou de outra janela é FALHA_DE_EXECUCAO, não PARADO', () => {
    const c = ctl();
    delete c.W0;
    const r = checkControls({ prereg, controls: c });
    expect(r.status).toBe('FALHA_DE_EXECUCAO');
    expect(formatControlsMarkdown(r)).toMatch(/Falha de execução/);
    const wrongWindow = ctl();
    wrongWindow.W1 = report({ w: 'W2', countedTrades: 115, netExpectancyR: -0.0483 });
    expect(checkControls({ prereg, controls: wrongWindow }).reasons[0]).toMatch(/janela do relatório difere/);
  });

  it('W0 sem dado utilizável (fallback > 50%) com W1/W2 melhores: INCONCLUSIVO, não "não replicou"', () => {
    const s = run(build({ swing_next: { W1: 1, W2: 1, W0: 0.3 } }, { swing_next: { W0: { ops: 30, inconclusiveByFallback: true } } }));
    expect(s.arms.find((a) => a.label === 'swing_next').verdict).toBe('INCONCLUSIVO');
  });

  it('braço sem operação na janela é nao_calculavel, não fallback', () => {
    const s = run(build({}, { fib_literal: { W1: { ops: 0, inconclusiveByFallback: null } } }));
    expect(s.arms.find((a) => a.label === 'fib_literal').cells.W1.outcome).toBe('nao_calculavel');
  });

  it('arquivo de um braço com a config de outro é recusado', () => {
    const reports = build();
    reports.W2.arms.fib_literal = report({ w: 'W2', cfg: armCfg('swing_minr'), targets: T_OK });
    const cell = run(reports).arms.find((a) => a.label === 'fib_literal').cells.W2;
    expect(cell.outcome).toBe('recusado');
    expect(cell.errors[0]).toMatch(/não é do braço fib_literal/);
  });
});

describe('opIdsHash (achado do Codex, PR #508)', () => {
  it('mesmas operações em qualquer ordem = mesmo hash; uma operação trocada muda o hash; sem operação = null', () => {
    const a = report({ w: 'W1' });
    const shuffled = { ...a, overall: { ...a.overall, curve: [...a.overall.curve].reverse() } };
    expect(opIdsHash(shuffled)).toBe(opIdsHash(a));
    const swapped = structuredClone(a);
    swapped.overall.curve[3].op.id = 'outra';
    expect(opIdsHash(swapped)).not.toBe(opIdsHash(a));
    expect(opIdsHash({ overall: { curve: [] } })).toBeNull();
    expect(formatControlsMarkdown(checkControls({ prereg, controls: { W1: a } }))).toMatch(/hash das operações [0-9a-f]{16}/);
  });
});
