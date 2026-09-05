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

  // item 163 — as variantes por detalhe são o texto que o usuário lê na
  // maioria das vezes (regime_rejected e confirmation_15m_not_aligned são os
  // dois motivos mais frequentes em produção). Elas precisam obedecer às
  // MESMAS regras da frase-base, senão a correção do item 163 reabre
  // exatamente o buraco que o item 156 fechou.
  it('toda variante por detalhe também resolve "e eu, faço o quê?"', () => {
    for (const [key, entry] of Object.entries(REJECTION_COPY)) {
      for (const detalhe of Object.keys(entry.by ?? {})) {
        for (const lado of ['BUY', 'SELL']) {
          const copy = rejectionCopy({ last_rejection_reason: key, last_rejection_detail: detalhe, signal_type: lado });
          expect(copy.detail, `${key}/${detalhe}/${lado}`).toMatch(/Nada a fazer\.$/);
          expect(copy.chip.length, `${key}/${detalhe}/${lado}: "${copy.chip}"`).toBeLessThanOrEqual(28);
          expect(Object.values(REASON_KIND)).toContain(copy.kind);
        }
      }
    }
  });

  it('a variante diz algo DIFERENTE da frase-base — senão o detalhe não serviu para nada', () => {
    const base = rejectionCopy({ last_rejection_reason: 'regime_rejected', signal_type: 'BUY' });
    for (const detalhe of ['adx', 'chop', 'adx_chop']) {
      const variante = rejectionCopy({ last_rejection_reason: 'regime_rejected', last_rejection_detail: detalhe, signal_type: 'BUY' });
      expect(variante.detail).not.toBe(base.detail);
    }
    // "o pavio perdeu força" era literalmente o exemplo do usuário do que ele
    // queria saber: o texto do ADX precisa falar de FORÇA do movimento.
    expect(rejectionCopy({ last_rejection_reason: 'regime_rejected', last_rejection_detail: 'adx' }).detail)
      .toMatch(/fraco|for[çc]a/i);
    expect(rejectionCopy({ last_rejection_reason: 'regime_rejected', last_rejection_detail: 'chop' }).detail)
      .toMatch(/de lado|faixa/i);
  });

  it('detalhe desconhecido cai na frase-base completa, nunca em texto vazio', () => {
    const copy = rejectionCopy({ last_rejection_reason: 'regime_rejected', last_rejection_detail: 'detalhe_do_futuro', signal_type: 'BUY' });
    expect(copy.detail).toBe(rejectionCopy({ last_rejection_reason: 'regime_rejected', signal_type: 'BUY' }).detail);
  });

  it('nenhum texto novo vaza jargão do motor', () => {
    // Borda de palavra que ENXERGA ACENTO. `\b` sozinho não serve: `\w` é só
    // [A-Za-z0-9_], então `\batr\b` casa dentro de "voltar atrás" (o `á` conta
    // como borda) e `\bema\b` casaria em "d-ema-is". Os dois já deram falso
    // positivo aqui — a lista proíbe o NOME TÉCNICO do indicador, não pedaços
    // de palavras comuns em português.
    const LETRA = 'A-Za-z0-9_À-ÖØ-öø-ÿ';
    const jargao = new RegExp(
      `Range Filter|(?<![${LETRA}])(timeframe|ADX|Choppiness|SMC|MACD|EMA|RSI|ATR|candle|gate|minRR|OTE|retest|displacement)(?![${LETRA}])`,
      'i',
    );
    for (const [key, entry] of Object.entries(REJECTION_COPY)) {
      for (const detalhe of [undefined, ...Object.keys(entry.by ?? {})]) {
        const { chip, detail } = rejectionCopy({ last_rejection_reason: key, last_rejection_detail: detalhe, signal_type: 'BUY' });
        expect(`${chip} ${detail}`, `${key}/${detalhe}`).not.toMatch(jargao);
      }
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
