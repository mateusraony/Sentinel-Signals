import { describe, it, expect } from 'vitest';
import {
  SIGNAL_PHASE, REASON_KIND, REJECTION_COPY, CONFIRMATION_WINDOW_MS,
  classifySignal, isConfirmationEligible, phaseCopy, rejectionCopy,
  reasonIcon, formatTimeLeft,
} from './signalStatus';

const NOW = Date.parse('2026-09-05T12:00:00.000Z');
const sig = (over = {}) => ({ timeframe: '4h', signal_type: 'BUY', created_date: '2026-09-05T10:00:00.000Z', ...over });

describe('classifySignal', () => {
  it('4h dentro da janela está esperando confirmação', () => {
    const r = classifySignal(sig(), NOW);
    expect(r.phase).toBe(SIGNAL_PHASE.WAITING);
    expect(r.msLeft).toBe(2 * 60 * 60 * 1000);
  });

  it('4h fora da janela expirou', () => {
    expect(classifySignal(sig({ created_date: '2026-09-05T07:00:00.000Z' }), NOW).phase).toBe(SIGNAL_PHASE.EXPIRED);
  });

  it('expired_logged vence o relógio', () => {
    expect(classifySignal(sig({ expired_logged: true }), NOW).phase).toBe(SIGNAL_PHASE.EXPIRED);
  });

  it('1h/1d é sempre informativo e nunca expira', () => {
    for (const tf of ['1h', '1d', '15m']) {
      const r = classifySignal(sig({ timeframe: tf, created_date: '2020-01-01T00:00:00.000Z' }), NOW);
      expect(r.phase).toBe(SIGNAL_PHASE.INFO);
      expect(r.msLeft).toBeNull();
    }
  });

  it('data inválida não vira "expirado" por acidente', () => {
    expect(classifySignal(sig({ created_date: 'lixo' }), NOW).phase).toBe(SIGNAL_PHASE.WAITING);
  });

  it('a janela é a mesma do motor (4h)', () => {
    expect(CONFIRMATION_WINDOW_MS).toBe(4 * 60 * 60 * 1000);
    expect(isConfirmationEligible({ timeframe: '4h' })).toBe(true);
  });
});

describe('phaseCopy', () => {
  it('toda fase diz explicitamente que o usuário não precisa agir', () => {
    for (const phase of Object.values(SIGNAL_PHASE)) {
      const copy = phaseCopy(phase);
      expect(copy.badge).toBeTruthy();
      expect(copy.reassurance).toMatch(/não precisa fazer nada|perdeu nada|pode ignorar/i);
    }
  });

  it('fase desconhecida degrada sem quebrar', () => {
    expect(phaseCopy('inexistente').badge).toBeTruthy();
  });
});

describe('rejectionCopy', () => {
  it('toda chave conhecida termina resolvendo "e eu, faço o quê?"', () => {
    for (const key of Object.keys(REJECTION_COPY)) {
      const copy = rejectionCopy({ last_rejection_reason: key, signal_type: 'BUY' });
      expect(copy.detail).toMatch(/Nada a fazer\.$/);
      expect(copy.chip.length).toBeLessThanOrEqual(28);
      expect(Object.values(REASON_KIND)).toContain(copy.kind);
    }
  });

  it('nenhum texto novo vaza jargão do motor', () => {
    // \b para não casar dentro de palavra ("d-EMA-is" não é o indicador EMA).
    const jargao = /Range Filter|\b(timeframe|ADX|Choppiness|SMC|MACD|EMA|RSI|ATR|candle|gate|minRR|OTE|retest|displacement)\b/i;
    for (const key of Object.keys(REJECTION_COPY)) {
      const { chip, detail } = rejectionCopy({ last_rejection_reason: key, signal_type: 'BUY' });
      expect(`${chip} ${detail}`).not.toMatch(jargao);
    }
  });

  it('o chip de zona desfavorável acompanha a direção do aviso', () => {
    const buy = rejectionCopy({ last_rejection_reason: 'ote_zone_unfavorable', signal_type: 'BUY' });
    const sell = rejectionCopy({ last_rejection_reason: 'ote_zone_unfavorable', signal_type: 'SELL' });
    expect(buy.chip).toMatch(/subiu/);
    expect(sell.chip).toMatch(/caiu/);
  });

  it('sem motivo registrado, explica que o app acabou de receber o aviso', () => {
    const copy = rejectionCopy({ signal_type: 'BUY' });
    expect(copy.chip).toBe('Checando agora');
    expect(copy.detail).toMatch(/Nada a fazer\.$/);
  });

  it('chave desconhecida não vira tela vazia nem código cru sem contexto', () => {
    const copy = rejectionCopy({ last_rejection_reason: 'motivo_inventado', signal_type: 'BUY' });
    expect(copy.detail).toContain('motivo_inventado');
    expect(copy.detail).toMatch(/Nada a fazer\.$/);
    expect(copy.kind).toBe(REASON_KIND.APP);
  });

  it('cada família tem um ícone distinto', () => {
    const icons = Object.values(REASON_KIND).map(reasonIcon);
    expect(new Set(icons).size).toBe(icons.length);
  });
});

describe('formatTimeLeft', () => {
  it('encurta a contagem', () => {
    expect(formatTimeLeft(107 * 60_000)).toBe('1h47');
    expect(formatTimeLeft(9 * 60_000)).toBe('9min');
    expect(formatTimeLeft(60 * 60_000)).toBe('1h00');
  });

  it('devolve null quando não há prazo', () => {
    for (const bad of [0, -1, null, undefined, NaN]) expect(formatTimeLeft(bad)).toBeNull();
  });
});
