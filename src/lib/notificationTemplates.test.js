// Auditoria do Telegram, Fase 4 (2026-10-02) — testes diretos do módulo
// extraído de src/lib/telegram.js/scripts/adminTelegram.js. A cobertura de
// COMPORTAMENTO (filtros, escape, casos-limite por evento) já existe nos
// describes extensos de telegram.test.js/adminTelegram.test.js, que
// continuam passando inalterados — a prova de que a extração não mudou
// nenhuma palavra já em produção. Este arquivo cobre a MODULARIDADE: cada
// build*Message é testável isoladamente, sem precisar montar `shouldSend`/
// localStorage/credencial — exatamente o ganho que motivou a extração.
import { describe, it, expect } from 'vitest';
import {
  fmtP, realTimeLine, escaparHtml, panelLink,
  buildSignalDetectedMessage, buildVerificationTaskMessage, buildSignalCanceledMessage,
  buildTradeCreatedMessage, buildTp1HitMessage, buildTp2HitMessage, buildStopHitMessage,
  buildInvalidatedMessage, buildTimeStopMessage, buildChopExitMessage,
} from './notificationTemplates';

describe('fmtP', () => {
  it('formata preço sub-1 com 6 casas, >=1 com 4, >=10000 com separador de milhar', () => {
    expect(fmtP(0.0001234)).toBe('0.000123');
    expect(fmtP(1.5)).toBe('1.5000');
    expect(fmtP(12345.678)).toBe('12,345.68');
  });

  it('preço ausente/null devolve travessão, nunca NaN', () => {
    expect(fmtP(null)).toBe('—');
    expect(fmtP(undefined)).toBe('—');
    expect(fmtP(0)).toBe('0.000000');
  });
});

describe('escaparHtml', () => {
  it('escapa <, > e & — nunca repassa marcação crua pro parse_mode HTML do Telegram', () => {
    expect(escaparHtml('Rompeu <b>forte</b> & subiu')).toBe('Rompeu &lt;b&gt;forte&lt;/b&gt; &amp; subiu');
  });

  it('ausente/null devolve string vazia, nunca "null"/"undefined"', () => {
    expect(escaparHtml(null)).toBe('');
    expect(escaparHtml(undefined)).toBe('');
  });
});

describe('realTimeLine', () => {
  it('sem ISO devolve string vazia (omite a linha, nunca "Invalid Date")', () => {
    expect(realTimeLine(null)).toBe('');
    expect(realTimeLine(undefined)).toBe('');
  });

  it('isBound=true rotula "Vela (candle)", isBound=false rotula "Horário real"', () => {
    const iso = '2026-07-16T12:00:00.000Z';
    expect(realTimeLine(iso, true)).toContain('Vela (candle)');
    expect(realTimeLine(iso, false)).toContain('Horário real');
  });
});

describe('panelLink', () => {
  it('monta um link <a> absoluto pro painel público', () => {
    expect(panelLink('/trades')).toBe('<a href="https://sentinel-signals.onrender.com/trades">Abrir no Sentinel</a>');
  });

  // Fase 5 da auditoria do Telegram (2026-10-02), item 5.4 — deep link.
  it('com id, acrescenta ?id= (codificado) — sem id, comportamento idêntico ao de antes', () => {
    expect(panelLink('/trades', 'trade_abc123')).toBe(
      '<a href="https://sentinel-signals.onrender.com/trades?id=trade_abc123">Abrir no Sentinel</a>',
    );
    expect(panelLink('/trades', undefined)).toBe('<a href="https://sentinel-signals.onrender.com/trades">Abrir no Sentinel</a>');
  });
});

// Um caso representativo por build*Message — confirma que cada função
// devolve uma string não-vazia contendo os elementos centrais da anatomia
// fixa (cabeçalho, símbolo, link). Os casos-limite extensos (sem score,
// fonte desconhecida, as 3 classificações de stop, escape de HTML) já são
// cobertos via telegram.test.js/adminTelegram.test.js, que exercitam estas
// mesmas funções indiretamente através de notifyNewSignal/notifyStopHit/etc.
describe('build*Message — uma mensagem completa, não-vazia, por tipo', () => {
  const baseSignal = {
    id: 'sig_abc', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY', source: 'range_filter',
    price_at_signal: 100, reason: 'Teste', context: { score: 82 },
  };
  const baseOp = {
    id: 'trade_xyz', symbol: 'BTCUSDT', side: 'BUY', timeframe: '15m', signal_timeframe: '4h',
    entry_price: 100, initial_stop: 95, current_stop: 95, tp1: 103, tp2: 106,
    score: 82, tp1_hit: false, tp2_hit: false, partial_percent: 50, runner_percent: 50,
  };

  it.each([
    ['buildSignalDetectedMessage', () => buildSignalDetectedMessage(baseSignal)],
    ['buildVerificationTaskMessage', () => buildVerificationTaskMessage(baseSignal)],
    ['buildSignalCanceledMessage', () => buildSignalCanceledMessage({ ...baseSignal, created_date: new Date().toISOString() })],
    ['buildTradeCreatedMessage', () => buildTradeCreatedMessage(baseOp)],
    ['buildTp1HitMessage', () => buildTp1HitMessage(baseOp, 103)],
    ['buildTp2HitMessage', () => buildTp2HitMessage({ ...baseOp, status: 'TP2_HIT', exit_price: 106 }, 106)],
    ['buildStopHitMessage', () => buildStopHitMessage({ ...baseOp, status: 'STOP_HIT' }, 95)],
    ['buildInvalidatedMessage', () => buildInvalidatedMessage({ ...baseOp, status: 'INVALIDATED' }, 98)],
    ['buildTimeStopMessage', () => buildTimeStopMessage({ ...baseOp, status: 'CLOSED' }, 98)],
    ['buildChopExitMessage', () => buildChopExitMessage({ ...baseOp, status: 'CLOSED' }, 98)],
  ])('%s produz texto não-vazio com símbolo e link pro painel', (_name, build) => {
    const text = build();
    expect(typeof text).toBe('string');
    expect(text.length).toBeGreaterThan(0);
    expect(text).toContain('BTC/USDT');
    expect(text).toContain('Abrir no Sentinel');
  });

  describe('buildTradeCreatedMessage — risco do stop, tendência por timeframe e motivos', () => {
    it('mostra risco do stop em %, tendência 1D/4H/1H e os motivos gravados na operação', () => {
      const text = buildTradeCreatedMessage({
        ...baseOp,
        tf_1d_direction: 1, tf_4h_direction: 1, tf_1h_direction: -1,
        signal_reasons: ['MACD hist positivo (+20)', 'EMA tendência bullish (+20)'],
      });
      expect(text).toContain('Stop: $95.0000 (risco 5.00%)');
      expect(text).toContain('Tendência: 1D ▲ · 4H ▲ · 1H ▼');
      expect(text).toContain('Por quê: MACD hist positivo (+20); EMA tendência bullish (+20)');
    });

    it('operação sem esses campos (legada/manual) omite as linhas — nunca "undefined"/"null"/"NaN"', () => {
      const text = buildTradeCreatedMessage({ ...baseOp, tf_1d_direction: null, signal_reasons: undefined });
      expect(text).not.toContain('Tendência');
      expect(text).not.toContain('Por quê');
      expect(text).not.toMatch(/undefined|null|NaN/);
      expect(text).toContain('Stop: $95.0000 (risco 5.00%)');
    });

    it('timeframe sem dado é omitido; direção 0 vira travessão', () => {
      const text = buildTradeCreatedMessage({ ...baseOp, tf_1d_direction: null, tf_4h_direction: 0, tf_1h_direction: 1 });
      expect(text).toContain('Tendência: 4H — · 1H ▲');
      expect(text).not.toContain('1D');
    });

    it('entrada/stop inválidos não geram "risco NaN%"', () => {
      const text = buildTradeCreatedMessage({ ...baseOp, initial_stop: null });
      expect(text).not.toContain('risco');
      expect(text).not.toContain('NaN');
    });

    it('escapa HTML dos motivos (parse_mode HTML do Telegram)', () => {
      const text = buildTradeCreatedMessage({ ...baseOp, signal_reasons: ['RSI <50 & caindo'] });
      expect(text).toContain('RSI &lt;50 &amp; caindo');
    });
  });

  // Fase 5 da auditoria do Telegram (2026-10-02), item 5.4 — cada tipo de
  // mensagem linka pro item EXATO (signal.id ou op.id), não só a rota
  // genérica. `buildVerificationTaskMessage` usa signal.id de propósito
  // (é o id do SignalEvent, não da VerificationTask — ver comentário em
  // notificationTemplates.js).
  it.each([
    ['buildSignalDetectedMessage', () => buildSignalDetectedMessage(baseSignal), 'sig_abc'],
    ['buildVerificationTaskMessage', () => buildVerificationTaskMessage(baseSignal), 'sig_abc'],
    ['buildSignalCanceledMessage', () => buildSignalCanceledMessage({ ...baseSignal, created_date: new Date().toISOString() }), 'sig_abc'],
    ['buildTradeCreatedMessage', () => buildTradeCreatedMessage(baseOp), 'trade_xyz'],
    ['buildTp1HitMessage', () => buildTp1HitMessage(baseOp, 103), 'trade_xyz'],
    ['buildTp2HitMessage', () => buildTp2HitMessage({ ...baseOp, status: 'TP2_HIT', exit_price: 106 }, 106), 'trade_xyz'],
    ['buildStopHitMessage', () => buildStopHitMessage({ ...baseOp, status: 'STOP_HIT' }, 95), 'trade_xyz'],
    ['buildInvalidatedMessage', () => buildInvalidatedMessage({ ...baseOp, status: 'INVALIDATED' }, 98), 'trade_xyz'],
    ['buildTimeStopMessage', () => buildTimeStopMessage({ ...baseOp, status: 'CLOSED' }, 98), 'trade_xyz'],
    ['buildChopExitMessage', () => buildChopExitMessage({ ...baseOp, status: 'CLOSED' }, 98), 'trade_xyz'],
  ])('%s linka pro item exato via ?id=%s', (_name, build, expectedId) => {
    expect(build()).toContain(`?id=${expectedId}`);
  });
});
