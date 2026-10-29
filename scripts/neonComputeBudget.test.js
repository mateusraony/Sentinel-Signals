// Item 286 — orçamento de computação do Neon. O teste que importa é a CALIBRAÇÃO
// (o modelo tem que reproduzir o estouro real de 5 min) e o GUARDA (quebra se
// alguém aumentar a frequência dos disparos que acordam o banco).
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  cronMinutesOfDay, estimateNeonComputeHours, extractWorkflowCrons, workflowTouchesDatabase,
  NEON_FREE_CU_HOURS,
} from './neonComputeBudget.mjs';
import { SCAN_CADENCE_MIN } from '../src/lib/pollingIntervals.js';

const WORKFLOWS_DIR = join(process.cwd(), '.github', 'workflows');

/** Agendamentos (cron) de workflows que tocam o banco, descobertos do repositório. */
function dbScheduledCrons() {
  const found = [];
  for (const name of readdirSync(WORKFLOWS_DIR).filter((n) => /\.ya?ml$/.test(n))) {
    const text = readFileSync(join(WORKFLOWS_DIR, name), 'utf8');
    if (!workflowTouchesDatabase(text)) continue;
    for (const cron of extractWorkflowCrons(text)) found.push({ name, cron });
  }
  return found;
}

describe('cronMinutesOfDay', () => {
  it('expande horas, passos e listas', () => {
    expect(cronMinutesOfDay('7 */3 * * *')).toEqual([7, 187, 367, 547, 727, 907, 1087, 1267]);
    expect(cronMinutesOfDay('23 */6 * * *')).toEqual([23, 383, 743, 1103]);
    expect(cronMinutesOfDay('40 4 * * *')).toEqual([4 * 60 + 40]);
    expect(cronMinutesOfDay('7 0 * * *')).toEqual([7]);
  });

  it('recusa o que não entende em vez de adivinhar', () => {
    expect(() => cronMinutesOfDay('0 0 1 * *')).toThrow(/não suportado/);
    expect(() => cronMinutesOfDay('1-5 * * * *')).toThrow(/não suportado/);
    expect(() => cronMinutesOfDay('* * * *')).toThrow(/5 campos/);
  });
});

describe('modelo de computação do Neon', () => {
  it('CALIBRAÇÃO: scan a cada 5 min nunca deixa o banco dormir (~180 h/mês) — o estouro real', () => {
    const r = estimateNeonComputeHours({ dispatchEveryMin: 5 });
    expect(r.share).toBe(1);
    expect(r.cuHoursPerMonth).toBe(180);
    // Observado: 110,33 h em ~19 dias => 0,25 CU x 24 h x 19 d = 114. Mesma ordem.
    expect(r.cuHoursPerMonth * (19 / 30)).toBeGreaterThan(100);
    expect(r.cuHoursPerMonth).toBeGreaterThan(NEON_FREE_CU_HOURS);
  });

  it('a cada 15 min o banco dorme entre as passadas (~40% do tempo acordado)', () => {
    const r = estimateNeonComputeHours({ dispatchEveryMin: 15 });
    expect(r.wakesPerDay).toBe(96);
    expect(r.share).toBeCloseTo(0.4, 1);
    expect(r.cuHoursPerMonth).toBeLessThan(75);
  });

  it('a cada 10 min ainda gasta mais que o limite com folga mínima; a cada 30 min sobra muito', () => {
    expect(estimateNeonComputeHours({ dispatchEveryMin: 10 }).cuHoursPerMonth).toBeGreaterThan(100);
    expect(estimateNeonComputeHours({ dispatchEveryMin: 30 }).cuHoursPerMonth).toBeLessThan(40);
  });

  it('janelas que se sobrepõem não são contadas duas vezes', () => {
    const sozinho = estimateNeonComputeHours({ dispatchEveryMin: 0, scheduledCrons: ['0 0 * * *'] });
    const junto = estimateNeonComputeHours({ dispatchEveryMin: 0, scheduledCrons: ['0 0 * * *', '2 0 * * *'] });
    expect(sozinho.awakeMinutesPerDay).toBe(6);
    expect(junto.awakeMinutesPerDay).toBe(8); // [0,6) U [2,8) = 8, não 12
  });
});

describe('GUARDA: o conjunto real de disparos cabe no plano gratuito (item 286)', () => {
  const agendados = dbScheduledCrons();

  it('não-vacuidade: acha os agendamentos conhecidos que tocam o banco', () => {
    const nomes = agendados.map((a) => a.name);
    expect(nomes).toEqual(expect.arrayContaining(['scan.yml', 'backfill.yml', 'backup-postgres.yml', 'health-audit.yml']));
  });

  it('com a cadência da tela (SCAN_CADENCE_MIN) + todos os agendamentos, fica abaixo de 85 h/mês', () => {
    // 85 h deixa >= 15 h (~1 h por dia e meia) para o painel aberto, o medidor e imprevistos.
    const r = estimateNeonComputeHours({ dispatchEveryMin: SCAN_CADENCE_MIN, scheduledCrons: agendados.map((a) => a.cron) });
    expect(r.cuHoursPerMonth).toBeLessThan(85);
  });

  it('REGRESSÃO (o bug): backfill de hora em hora + reserva de hora em hora estouram o orçamento folgado', () => {
    // Reintroduz a configuração anterior: o guarda tem que reprovar.
    const antigos = agendados.map((a) => {
      if (a.name === 'backfill.yml') return '23 * * * *';
      if (a.name === 'scan.yml') return '7 * * * *';
      return a.cron;
    });
    const r = estimateNeonComputeHours({ dispatchEveryMin: SCAN_CADENCE_MIN, scheduledCrons: antigos });
    expect(r.cuHoursPerMonth).toBeGreaterThanOrEqual(85);
  });

  it('REGRESSÃO (o bug): voltar a cadência para 5 min reprova', () => {
    const r = estimateNeonComputeHours({ dispatchEveryMin: 5, scheduledCrons: agendados.map((a) => a.cron) });
    expect(r.cuHoursPerMonth).toBeGreaterThan(NEON_FREE_CU_HOURS);
  });

  it('a cadência da tela é a que o plano assume (15 min)', () => {
    expect(SCAN_CADENCE_MIN).toBe(15);
  });
});
