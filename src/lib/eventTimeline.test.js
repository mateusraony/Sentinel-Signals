import { describe, it, expect } from 'vitest';
import {
  opTimeline, signalTimeline, closedReasonLabel, CONFIRMATION_WINDOW_MS,
} from './eventTimeline';

const T = (h, m = 0) => `2026-09-05T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00.000Z`;

describe('opTimeline', () => {
  it('só lista o que aconteceu de verdade', () => {
    const op = { created_date: T(8), status: 'SIGNAL_CONFIRMED' };
    expect(opTimeline(op).map(e => e.key)).toEqual(['opened']);
  });

  it('ordena cronologicamente, não pela ordem dos campos', () => {
    const op = {
      created_date: T(8), status: 'TP2_HIT',
      tp1_hit_real_time: T(10), tp2_hit_real_time: T(12), closed_at_real_time: T(12),
    };
    expect(opTimeline(op).map(e => e.key)).toEqual(['opened', 'tp1', 'tp2']);
  });

  it('prefere o horário de MERCADO ao do relógio, e guarda a defasagem', () => {
    const op = { created_date: T(8), status: 'STOP_HIT', stop_hit_real_time: T(10), stop_hit_at: T(13) };
    const stop = opTimeline(op).find(e => e.key === 'stop');
    expect(stop.at).toBe(T(10));          // mercado
    expect(stop.detectedAt).toBe(T(13));  // relógio, para mostrar o atraso
    expect(stop.candleBound).toBe(true);
  });

  it('sem horário de mercado, cai no relógio e não finge precisão de vela', () => {
    const op = { created_date: T(8), status: 'STOP_HIT', stop_hit_at: T(13) };
    const stop = opTimeline(op).find(e => e.key === 'stop');
    expect(stop.at).toBe(T(13));
    expect(stop.detectedAt).toBeNull();
    expect(stop.candleBound).toBe(false);
  });

  it('não duplica o fechamento quando ele coincide com o stop/TP2', () => {
    const op = {
      created_date: T(8), status: 'STOP_HIT',
      stop_hit_real_time: T(11), closed_at_real_time: T(11),
    };
    expect(opTimeline(op).map(e => e.key)).toEqual(['opened', 'stop']);
  });

  it('inclui o fechamento quando ele é um evento próprio (time stop, invalidação)', () => {
    const op = { created_date: T(8), status: 'INVALIDATED', closed_at_real_time: T(11) };
    const keys = opTimeline(op).map(e => e.key);
    expect(keys).toContain('closed');
    expect(opTimeline(op).find(e => e.key === 'closed').label).toBe('Invalidada');
  });

  it('degrada sem lançar em operação vazia ou com data inválida', () => {
    expect(opTimeline(null)).toEqual([]);
    expect(opTimeline({})).toEqual([]);
    expect(opTimeline({ created_date: 'lixo' })).toEqual([]);
  });
});

describe('closedReasonLabel', () => {
  it('traduz o motivo do encerramento para linguagem simples', () => {
    expect(closedReasonLabel({ closed_reason: 'TIME_STOP' })).toBe('tempo esgotado');
    expect(closedReasonLabel({ closed_reason: 'CHOP_EXIT' })).toBe('mercado sem direção');
  });

  it('devolve null para motivo ausente ou desconhecido', () => {
    expect(closedReasonLabel({})).toBeNull();
    expect(closedReasonLabel({ closed_reason: 'INVENTADO' })).toBeNull();
  });
});

describe('signalTimeline', () => {
  it('num aviso de 4h, mostra quando apareceu e quando o prazo fecha', () => {
    const events = signalTimeline({ timeframe: '4h', created_date: T(8) }, { now: Date.parse(T(9)) });
    expect(events.map(e => e.key)).toEqual(['appeared', 'deadline']);
    expect(events[1].label).toBe('Prazo fecha');
    expect(Date.parse(events[1].at) - Date.parse(T(8))).toBe(CONFIRMATION_WINDOW_MS);
  });

  it('fala no passado depois que o prazo passou', () => {
    const events = signalTimeline({ timeframe: '4h', created_date: T(8) }, { now: Date.parse(T(20)) });
    expect(events[1].label).toBe('Prazo fechou');
  });

  it('aviso de 1h/1d não tem prazo — nunca confirma nem expira', () => {
    for (const tf of ['1h', '1d']) {
      expect(signalTimeline({ timeframe: tf, created_date: T(8) }).map(e => e.key)).toEqual(['appeared']);
    }
  });

  it('degrada sem lançar', () => {
    expect(signalTimeline(null)).toEqual([]);
    expect(signalTimeline({ timeframe: '4h', created_date: 'lixo' })).toEqual([]);
  });

  // Trava documental do item 161, ainda válida depois do 163: o carimbo agora
  // existe, mas só a partir do 163 — todo sinal anterior tem o motivo e NÃO
  // tem o horário. Este teste falha se alguém achar que pode preencher a
  // lacuna com uma aproximação.
  it('nunca inventa um horário de rejeição — motivo sem carimbo não vira linha', () => {
    // Sinal anterior ao item 163: tem o motivo, não tem o horário.
    const events = signalTimeline({
      timeframe: '4h', created_date: T(8), last_rejection_reason: 'trend_reversed',
    }, { now: Date.parse(T(9)) });
    expect(events.some(e => e.key.includes('reject'))).toBe(false);
  });

  // docs/known-risks.md item 163 — o motor passou a gravar last_rejection_at.
  it('mostra o horário da recusa quando o motor o gravou', () => {
    const events = signalTimeline({
      timeframe: '4h', created_date: T(8),
      last_rejection_reason: 'regime_rejected', last_rejection_detail: 'chop',
      last_rejection_at: T(9),
    }, { now: Date.parse(T(10)) });

    const rejected = events.find(e => e.key === 'rejected');
    expect(rejected.at).toBe(T(9));
    // "desde", não "em": o carimbo só avança quando o MOTIVO muda.
    expect(rejected.label).toBe('Barrado desde');
    // Não é fechamento de vela — é relógio. Não pode ganhar a etiqueta (vela).
    expect(rejected.candleBound).toBe(false);
  });

  it('a recusa entra na ordem cronológica certa, entre o aviso e o prazo', () => {
    const events = signalTimeline({
      timeframe: '4h', created_date: T(8), last_rejection_at: T(9),
    }, { now: Date.parse(T(10)) });
    expect(events.map(e => e.key)).toEqual(['appeared', 'rejected', 'deadline']);
  });
});
