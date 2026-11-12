// Textos da barra "Atualizado às …" (docs/known-risks.md item 301). Fuso fixo (UTC) para o resultado não depender da máquina.
import { describe, it, expect } from 'vitest';
import { formatLastUpdate, formatClock, describeMode } from './liveStatusFormat.js';

const UTC = 'UTC';
const t = (iso) => Date.parse(iso);

describe('formatLastUpdate', () => {
  it('hoje: "Atualizado às HH:MM:SS" com segundos', () => {
    expect(formatLastUpdate(t('2026-11-12T16:41:20Z'), t('2026-11-12T18:00:00Z'), UTC)).toBe('Atualizado às 16:41:20');
  });
  it('outro dia: inclui dia/mês, para não parecer de hoje', () => {
    expect(formatLastUpdate(t('2026-11-11T23:10:05Z'), t('2026-11-12T08:00:00Z'), UTC)).toBe('Atualizado 11/11 às 23:10:05');
  });
  it('sem dado ainda (0, NaN, negativo, undefined): "Aguardando dados", nunca um horário inventado', () => {
    for (const v of [0, NaN, -1, undefined, null]) expect(formatLastUpdate(v, Date.now(), UTC)).toBe('Aguardando dados');
  });
  it('virada do dia: 23:59:59 de ontem não é "hoje" à 00:00:01', () => {
    expect(formatLastUpdate(t('2026-11-11T23:59:59Z'), t('2026-11-12T00:00:01Z'), UTC)).toBe('Atualizado 11/11 às 23:59:59');
  });
});

describe('formatClock', () => {
  it('"17:41" sem segundos', () => {
    expect(formatClock(t('2026-11-12T17:41:59Z'), UTC)).toBe('17:41');
  });
  it('valor inválido: texto vazio', () => {
    expect(formatClock(NaN, UTC)).toBe('');
  });
});

describe('describeMode', () => {
  it('normal: "ao vivo"', () => {
    expect(describeMode({ resting: false, liveUntil: null }, 30, UTC)).toEqual({ kind: 'active', full: 'ao vivo', short: 'ao vivo' });
  });
  it('em repouso: diz que atualiza a cada N min (não diz "parado")', () => {
    const m = describeMode({ resting: true, liveUntil: null }, 30, UTC);
    expect(m.kind).toBe('rest');
    expect(m.full).toBe('em repouso · atualiza a cada 30 min');
    expect(m.full).not.toMatch(/parad|congelad|pausad/i);
    expect(m.short).toBe('repouso · 30 min');
  });
  it('"Manter ao vivo": mostra até que horas', () => {
    const m = describeMode({ resting: false, liveUntil: t('2026-11-12T17:41:00Z') }, 30, UTC);
    expect(m.kind).toBe('live');
    expect(m.full).toBe('ao vivo até 17:41');
  });
  it('repouso vence: um estado inconsistente (repouso e ao vivo juntos) nunca anuncia "ao vivo"', () => {
    expect(describeMode({ resting: true, liveUntil: t('2026-11-12T17:41:00Z') }, 30, UTC).kind).toBe('rest');
  });
});
