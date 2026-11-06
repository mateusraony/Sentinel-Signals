// Item 285 — a calculadora de orçamento do Contexto de Mercado. O teste que
// importa é o de FALHA: provar que ela reprova quando o consumo passa do teto
// (guard que nunca falhou é suposição, não proteção — .claude/rules/testing.md).
import { describe, it, expect } from 'vitest';
import { SCAN_CADENCE_MIN } from '../src/lib/pollingIntervals.js';
import {
  DEFAULT_CONFIG, estimateBudget, stress, exceedsProviderLimit, formatBudgetTable, DAYS_PER_MONTH,
  COLLECTOR_WORST_CASE_RUNS_PER_DAY, RELEASE_WINDOW, estimateReleaseWindow,
} from './contextBudget.mjs';

const bySource = (est, id) => est.sources.find((s) => s.id === id);

describe('pior caso do coletor (3 do cron-job.org + 1 da reserva do `schedule` = 4/dia)', () => {
  it('também cabe em todos os tetos (auditoria de 31/10: o orçamento só contava 3/dia)', () => {
    expect(COLLECTOR_WORST_CASE_RUNS_PER_DAY).toBe(4);
    const est = estimateBudget({ ...DEFAULT_CONFIG, runsPerDay: COLLECTOR_WORST_CASE_RUNS_PER_DAY });
    expect(est.ok).toBe(true);
    expect(est.actions.minutesPerMonth).toBe(360); // 4 x 30 x 3 min, abaixo do teto de 600
    expect(bySource(est, 'fred-release-dates').callsPerMonth).toBe(480); // 4 tipos x 4 x 30
  });

  it('a reserva existe de verdade no workflow (senão o número 4 estaria errado)', async () => {
    const { readFileSync } = await import('node:fs');
    const yml = readFileSync('.github/workflows/context-collect.yml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const crons = [...yml.matchAll(/^\s+- cron: "([^"]+)"/gm)].map((m) => m[1]);
    expect(crons.length).toBe(1); // só a reserva diária; a janela de divulgação vem do fim do scan (workflow_run, orçada à parte: RELEASE_WINDOW)
    expect(crons[0]).toMatch(/^\d+ \d+ \* \* \*$/); // a reserva é DIÁRIA
    expect(yml).toMatch(/workflow_dispatch/); // + as 3 do cron-job.org
  });
});

describe('orçamento do desenho aprovado (3 coletas/dia)', () => {
  const est = estimateBudget(DEFAULT_CONFIG);

  it('cabe em todos os tetos internos', () => {
    expect(est.ok).toBe(true);
  });

  it('CoinGecko: 2 chamadas x 3 coletas x 30 dias = 180/mês (1,8% de 10.000), longe do teto de 50%', () => {
    const cg = bySource(est, 'coingecko');
    expect(cg.callsPerMonth).toBe(180);
    expect(cg.ratio).toBe(0.018);
    expect(cg.ratio).toBeLessThanOrEqual(0.5);
  });

  it('a conta do TXT (cada card consultando a cada 5 min = 77.760/mês) NÃO é o desenho', () => {
    const txtScenario = 9 * 288 * DAYS_PER_MONTH;
    expect(txtScenario).toBe(77760);
    expect(bySource(est, 'coingecko').callsPerMonth).toBeLessThan(txtScenario / 400);
  });

  it('Actions: 3 min x 90 coletas = 270 min/mês, dentro do teto de 600', () => {
    expect(est.actions.minutesPerMonth).toBe(270);
    expect(est.actions.ok).toBe(true);
  });

  it('branch de dados cresce poucos MB por ano', () => {
    expect(est.storage.mbPerYear).toBeLessThan(DEFAULT_CONFIG.storage.internalCapMBPerYear);
  });
});

describe('estresse 10x (30 coletas/dia, 10x os eventos)', () => {
  const est = estimateBudget(stress(DEFAULT_CONFIG, 10));

  it('nenhuma fonte passa do limite DO PROVEDOR (o teto interno é só folga)', () => {
    expect(exceedsProviderLimit(est)).toEqual([]);
    expect(bySource(est, 'coingecko').callsPerMonth).toBe(1800);
  });
});

describe('o guard FALHA quando deve (reintroduzindo o bug)', () => {
  const withCoingeckoCalls = (callsPerRun) => ({
    ...DEFAULT_CONFIG,
    sources: DEFAULT_CONFIG.sources.map((s) => (s.id === 'coingecko' ? { ...s, callsPerRun } : s)),
  });

  it('CoinGecko: 30 chamadas por coleta (27%) ainda cabe; 60 (54%, acima do teto de 50%) reprova', () => {
    expect(estimateBudget(withCoingeckoCalls(30)).ok).toBe(true); // 30 x 90 = 2.700
    const over = estimateBudget(withCoingeckoCalls(60)); // 60 x 90 = 5.400
    expect(bySource(over, 'coingecko').ok).toBe(false);
    expect(over.ok).toBe(false);
  });

  it('Actions acima do teto reprova', () => {
    const slow = { ...DEFAULT_CONFIG, actions: { ...DEFAULT_CONFIG.actions, minutesPerRun: 10 } }; // 900 min/mês
    const est = estimateBudget(slow);
    expect(est.actions.ok).toBe(false);
    expect(est.ok).toBe(false);
  });

  it('crescimento da branch acima do teto reprova', () => {
    const fat = { ...DEFAULT_CONFIG, storage: { ...DEFAULT_CONFIG.storage, eventsPerDay: 500 } };
    const est = estimateBudget(fat);
    expect(est.storage.ok).toBe(false);
    expect(est.ok).toBe(false);
  });

  it('estourar o limite do provedor aparece em exceedsProviderLimit', () => {
    const insane = stress({ ...DEFAULT_CONFIG, sources: DEFAULT_CONFIG.sources.map((s) => (s.id === 'coingecko' ? { ...s, callsPerRun: 50 } : s)) }, 10);
    expect(exceedsProviderLimit(estimateBudget(insane))).toEqual(['coingecko']);
  });
});

describe('tabela para o resumo do job', () => {
  it('lista todas as fontes e a situação, sem emoji', () => {
    const table = formatBudgetTable(estimateBudget(DEFAULT_CONFIG));
    for (const s of DEFAULT_CONFIG.sources) expect(table).toContain(s.id);
    expect(table).toContain('OK');
    expect(table).toMatch(/GitHub Actions: 270 min\/mês/);
    expect(/\p{Extended_Pictographic}/u.test(table)).toBe(false);
  });
});

// Addenda 15/17 — o modo "janela" do coletor (fim do "Scheduled scan" via workflow_run; job do cron-job.org opcional). Orçamento à parte; o teste que importa é o de FALHA.
describe('modo "janela" do coletor (addenda 15/17)', () => {
  it('cabe: 360 min/mês de Actions e 75 consultas/dia ao BLS no pior caso (teto 600 min e 250 consultas)', () => {
    const e = estimateReleaseWindow();
    expect(e.runsPerMonth).toBe(360);
    expect(e.minutesPerMonth).toBe(360);
    expect(e.blsCallsPerDay).toBe(75); // 15 das 3 coletas + 12 disparos x 5 séries
    expect(e.ok).toBe(true);
  });

  it('reprova quando o consumo passa do teto (disparo a cada minuto estoura os minutos; trabalho em todo disparo com mais séries estoura o BLS)', () => {
    const aCadaMinuto = estimateReleaseWindow({ ...RELEASE_WINDOW, runsPerDay: 180 });
    expect(aCadaMinuto.minutesOk).toBe(false);
    expect(aCadaMinuto.ok).toBe(false);
    const muitasSeries = estimateReleaseWindow({ ...RELEASE_WINDOW, blsCallsPerWorkingRun: 25 });
    expect(muitasSeries.blsOk).toBe(false);
    expect(muitasSeries.ok).toBe(false);
  });

  it('o filtro do workflow dá exatamente os disparos que o orçamento conta (scans por hora x horas do `if:`, 12 por dia)', async () => {
    const { readFileSync } = await import('node:fs');
    const yml = readFileSync('.github/workflows/context-collect.yml', 'utf8').split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    const horas = [...yml.matchAll(/contains\(github\.event\.workflow_run\.updated_at, 'T(\d{2}):'\)/g)].map((m) => m[1]);
    expect(horas, 'o `if:` do job precisa listar as horas da janela').toEqual(['12', '13', '14']);
    expect((60 / SCAN_CADENCE_MIN) * horas.length).toBe(RELEASE_WINDOW.runsPerDay);
    expect(RELEASE_WINDOW.daysPerMonth).toBe(30); // sem filtro de dia da semana no `if:`
    expect(yml).not.toMatch(/github\.event\.workflow_run\.[a-z_]*day/);
  });

  it('o job OPCIONAL do cron-job.org (guia) usa o mesmo corpo; ligar os DOIS (fim do scan + cron-job.org) dobra os disparos e estoura o teto interno de minutos', async () => {
    const { readFileSync } = await import('node:fs');
    expect(readFileSync('docs/claude/external-cron-setup.md', 'utf8')).toContain('"inputs":{"mode":"janela"}');
    const dobro = estimateReleaseWindow({ ...RELEASE_WINDOW, runsPerDay: RELEASE_WINDOW.runsPerDay * 2 });
    expect(dobro.minutesPerMonth).toBe(720);
    expect(dobro.minutesOk).toBe(false);
  });
});
