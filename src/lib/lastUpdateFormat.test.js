// Texto do chip "Atualizado às …" (docs/known-risks.md item 301). Fuso fixo (UTC) para o resultado não depender da máquina.
import { describe, it, expect } from 'vitest';
import { formatLastUpdate } from './lastUpdateFormat.js';

const UTC = 'UTC';
const t = (iso) => Date.parse(iso);

describe('formatLastUpdate', () => {
  it('hoje: "Atualizado às HH:MM:SS" com segundos', () => {
    expect(formatLastUpdate(t('2026-11-12T14:00:03Z'), t('2026-11-12T18:00:00Z'), UTC)).toBe('Atualizado às 14:00:03');
  });
  it('outro dia: inclui dia/mês, para não parecer de hoje', () => {
    expect(formatLastUpdate(t('2026-11-11T23:10:05Z'), t('2026-11-12T08:00:00Z'), UTC)).toBe('Atualizado 11/11 às 23:10:05');
  });
  it('sem leitura ainda (0, NaN, negativo, undefined, null): "Aguardando dados", nunca um horário inventado', () => {
    for (const v of [0, NaN, -1, undefined, null]) expect(formatLastUpdate(v, Date.now(), UTC)).toBe('Aguardando dados');
  });
  it('virada do dia: 23:59:59 de ontem não é "hoje" à 00:00:01', () => {
    expect(formatLastUpdate(t('2026-11-11T23:59:59Z'), t('2026-11-12T00:00:01Z'), UTC)).toBe('Atualizado 11/11 às 23:59:59');
  });
  it('mesmo dia e mês de outro ano não é "hoje"', () => {
    expect(formatLastUpdate(t('2025-11-12T14:00:03Z'), t('2026-11-12T14:00:03Z'), UTC)).toBe('Atualizado 12/11 às 14:00:03');
  });
});
