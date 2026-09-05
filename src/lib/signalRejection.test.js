// docs/known-risks.md item 163 — o horário da recusa e o detalhe do motivo.
// A restrição que domina estes testes: a escrita é write-on-change, e um
// detalhe numérico (ADX 18,3 → 18,7) mataria isso, forçando uma escrita por
// ativo a cada 5 minutos logo depois de dois incidentes de cota (155/158).
import { describe, it, expect } from 'vitest';
import {
  REJECTION_DETAIL, regimeDetail, rejectionPatch, trendReversedDetail,
} from './signalRejection.js';

describe('regimeDetail', () => {
  it('separa os dois gates que "regime_rejected" juntava numa palavra só', () => {
    expect(regimeDetail({ ok: false, adxOk: false, chopOk: true })).toBe(REJECTION_DETAIL.ADX);
    expect(regimeDetail({ ok: false, adxOk: true, chopOk: false })).toBe(REJECTION_DETAIL.CHOP);
    expect(regimeDetail({ ok: false, adxOk: false, chopOk: false })).toBe(REJECTION_DETAIL.ADX_CHOP);
  });

  it('não detalha um regime que passou nem um objeto ausente', () => {
    expect(regimeDetail({ ok: true, adxOk: true, chopOk: true })).toBeNull();
    expect(regimeDetail(null)).toBeNull();
  });

  it('gate desligado (ok undefined) não é reprovação — não inventa detalhe', () => {
    // evaluateRegime devolve adxOk/chopOk indefinidos quando o gate está off.
    expect(regimeDetail({ ok: false, adxOk: undefined, chopOk: undefined })).toBeNull();
  });
});

describe('trendReversedDetail', () => {
  it('diz para que lado a tendência está apontando agora', () => {
    expect(trendReversedDetail(1)).toBe(REJECTION_DETAIL.NOW_UP);
    expect(trendReversedDetail(-1)).toBe(REJECTION_DETAIL.NOW_DOWN);
    expect(trendReversedDetail(0)).toBeNull();
    expect(trendReversedDetail(undefined)).toBeNull();
  });
});

describe('rejectionPatch — write-on-change', () => {
  const AGORA = '2026-09-05T12:00:00.000Z';

  it('carimba a primeira rejeição de um sinal', () => {
    expect(rejectionPatch({}, 'trend_reversed', REJECTION_DETAIL.NOW_DOWN, AGORA)).toEqual({
      last_rejection_reason: 'trend_reversed',
      last_rejection_detail: 'now_down',
      last_rejection_at: AGORA,
    });
  });

  it('REGRESSÃO DE CUSTO: mesmo motivo e mesmo detalhe não geram escrita', () => {
    const sig = { last_rejection_reason: 'regime_rejected', last_rejection_detail: 'chop' };
    expect(rejectionPatch(sig, 'regime_rejected', REJECTION_DETAIL.CHOP, AGORA)).toBeNull();
  });

  it('o horário não avança enquanto o motivo não muda — é "desde quando", não "última checagem"', () => {
    const sig = {
      last_rejection_reason: 'regime_rejected',
      last_rejection_detail: 'chop',
      last_rejection_at: '2026-09-05T08:00:00.000Z',
    };
    expect(rejectionPatch(sig, 'regime_rejected', REJECTION_DETAIL.CHOP, AGORA)).toBeNull();
  });

  it('detalhe diferente com o mesmo motivo É informação nova e recarimba', () => {
    const sig = { last_rejection_reason: 'regime_rejected', last_rejection_detail: 'chop' };
    expect(rejectionPatch(sig, 'regime_rejected', REJECTION_DETAIL.ADX, AGORA)).toEqual({
      last_rejection_reason: 'regime_rejected',
      last_rejection_detail: 'adx',
      last_rejection_at: AGORA,
    });
  });

  it('motivo sem detalhe grava null explícito — Firestore rejeita undefined (P0-h, item 136)', () => {
    const patch = rejectionPatch({}, 'retest_pending', undefined, AGORA);
    expect(patch.last_rejection_detail).toBeNull();
    expect(Object.values(patch).every((v) => v !== undefined)).toBe(true);
  });

  it('sinal legado (só reason, sem detail) não é recarimbado à toa', () => {
    // Sinais criados antes deste item têm last_rejection_detail ausente.
    const legado = { last_rejection_reason: 'retest_pending' };
    expect(rejectionPatch(legado, 'retest_pending', null, AGORA)).toBeNull();
  });
});
