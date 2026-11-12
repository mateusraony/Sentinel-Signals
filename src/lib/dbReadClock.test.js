// "Última leitura do banco que deu certo" (docs/known-risks.md item 301): o horário do chip "Atualizado às".
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { noteDbRead, getLastDbRead, subscribeDbRead, resetDbReadClock } from './dbReadClock.js';

describe('dbReadClock', () => {
  beforeEach(() => resetDbReadClock());

  it('começa em 0 ("Aguardando dados")', () => {
    expect(getLastDbRead()).toBe(0);
  });
  it('guarda o instante informado e, sem argumento, o relógio de agora', () => {
    noteDbRead(1234);
    expect(getLastDbRead()).toBe(1234);
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T14:00:03Z'));
    noteDbRead();
    expect(getLastDbRead()).toBe(Date.parse('2026-11-12T14:00:03Z'));
    vi.useRealTimers();
  });
  it('avisa quem ouve a cada leitura, e cancelar a inscrição funciona', () => {
    const a = vi.fn();
    const cancelar = subscribeDbRead(a);
    noteDbRead(1);
    noteDbRead(2);
    expect(a).toHaveBeenCalledTimes(2);
    cancelar();
    noteDbRead(3);
    expect(a).toHaveBeenCalledTimes(2);
  });
  it('um ouvinte que lança não impede os outros nem o registro', () => {
    const ruim = vi.fn(() => { throw new Error('defeito'); });
    const bom = vi.fn();
    subscribeDbRead(ruim);
    subscribeDbRead(bom);
    expect(() => noteDbRead(5)).not.toThrow();
    expect(bom).toHaveBeenCalledTimes(1);
    expect(getLastDbRead()).toBe(5);
  });
});
