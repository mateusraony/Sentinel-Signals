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

// Item 258 — o aviso "Verificação Necessária … aguardando sua revisão manual
// antes de virar operação" fazia parecer que marcar OK/Pular na aba
// Verificação era uma aprovação. Não é: a `VerificationTask` é só lembrete
// (nada no motor lê o status dela) e sinal fora do 4h nunca vira operação.
describe('buildVerificationTaskMessage — nunca sugere que a verificação é uma aprovação (item 258)', () => {
  const sinal = (over = {}) => ({
    id: 'sig_abc', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY', source: 'range_filter',
    price_at_signal: 100, reason: 'Teste', context: { score: 85 }, ...over,
  });
  const PROIBIDAS = [/antes de virar operação/i, /aguardando sua revisão/i, /revisão manual/i, /Necessária/, /revisar e marcar/i];

  it.each([['4h'], ['1h'], ['1d']])('timeframe %s: sem nenhuma frase de aprovação/obrigação', (tf) => {
    const text = buildVerificationTaskMessage(sinal({ timeframe: tf }));
    for (const re of PROIBIDAS) expect(text).not.toMatch(re);
    expect(text).toContain('Sinal para Conferir');
    expect(text).toContain('não altera nenhuma operação');
  });

  it('4h: diz que não precisa aprovar e que a operação depende da confirmação de entrada do app', () => {
    const text = buildVerificationTaskMessage(sinal({ timeframe: '4h' }));
    expect(text).toContain('Você não precisa aprovar nada');
    expect(text).toContain('confirmação de entrada');
  });

  it('fora do 4h (ex.: BTC 1H): diz que é só informação e que não vira operação, com ou sem OK', () => {
    const text = buildVerificationTaskMessage(sinal({ timeframe: '1h' }));
    expect(text).toContain('1H');
    expect(text).toContain('só informação');
    expect(text).toContain('não vira operação');
    expect(text).not.toContain('Você não precisa aprovar nada');
  });

  it('SMC 1H com a cascata desligada no ativo (ativo conhecido): só informação, sem prometer confirmação', () => {
    const text = buildVerificationTaskMessage(sinal({ timeframe: '1h', source: 'smc_structure' }), { smc_enabled: false });
    expect(text).toContain('não vira operação');
    expect(text).not.toContain('Você não precisa aprovar nada');
    const detected = buildSignalDetectedMessage(sinal({ timeframe: '1h', source: 'smc_structure' }), { smc_enabled: false });
    expect(detected).toContain('ℹ️ Situação: Só informação');
  });

  it('SMC 1H PODE virar operação (cascata 1H→5m): não afirma "não vira operação"', () => {
    const text = buildVerificationTaskMessage(sinal({ timeframe: '1h', source: 'smc_structure' }));
    expect(text).toContain('Você não precisa aprovar nada');
    expect(text).toContain('1H→5m');
    expect(text).not.toContain('não vira operação');
    for (const re of PROIBIDAS) expect(text).not.toMatch(re);
  });
});


// Item 276 (PR-A) — "Situação"/"Próximo passo" do sinal detectado diziam
// "aguardando confirmação de entrada" para TODA fonte, inclusive MACD/EMA/RSI
// e Range Filter 1h/1d, que nunca viram operação. Mesmo predicado do painel
// (`isConfirmationEligible`, src/lib/signalStatus.js) — fonte única.
describe('buildSignalDetectedMessage — só promete confirmação para o que pode virar operação (item 276)', () => {
  const sinal = (over = {}) => ({
    id: 'sig_abc', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY', source: 'range_filter',
    price_at_signal: 100, reason: 'Teste', context: { score: 85 }, strength: 'strong', ...over,
  });

  it.each([
    ['range_filter', '4h'],
    ['smc_structure', '1h'],
  ])('%s %s: aguardando confirmação de entrada pelo motor', (source, timeframe) => {
    const text = buildSignalDetectedMessage(sinal({ source, timeframe }));
    expect(text).toContain('aguardando confirmação de entrada');
    expect(text).not.toContain('Só informação');
  });

  it.each([
    ['macd', '4h'], ['ema_cross', '4h'], ['rsi', '4h'], ['range_filter', '1h'], ['range_filter', '1d'],
  ])('%s %s: só informação — nunca "aguardando confirmação"', (source, timeframe) => {
    const text = buildSignalDetectedMessage(sinal({ source, timeframe }));
    expect(text).not.toMatch(/aguardando confirmação/i);
    expect(text).not.toMatch(/aguardar a confirmação/i);
    expect(text).toContain('ℹ️ Situação: Só informação');
    expect(text).toContain('Próximo passo: nenhum');
  });
});

// Item 276 (E1) — padrão "1 emoji = 1 significado" no Telegram (pedido do
// usuário: aprimorar os emojis, não removê-los). 📈/📉 ficam reservados para
// movimento de preço; lado do sinal = 🟢/🔴 (mesmo de docs/notification-
// vocabulary.md); 💰 só "Stop Travou Lucro"; ➡️ sai de "Próximo passo" (👉);
// 🛡️ = stop no preço de entrada ou melhor; 🧩 = concordância de regras.
describe('Telegram — vocabulário de emojis E1 (item 276)', () => {
  const sinal = {
    id: 'sig_abc', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY', source: 'range_filter',
    price_at_signal: 100, reason: 'Teste', context: { score: 85 }, strength: 'strong',
    created_date: new Date().toISOString(),
  };
  const op = {
    id: 'trade_xyz', symbol: 'BTCUSDT', side: 'BUY', timeframe: '15m', signal_timeframe: '4h',
    entry_price: 100, initial_stop: 95, current_stop: 95, tp1: 103, tp2: 106,
    score: 85, tp1_hit: false, tp2_hit: false, partial_percent: 50, runner_percent: 50,
  };
  const todas = () => [
    buildSignalDetectedMessage(sinal),
    buildSignalDetectedMessage({ ...sinal, signal_type: 'SELL' }),
    buildVerificationTaskMessage(sinal),
    buildSignalCanceledMessage(sinal),
    buildTradeCreatedMessage(op),
    buildTp1HitMessage(op, 103),
    buildTp2HitMessage({ ...op, status: 'TP2_HIT', exit_price: 106 }, 106),
    buildStopHitMessage({ ...op, status: 'STOP_HIT' }, 95),
    buildInvalidatedMessage({ ...op, status: 'INVALIDATED' }, 98),
    buildTimeStopMessage({ ...op, status: 'CLOSED' }, 98),
    buildChopExitMessage({ ...op, status: 'CLOSED' }, 98),
  ];

  it('lado do sinal é 🟢 COMPRA / 🔴 VENDA — 📈/📉 nunca significam lado', () => {
    expect(buildSignalDetectedMessage(sinal)).toContain('🟢 COMPRA');
    expect(buildSignalDetectedMessage({ ...sinal, signal_type: 'SELL' })).toContain('🔴 VENDA');
    for (const text of todas()) expect(text).not.toMatch(/📈|📉/);
  });

  it('a mensagem de verificação não repete o lado com dois emojis', () => {
    const text = buildVerificationTaskMessage(sinal);
    expect(text.match(/🟢/g)).toHaveLength(1);
  });

  it('"Próximo passo" usa 👉 e ➡️ sai de todas as mensagens', () => {
    for (const text of todas()) {
      expect(text).not.toContain('➡️');
      expect(text).toContain('👉 Próximo passo');
    }
  });

  it('preço do sinal usa 🏷️; 💰 não aparece fora de "Stop Travou Lucro"', () => {
    expect(buildSignalDetectedMessage(sinal)).toContain('🏷️ Preço no sinal');
    for (const text of todas()) expect(text).not.toContain('💰');
  });

  it('score vira 🧩 regras alinhadas, com aviso de que não é chance de acerto — sem 💪/📊 de força', () => {
    const text = buildSignalDetectedMessage(sinal);
    expect(text).toContain('🧩 Regras alinhadas: 85/100');
    expect(text).toContain('não é chance de acerto');
    for (const t of todas()) expect(t).not.toMatch(/💪|🔹|📊 (Score|Força)/);
  });

  it('ℹ️ só aparece para aviso que nunca abre operação; ⏳ só para aguardando entrada', () => {
    const smcVerif = buildVerificationTaskMessage({ ...sinal, source: 'smc_structure', timeframe: '1h' });
    expect(smcVerif).not.toContain('ℹ️');
    expect(smcVerif).toContain('⏳ Situação');
    const ambiguo = buildStopHitMessage({ ...op, status: 'STOP_HIT', exit_ambiguous: true }, 95);
    expect(ambiguo).not.toContain('ℹ️');
    for (const text of [...todas(), smcVerif, ambiguo]) {
      expect(text).not.toMatch(/⏳ (Duração|Esperou)/);
      if (text.includes('ℹ️')) expect(text).toMatch(/ℹ️ Situação: (Só informação|sinal de alta prioridade de)/);
    }
    expect(buildVerificationTaskMessage({ ...sinal, timeframe: '1h' })).toContain('ℹ️ Situação');
  });

  it('sinal sem score numérico (MACD) mantém a força em palavra, sem virar chance', () => {
    const text = buildSignalDetectedMessage({ ...sinal, source: 'macd', context: {}, strength: 'strong' });
    expect(text).toContain('🧩 Regras alinhadas: concordância forte (não é chance de acerto)');
  });

  it('entrada diz que a operação é virtual e que nenhuma ordem é enviada', () => {
    const text = buildTradeCreatedMessage(op);
    expect(text).toContain('virtual');
    expect(text).toContain('nenhuma ordem é enviada à corretora');
  });

  it('TP1 com runner: 🛡️ stop no preço de entrada ou melhor, com ressalva de custos — sem 🔄', () => {
    const text = buildTp1HitMessage(op, 103);
    expect(text).toContain('🛡️ Stop protegido: no preço de entrada');
    expect(text).toContain('ou melhor');
    expect(text).toContain('exceto taxas');
    expect(text).not.toContain('🔄');
  });
});

// Item 276 (2ª revisão) — o motivo `trend_reversed` da cascata SMC vem da
// estrutura de 1 hora, não da linha de tendência de 4 horas.
describe('buildSignalCanceledMessage — trend_reversed fala da cascata certa (item 276)', () => {
  const base = {
    id: 'sig_abc', symbol: 'BTCUSDT', signal_type: 'BUY', price_at_signal: 100, reason: 'Teste',
    context: { score: 80 }, created_date: new Date().toISOString(), last_rejection_reason: 'trend_reversed',
  };
  it('SMC 1h cita o gráfico de 1 hora, nunca o de 4 horas', () => {
    const text = buildSignalCanceledMessage({ ...base, source: 'smc_structure', timeframe: '1h' });
    expect(text).toContain('estrutura do gráfico de 1 hora (SMC)');
    expect(text).not.toContain('gráfico de 4 horas');
  });
  it('Range Filter 4h continua citando a linha de tendência de 4 horas', () => {
    const text = buildSignalCanceledMessage({ ...base, source: 'range_filter', timeframe: '4h' });
    expect(text).toContain('linha de tendência do gráfico de 4 horas');
  });
});

// Item 278 (review do PR-C): a simulação manual ("🧪 Simular entrada" no
// painel) mandava ao Telegram a mesma "Entrada Confirmada" de uma entrada do
// motor. Agora vem marcada.
describe('buildTradeCreatedMessage — simulação manual marcada (item 278)', () => {
  const op = { id: 'trade_manual_s1', symbol: 'BTCUSDT', side: 'BUY', timeframe: '15m', entry_price: 100, initial_stop: 95, tp1: 107.5, tp2: 115 };
  it('operação manual abre com 🧪 e diz que pulou os filtros do motor', () => {
    const msg = buildTradeCreatedMessage({ ...op, source: 'manual' });
    expect(msg).toMatch(/^🧪 <b>Simulação manual<\/b>/);
    expect(msg).toMatch(/sem os filtros do motor/);
  });
  it('operação do motor não ganha a marca', () => {
    expect(buildTradeCreatedMessage(op)).not.toMatch(/🧪/);
  });

  it('REGRESSÃO (review do PR-C): toda mensagem de gestão da simulação também vem marcada', () => {
    const manual = { ...op, source: 'manual', tp1_hit: true, current_stop: 100, exit_price: 95, status: 'STOP_HIT' };
    for (const build of [buildTp1HitMessage, buildTp2HitMessage, buildStopHitMessage, buildInvalidatedMessage, buildTimeStopMessage, buildChopExitMessage]) {
      expect(build(manual, 101)).toMatch(/^🧪 <b>Simulação manual<\/b>/);
      expect(build({ ...manual, source: undefined }, 101)).not.toMatch(/🧪/);
    }
  });
});
