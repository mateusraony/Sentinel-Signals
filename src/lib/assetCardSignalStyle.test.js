// Item 290: estilo do cartão do ativo pela FASE do último aviso. O que se prova: cada fase tem rótulo e cor da fonte
// única (`phaseCopy`), só "esperando confirmação" ganha contorno âmbar, "já passou"/"só informação" ficam sem destaque e com
// o selo BUY/SELL apagado, a cor NUNCA depende do lado (item 277) e nenhum texto sugere compra/venda iminente.
import { describe, it, expect } from 'vitest';
import { signalCardStyle, reasonColor, reasonColorFor, REASON_COLORS } from './assetCardSignalStyle.js';
import { SIGNAL_PHASE, REASON_KIND, phaseCopy } from './signalStatus.js';

describe('signalCardStyle', () => {
  it('esperando confirmação: rótulo da fonte única, contorno e brilho âmbar, selo vivo', () => {
    const s = signalCardStyle(SIGNAL_PHASE.WAITING);
    const copy = phaseCopy(SIGNAL_PHASE.WAITING);
    expect(s.label).toBe(`${copy.icon} ${copy.badge}`);
    expect(s.label).toBe('⏳ Esperando confirmação');
    expect(s.labelColor).toBe(copy.color);
    expect(s.border).toMatch(/^rgba\(227,180,90,/);
    expect(s.glow).toMatch(/rgba\(227,180,90,/);
    expect(s.dimBadge).toBe(false);
  });

  it('já passou e só informação: sem contorno nem brilho de destaque e com o selo apagado', () => {
    for (const phase of [SIGNAL_PHASE.EXPIRED, SIGNAL_PHASE.INFO]) {
      const s = signalCardStyle(phase);
      expect(s.label).toBe(`${phaseCopy(phase).icon} ${phaseCopy(phase).badge}`);
      expect(s.labelColor).toBe(phaseCopy(phase).color);
      expect(s.border).toBeNull();
      expect(s.glow).toBeNull();
      expect(s.dimBadge).toBe(true);
    }
    expect(signalCardStyle(SIGNAL_PHASE.EXPIRED).label).toBe('🚫 Já passou');
  });

  it('só "só informação" esconde o chip do motivo (o rótulo já diz isso)', () => {
    expect(signalCardStyle(SIGNAL_PHASE.WAITING).showReason).toBe(true);
    expect(signalCardStyle(SIGNAL_PHASE.EXPIRED).showReason).toBe(true);
    expect(signalCardStyle(SIGNAL_PHASE.INFO).showReason).toBe(false);
  });

  it('fase desconhecida ou ausente: null (o cartão cai no comportamento de antes)', () => {
    for (const x of [undefined, null, '', 'qualquer', 7]) expect(signalCardStyle(x)).toBeNull();
  });

  it('a função só recebe a FASE: a cor não pode depender do lado (item 277)', () => {
    expect(signalCardStyle.length).toBe(1);
    const todos = [SIGNAL_PHASE.WAITING, SIGNAL_PHASE.EXPIRED, SIGNAL_PHASE.INFO].map((p) => JSON.stringify(signalCardStyle(p))).join(' ');
    // nada de verde (#5db586 / 0,255,128) nem rosa (#e06a5b / 255,20,120), as cores do lado BUY/SELL
    expect(todos).not.toMatch(/00ff80|0,255,128|ff1478|255,20,120/i);
  });

  it('texto neutro: nada de compra, venda, iminente ou probabilidade', () => {
    const textos = [SIGNAL_PHASE.WAITING, SIGNAL_PHASE.EXPIRED, SIGNAL_PHASE.INFO].map((p) => signalCardStyle(p).label).join(' ');
    expect(textos).not.toMatch(/compra|venda|buy|sell|iminente|próximo|probabilidade|chance/i);
  });
});

describe('reasonColor', () => {
  it('uma cor por família de motivo (esperando amarelo, piorou laranja, app cinza, info azul)', () => {
    expect(reasonColor(REASON_KIND.WAITING)).toBe('#e3b45a');
    expect(reasonColor(REASON_KIND.WORSE)).toBe('#dd9a4a');
    expect(reasonColor(REASON_KIND.APP)).toBe('#94a3b8');
    expect(reasonColor(REASON_KIND.INFO)).toBe('#60a5fa');
    expect(Object.keys(REASON_COLORS).sort()).toEqual(Object.values(REASON_KIND).sort());
  });
  it('família desconhecida cai no amarelo de "esperando" (nunca undefined)', () => {
    expect(reasonColor('???')).toBe('#e3b45a');
    expect(reasonColor(undefined)).toBe('#e3b45a');
  });
});

describe('reasonColorFor — o motivo de aviso que já passou não pode parecer ativo', () => {
  it('esperando: cor da família do motivo; já passou / só informação: cinza', () => {
    expect(reasonColorFor(signalCardStyle(SIGNAL_PHASE.WAITING), REASON_KIND.WORSE)).toBe('#dd9a4a');
    expect(reasonColorFor(signalCardStyle(SIGNAL_PHASE.WAITING), REASON_KIND.WAITING)).toBe('#e3b45a');
    for (const phase of [SIGNAL_PHASE.EXPIRED, SIGNAL_PHASE.INFO]) {
      expect(reasonColorFor(signalCardStyle(phase), REASON_KIND.WAITING)).toBe('#94a3b8');
      expect(reasonColorFor(signalCardStyle(phase), REASON_KIND.WORSE)).toBe('#94a3b8');
    }
  });
  it('sem estilo: cai na cor da família (nunca lança)', () => {
    expect(reasonColorFor(null, REASON_KIND.WORSE)).toBe('#dd9a4a');
    expect(reasonColorFor(undefined, undefined)).toBe('#e3b45a');
  });
});
