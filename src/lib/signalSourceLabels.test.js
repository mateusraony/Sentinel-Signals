// Auditoria do Telegram, Fase 4 (2026-10-02) — achado do especialista em
// testes do conselho de revisão: este módulo (fonte única de rótulo de
// origem desde a Fase 2 item 2.11) nunca teve arquivo de teste próprio,
// só era exercitado indiretamente via telegram.js/adminTelegram.js/
// Alerts.jsx. Agora sustenta UI também (SignalToast/SignalAlertBanner
// continuam RF-only por construção e não precisam dele, mas Alerts.jsx já
// usa, e um componente futuro pode passar a usar) — vale ter cobertura
// direta, simétrica à de notificationVocabulary.test.js.
import { describe, it, expect } from 'vitest';
import { SIGNAL_SOURCES, shortSourceLabel, longSourceLabel } from './signalSourceLabels';

describe('shortSourceLabel', () => {
  it('devolve a sigla curta pra cada fonte conhecida', () => {
    expect(shortSourceLabel('range_filter')).toBe('RF');
    expect(shortSourceLabel('smc_structure')).toBe('SMC');
    expect(shortSourceLabel('macd')).toBe('MACD');
    expect(shortSourceLabel('ema_cross')).toBe('EMA');
    expect(shortSourceLabel('rsi')).toBe('RSI');
  });

  it('fonte desconhecida/ausente devolve "Outra fonte", nunca inventa um nome', () => {
    expect(shortSourceLabel('algo_novo_que_ainda_nao_existe')).toBe('Outra fonte');
    expect(shortSourceLabel(undefined)).toBe('Outra fonte');
    expect(shortSourceLabel(null)).toBe('Outra fonte');
  });
});

describe('longSourceLabel', () => {
  it('devolve o nome longo pra cada fonte conhecida', () => {
    expect(longSourceLabel('range_filter')).toBe('Range Filter');
    expect(longSourceLabel('smc_structure')).toBe('SMC Structure');
    expect(longSourceLabel('confluence')).toBe('Confluência');
  });

  it('fonte desconhecida devolve o próprio valor cru (nunca "Outra fonte" aqui — Alerts.jsx já tratava assim antes)', () => {
    expect(longSourceLabel('algo_novo_que_ainda_nao_existe')).toBe('algo_novo_que_ainda_nao_existe');
  });
});

// Codex review (achado recorrente neste plano): origem SELL combinada com
// fonte desconhecida é o caso mais arriscado de mascarar um bug no outro —
// confirma que o rótulo de fonte independe do lado do sinal (BUY/SELL não é
// parâmetro desta função, por design).
describe('SIGNAL_SOURCES — consistência', () => {
  it('toda entrada tem short, long e tooltip não-vazios', () => {
    for (const [source, entry] of Object.entries(SIGNAL_SOURCES)) {
      expect(entry.short, `${source}.short`).toBeTruthy();
      expect(entry.long, `${source}.long`).toBeTruthy();
      expect(entry.tooltip, `${source}.tooltip`).toBeTruthy();
    }
  });
});
