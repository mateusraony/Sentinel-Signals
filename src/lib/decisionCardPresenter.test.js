// Presenter do Decision Card (Fase 1, passo 1 — sem UI). O que importa aqui:
// nada é recalculado, dado ausente vira null/UNKNOWN (nunca favorável), erro
// de carregamento nunca vira "sem operação", e o presenter fica puro. Os
// campos `op.invalidates_if` e `op.data_status` são ignorados de propósito.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  buildDecisionCard, PROBABILITY_NOT_CALIBRATED, SCORE_NOTE,
} from './decisionCardPresenter.js';

const NOW = Date.parse('2026-10-03T18:00:00.000Z');
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const iso = (msAgo) => new Date(NOW - msAgo).toISOString();

const asset = (o = {}) => ({
  id: 'a1', display_name: 'Bitcoin', symbol: 'BTCUSDT', exchange: 'binance',
  is_active: true, last_scan_at: iso(5 * MIN), ...o,
});
const signal = (o = {}) => ({
  id: 's1', asset_id: 'a1', symbol: 'BTCUSDT', timeframe: '4h', signal_type: 'BUY',
  source: 'range_filter', created_date: iso(30 * MIN), reason: 'BTCUSDT — BUY 4H [Forte]',
  context: {
    score: 82, reasons: ['MACD hist positivo (+20)', 'EMA tendência bullish (+20)'],
    tf_1d_direction: 1, tf_4h_direction: 1, tf_1h_direction: 1,
  },
  ...o,
});
const op = (o = {}) => ({
  id: 'o1', asset_id: 'a1', side: 'BUY', timeframe: '15m', signal_timeframe: '4h',
  status: 'RUNNER_ACTIVE', entry_price: 100, initial_stop: 95, current_stop: 100,
  tp1: 105, tp2: 110, rr_at_entry: 1.5, score: 82, cascade: '4h_15m',
  created_date: iso(2 * HOUR), tf_1d_direction: 1, tf_4h_direction: 1, tf_1h_direction: -1,
  signal_reasons: ['Follow-through confirmado (+25)'],
  ...o,
});
const st = (tf, o = {}) => ({
  asset_id: 'a1', timeframe: tf, rf_direction: 1, rsi_zone: 'neutral',
  macd_histogram: 0.5, trend_ema: 'bullish', last_candle_time: iso(10 * MIN), ...o,
});
const build = (o = {}) => buildDecisionCard({
  asset: asset(), assetStates: [], signals: [], tradeOps: [], now: NOW, ...o,
});

describe('estado — fail-closed', () => {
  it('sem sinal nem operação (dados carregados): estado "none", sem blocos de decisão', () => {
    const card = build();
    expect(card.state.kind).toBe('none');
    expect(card.why).toBeNull();
    expect(card.levels).toBeNull();
    expect(card.score).toBeNull();
    expect(card.consStatus).toBeNull();
  });

  it('operações NÃO carregaram + existe sinal: nunca afirma "aguardando confirmação"', () => {
    const card = build({ signals: [signal()], tradeOpsUnavailable: true });
    expect(card.state.kind).toBe('unavailable');
    expect(card.state.label).toMatch(/Não foi possível carregar as operações/);
    expect(card.state.label).not.toMatch(/Aguardando/);
    expect(card.action).toBeNull();
    expect(card.why).toBeNull();
    expect(card.score).toBeNull();
    expect(card.unavailable.tradeOps).toBe(true);
  });

  it('sinais NÃO carregaram e não há operação: "não foi possível carregar", nunca "sem sinal"', () => {
    const card = build({ signalsUnavailable: true });
    expect(card.state.kind).toBe('unavailable');
    expect(card.state.label).toMatch(/sinais/);
    expect(card.state.label).not.toMatch(/Sem sinal/);
  });

  it('REGRESSÃO (Codex #461): operações ativas ainda carregando + sinal existente → "loading", nunca "aguardando"', () => {
    const card = build({ signals: [signal()], tradeOpsLoading: true });
    expect(card.state.kind).toBe('loading');
    expect(card.state.label).toBe('Carregando operações…');
    expect(card.state.label).not.toMatch(/Aguardando/);
    expect(card.action).toBeNull();
    expect(card.why).toBeNull();
    expect(card.score).toBeNull();
  });

  it('carregando + sem nada: também "loading", nunca "Sem sinal nem operação"', () => {
    const card = build({ tradeOpsLoading: true });
    expect(card.state.kind).toBe('loading');
  });

  it('operação já conhecida vence o "carregando" (não esconde stop/alvos por causa do refetch)', () => {
    const card = build({ tradeOps: [op()], tradeOpsLoading: true });
    expect(card.state.kind).toBe('active_op');
  });

  it('erro vence o "carregando"', () => {
    const card = build({ signals: [signal()], tradeOpsLoading: true, tradeOpsUnavailable: true });
    expect(card.state.kind).toBe('unavailable');
  });

  it('operação vinda do cache continua válida mesmo com a query de operações em falha', () => {
    const card = build({ tradeOps: [op()], tradeOpsUnavailable: true });
    expect(card.state.kind).toBe('active_op');
  });

  it('só dados do próprio ativo entram (outro asset_id é ignorado)', () => {
    const card = build({ signals: [signal({ asset_id: 'outro' })], tradeOps: [op({ asset_id: 'outro' })] });
    expect(card.state.kind).toBe('none');
  });
});

describe('estado — sinal sem operação', () => {
  it('sinal 4h dentro da janela: rótulo derivado "Aguardando confirmação · BUY", sem níveis', () => {
    const card = build({ signals: [signal()] });
    expect(card.state.label).toBe('Aguardando confirmação · BUY');
    expect(card.levels).toBeNull();
    expect(card.why.invalidation.kind).toBe('not_defined');
    expect(card.why.thesis).toBe('BTCUSDT — BUY 4H [Forte]');
    expect(card.why.pros).toEqual(['MACD hist positivo (+20)', 'EMA tendência bullish (+20)']);
    expect(card.score).toEqual({ value: 82, note: SCORE_NOTE });
    expect(card.score.note).toMatch(/não é probabilidade/);
  });

  it('sinal de 1h é só informação (nunca "aguardando confirmação")', () => {
    const card = build({ signals: [signal({ timeframe: '1h' })] });
    expect(card.state.label).toMatch(/^Só informação/);
    expect(card.state.label).not.toMatch(/Aguardando/);
  });

  it('sinal 4h além do prazo de 4h: "Já passou"', () => {
    const card = build({ signals: [signal({ created_date: iso(5 * HOUR) })] });
    expect(card.state.label).toMatch(/^Já passou/);
  });

  it('REGRESSÃO (Codex, PR #460): evento informativo 4h (MACD/EMA/RSI) nunca é "aguardando confirmação"', () => {
    for (const source of ['macd', 'ema_cross', 'rsi']) {
      const card = build({ signals: [signal({ source, timeframe: '4h' })] });
      expect(card.state.label).toMatch(/^Só informação/);
      expect(card.state.label).not.toMatch(/Aguardando/);
      expect(card.action.headline).toBe('Só informação');
      expect(card.action.why).not.toMatch(/vendo se vale abrir/);
    }
  });

  it('REGRESSÃO (Codex, PR #460): evento informativo mais novo não esconde um aviso de entrada pendente', () => {
    const entrada = signal({ id: 'rf', source: 'range_filter', created_date: iso(2 * HOUR) });
    const info = signal({ id: 'macd', source: 'macd', signal_type: 'SELL', created_date: iso(5 * MIN) });
    const card = build({ signals: [info, entrada] });
    expect(card.state.label).toBe('Aguardando confirmação · BUY');
    expect(card.state.side).toBe('BUY');
  });

  it('cascata SMC (smc_structure 1h) é candidata de entrada mas segue a regra da janela: 1h = só informação', () => {
    const card = build({ signals: [signal({ source: 'smc_structure', timeframe: '1h' })] });
    expect(card.state.label).toMatch(/^Só informação/);
  });

  it('motivo de rejeição WORSE não entra no CONTRA de evento informativo', () => {
    const card = build({ signals: [signal({ source: 'macd', context: {}, last_rejection_reason: 'regime_rejected' })] });
    expect(card.why.cons.map((c) => c.code)).not.toContain('rejection_worse');
  });

  it('escolhe o sinal mais recente e não muta a lista recebida', () => {
    const velho = signal({ id: 'velho', created_date: iso(3 * HOUR), signal_type: 'SELL' });
    const novo = signal({ id: 'novo', created_date: iso(10 * MIN) });
    const lista = [velho, novo];
    const card = build({ signals: lista });
    expect(card.state.side).toBe('BUY');
    expect(lista[0].id).toBe('velho');
  });

  it('sinal sem lado e sem score: lado null, score null — nunca inventa', () => {
    const card = build({ signals: [signal({ signal_type: undefined, context: {} })] });
    expect(card.state.side).toBeNull();
    expect(card.score).toBeNull();
    expect(card.why.pros).toEqual([]);
    expect(card.why.multiTf.every((m) => m.direction === null)).toBe(true);
  });
});

describe('operação ativa — níveis e invalidação', () => {
  it('runner ativo BUY: níveis persistidos, R:R gravado, stop em breakeven', () => {
    const card = build({ tradeOps: [op()] });
    expect(card.state.label).toBe('Runner ativo (TP1 atingido)');
    expect(card.levels).toMatchObject({ entry: 100, initialStop: 95, stop: 100, tp1: 105, tp2: 110, rr: 1.5, stopPosture: 'breakeven' });
    expect(card.why.invalidation).toMatchObject({ kind: 'stop', stop: 100 });
  });

  it('SELL com stop além da entrada: stop protegido ("locked")', () => {
    const card = build({ tradeOps: [op({ side: 'SELL', entry_price: 100, current_stop: 97, initial_stop: 105, tp1: 95, tp2: 90 })] });
    expect(card.levels.stopPosture).toBe('locked');
  });

  it('operação sem TP2 e sem R:R: campos null (UNKNOWN), nunca 0', () => {
    const card = build({ tradeOps: [op({ tp2: undefined, rr_at_entry: undefined })] });
    expect(card.levels.tp2).toBeNull();
    expect(card.levels.rr).toBeNull();
  });

  it('operação que fecha 100% no TP1 (status terminal) não é mais a operação ativa', () => {
    const card = build({ tradeOps: [op({ status: 'CLOSED', partial_percent: 100 })] });
    expect(card.state.kind).toBe('none');
    expect(card.levels).toBeNull();
  });

  it('operação terminal + sinal vivo: o estado vem do sinal', () => {
    const card = build({ tradeOps: [op({ status: 'STOP_HIT' })], signals: [signal()] });
    expect(card.state.kind).toBe('waiting');
  });

  it('várias ativas no mesmo ativo (inconsistência): usa a mais recente, sem lançar', () => {
    const card = build({ tradeOps: [op({ id: 'antiga', created_date: iso(9 * HOUR), side: 'SELL' }), op({ id: 'nova' })] });
    expect(card.state.side).toBe('BUY');
  });

  it('IGNORA op.invalidates_if (texto fixo que não reflete a regra real)', () => {
    const card = build({ tradeOps: [op({ invalidates_if: 'TEXTO-FIXO-ANTIGO' })] });
    expect(JSON.stringify(card)).not.toContain('TEXTO-FIXO-ANTIGO');
  });

  it('tese da operação é tradução da cascata gravada; sem cascata, null', () => {
    expect(build({ tradeOps: [op()] }).why.thesis).toMatch(/estrutura 4h com confirmação 15m/);
    expect(build({ tradeOps: [op({ cascade: undefined })] }).why.thesis).toBeNull();
  });

  it('score da operação usa score; cai em entry_score; sem nenhum, null', () => {
    expect(build({ tradeOps: [op({ score: undefined, entry_score: 77 })] }).score.value).toBe(77);
    expect(build({ tradeOps: [op({ score: undefined })] }).score).toBeNull();
  });
});

describe('qualidade dos dados — frescor real, nunca "LIVE" fixo', () => {
  it('31 min sem scan = stale; 29 min = ok', () => {
    expect(build({ asset: asset({ last_scan_at: iso(31 * MIN) }) }).quality.status).toBe('stale');
    expect(build({ asset: asset({ last_scan_at: iso(29 * MIN) }) }).quality.status).toBe('ok');
  });

  it('erro persistente de leitura = error', () => {
    const card = build({ asset: asset({ scan_error_since: iso(40 * MIN) }) });
    expect(card.quality.status).toBe('error');
    expect(card.quality.label).toBe('Falha persistente de leitura');
  });

  it('sem last_scan_at: UNKNOWN, nunca "ok"; ativo desligado: inactive', () => {
    expect(build({ asset: asset({ last_scan_at: undefined }) }).quality.status).toBe('unknown');
    expect(build({ asset: asset({ is_active: false }) }).quality.status).toBe('inactive');
  });

  it('sem "now" válido não há como julgar frescor: unknown', () => {
    expect(buildDecisionCard({ asset: asset(), now: undefined }).quality.status).toBe('unknown');
  });

  it('IGNORA op.data_status (gravado fixo como LIVE): ativo defasado continua stale', () => {
    const card = build({ asset: asset({ last_scan_at: iso(90 * MIN) }), tradeOps: [op({ data_status: 'LIVE' })] });
    expect(card.quality.status).toBe('stale');
  });

  it('fonte desconhecida = null; fonte gravada é repassada; candle vem do AssetState do TF do sinal', () => {
    const semFonte = build({ signals: [signal()], assetStates: [st('4h', { last_candle_time: '2026-10-03T16:00:00.000Z' })] });
    expect(semFonte.quality.source).toEqual({ marketSource: null, dataExchange: null, executor: null });
    expect(semFonte.quality.lastCandleTime).toBe('2026-10-03T16:00:00.000Z');
    const comFonte = build({ tradeOps: [op({ market_source: 'spot', data_exchange: 'binance', executor: 'cron' })] });
    expect(comFonte.quality.source).toEqual({ marketSource: 'spot', dataExchange: 'binance', executor: 'cron' });
  });

  it('último fechamento vem do AssetState do TF do sinal; ausente ou inválido = null (nunca 0)', () => {
    const ok = build({ signals: [signal()], assetStates: [st('4h', { last_close: 68200 })] });
    expect(ok.quality.lastClose).toBe(68200);
    expect(build({ signals: [signal()], assetStates: [st('4h', { last_close: undefined })] }).quality.lastClose).toBeNull();
    expect(build({ signals: [signal()], assetStates: [st('4h', { last_close: 0 })] }).quality.lastClose).toBeNull();
    expect(build({ signals: [signal()], assetStates: [st('1h', { last_close: 5 })] }).quality.lastClose).toBeNull();
  });

  it('snapshot defasado: mostra evaluated_at em vez de fingir que é de agora', () => {
    const snap = { reason_code: 'regime_rejected', data_status: 'LIVE', evaluated_at: iso(6 * HOUR), facts: { adx: 18, adx_min: 22 } };
    const card = build({ signals: [signal({ last_rejection_reason: 'regime_rejected', decision_snapshot: snap })] });
    expect(card.quality.evaluatedAt).toBe(snap.evaluated_at);
  });
});

describe('CONTRA — derivação determinística, sem recalcular', () => {
  it('nenhuma regra casa: lista vazia e consStatus "not_recorded" (nunca "nenhum contra")', () => {
    const card = build({ signals: [signal()], assetStates: [st('4h')] });
    expect(card.why.cons).toEqual([]);
    expect(card.consStatus).toBe('not_recorded');
  });

  it('alinhamento against_trend gravado no nível de cima do SignalEvent', () => {
    const card = build({ signals: [signal({ alignment: 'against_trend' })] });
    expect(card.why.cons.map((c) => c.code)).toContain('against_trend');
    expect(card.consStatus).toBe('derived');
  });

  it('REGRESSÃO (Codex, PR #460): `alignment` dentro de context NÃO é onde o motor grava — não conta', () => {
    const card = build({ signals: [signal({ context: { ...signal().context, alignment: 'against_trend' } })] });
    expect(card.why.cons.map((c) => c.code)).not.toContain('against_trend');
  });

  it('1D contrário: BUY com 1D baixa e SELL com 1D alta; escopo "signal" vs "entry"', () => {
    const buy = build({ signals: [signal({ context: { tf_1d_direction: -1 } })] });
    expect(buy.why.cons).toEqual([expect.objectContaining({ code: 'tf_1d_against', scope: 'signal' })]);
    const sellOp = build({ tradeOps: [op({ side: 'SELL', tf_1d_direction: 1 })] });
    expect(sellOp.why.cons).toEqual([expect.objectContaining({ code: 'tf_1d_against', scope: 'entry' })]);
    expect(build({ signals: [signal({ context: { tf_1d_direction: null } })] }).why.cons).toEqual([]);
  });

  it('BUY: RSI sobrecomprado, MACD negativo e EMA baixista no TF do sinal, rotulados "agora"', () => {
    const card = build({
      signals: [signal({ context: {} })],
      assetStates: [st('4h', { rsi_zone: 'overbought', macd_histogram: -1, trend_ema: 'bearish' })],
    });
    expect(card.why.cons.map((c) => c.code)).toEqual(['rsi_extreme', 'macd_against', 'ema_against']);
    expect(card.why.cons.every((c) => c.scope === 'now')).toBe(true);
  });

  it('SELL: RSI sobrevendido, MACD positivo e EMA altista', () => {
    const card = build({
      signals: [signal({ signal_type: 'SELL', context: {} })],
      assetStates: [st('4h', { rsi_zone: 'oversold', macd_histogram: 1, trend_ema: 'bullish' })],
    });
    expect(card.why.cons.map((c) => c.code)).toEqual(['rsi_extreme', 'macd_against', 'ema_against']);
  });

  it('textos do "contra" em linguagem simples (sigla só entre parênteses, depois da explicação)', () => {
    const buy = build({
      signals: [signal({ alignment: 'against_trend', context: { tf_1d_direction: -1 } })],
      assetStates: [st('4h', { rsi_zone: 'overbought', macd_histogram: -1, trend_ema: 'bearish' })],
    });
    expect(buy.why.cons.map((c) => c.text)).toEqual([
      'Vai contra a tendência maior (os gráficos de prazo maior apontam para o outro lado)',
      'O gráfico de 1 dia aponta para o lado oposto',
      'O preço já subiu muito (RSI sobrecomprado) agora no 4h',
      'O impulso do preço (MACD) está contra agora no 4h',
      'A tendência das médias (EMA) está contra agora no 4h',
    ]);
    const sell = build({
      signals: [signal({ signal_type: 'SELL', context: {} })],
      assetStates: [st('4h', { rsi_zone: 'oversold' })],
    });
    expect(sell.why.cons[0].text).toBe('O preço já caiu muito (RSI sobrevendido) agora no 4h');
  });

  it('invalidação: textos simples (stop atual / ainda não definido)', () => {
    expect(build({ tradeOps: [op()] }).why.invalidation.text).toBe('Stop atual da operação');
    expect(build({ signals: [signal()] }).why.invalidation.text).toBe('Ainda não definido — a operação ainda não existe');
  });

  it('estado a favor, neutro ou MACD exatamente 0 não geram "contra"', () => {
    const card = build({
      signals: [signal({ context: {} })],
      assetStates: [st('4h', { rsi_zone: 'oversold', macd_histogram: 0, trend_ema: 'neutral' })],
    });
    expect(card.why.cons).toEqual([]);
  });

  it('REGRESSÃO (Codex, PR #460): operação legada sem signal_timeframe usa 4h (não o 15m de confirmação)', () => {
    const card = build({
      tradeOps: [op({ signal_timeframe: undefined, timeframe: '15m' })],
      assetStates: [st('4h', { rsi_zone: 'overbought', last_candle_time: '2026-10-03T16:00:00.000Z' }), st('15m', { rsi_zone: 'neutral' })],
    });
    expect(card.state.timeframe).toBe('4h');
    expect(card.why.cons.map((c) => c.code)).toContain('rsi_extreme');
    expect(card.quality.lastCandleTime).toBe('2026-10-03T16:00:00.000Z');
  });

  it('operação da cascata SMC (signal_timeframe 1h) usa o AssetState de 1h', () => {
    const card = build({
      tradeOps: [op({ signal_timeframe: '1h', timeframe: '5m', cascade: '1h_5m' })],
      assetStates: [st('1h', { rsi_zone: 'overbought' }), st('4h', { rsi_zone: 'neutral' })],
    });
    expect(card.state.timeframe).toBe('1h');
    expect(card.why.cons.map((c) => c.code)).toContain('rsi_extreme');
  });

  it('usa o AssetState do TF do SINAL (4h), não o do timeframe de execução da operação (15m)', () => {
    const card = build({
      tradeOps: [op({ tf_1d_direction: 1 })],
      assetStates: [st('4h', { rsi_zone: 'overbought' }), st('15m', { rsi_zone: 'neutral' })],
    });
    expect(card.why.cons.map((c) => c.code)).toContain('rsi_extreme');
  });

  it('levels.opId identifica a operação mostrada (a mais nova entre várias ativas)', () => {
    const older = op({ id: 'op-velha', created_date: iso(5 * HOUR) });
    const newer = op({ id: 'op-nova', created_date: iso(1 * HOUR) });
    expect(build({ tradeOps: [older, newer] }).levels.opId).toBe('op-nova');
    expect(build({ signals: [signal()] }).levels).toBeNull();
  });

  it('motivo de rejeição "WORSE" entra com a frase e a evidência numérica; "WAITING" não entra', () => {
    const snap = { reason_code: 'regime_rejected', data_status: 'LIVE', evaluated_at: iso(HOUR), facts: { adx: 18, adx_min: 22 } };
    const worse = build({ signals: [signal({ context: {}, last_rejection_reason: 'regime_rejected', decision_snapshot: snap })] });
    const item = worse.why.cons.find((c) => c.code === 'rejection_worse');
    expect(item.text.length).toBeGreaterThan(10);
    expect(item.evidence).toMatch(/ADX/);
    const waiting = build({ signals: [signal({ context: {}, last_rejection_reason: 'no_trigger' })] });
    expect(waiting.why.cons).toEqual([]);
  });
});

describe('multi-timeframe', () => {
  it('operação: direções congeladas na entrada; sinal: do contexto', () => {
    const o = build({ tradeOps: [op()] }).why.multiTf;
    expect(o).toEqual([
      { tf: '1d', direction: 1, source: 'entry' },
      { tf: '4h', direction: 1, source: 'entry' },
      { tf: '1h', direction: -1, source: 'entry' },
    ]);
    expect(build({ signals: [signal()] }).why.multiTf.every((m) => m.source === 'signal')).toBe(true);
  });

  it('sem dado congelado cai no AssetState atual ("now"); sem nenhum, null', () => {
    const card = build({
      signals: [signal({ context: { tf_1d_direction: 1 } })],
      assetStates: [st('4h', { rf_direction: -1 })],
    });
    const byTf = Object.fromEntries(card.why.multiTf.map((m) => [m.tf, m]));
    expect(byTf['1d']).toEqual({ tf: '1d', direction: 1, source: 'signal' });
    expect(byTf['4h']).toEqual({ tf: '4h', direction: -1, source: 'now' });
    expect(byTf['1h']).toEqual({ tf: '1h', direction: null, source: null });
  });
});

describe('probabilidade e funding — slots honestos', () => {
  it('probabilidade nunca é preenchida: slot indisponível e congelado', () => {
    expect(build({ signals: [signal()] }).probability).toEqual({ available: false, reason: 'not_calibrated' });
    expect(Object.isFrozen(PROBABILITY_NOT_CALIBRATED)).toBe(true);
  });

  it('funding: indisponível por padrão; só vira disponível se a UI injetar o dado', () => {
    expect(build().tech.funding).toEqual({ available: false, rate: null, nextFundingTime: null, informational: true });
    const fed = build({ funding: { rate: 0.0001, nextFundingTime: 123 } }).tech.funding;
    expect(fed).toMatchObject({ available: true, rate: 0.0001, informational: true });
  });
});

describe('pureza e contrato de campos', () => {
  const source = readFileSync(new URL('./decisionCardPresenter.js', import.meta.url), 'utf8');

  it('só importa módulos puros de src/lib — nunca scanner, pineParser, entidades, React ou rede', () => {
    const imports = [...source.matchAll(/^import .* from '([^']+)'/gm)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) {
      expect(spec).toMatch(/^\.\/[A-Za-z]+\.js$/);
      expect(spec).not.toMatch(/scanner|pineParser|entities|telegram|marketDataProvider|logger/);
    }
  });

  it('não usa relógio implícito nem rede', () => {
    expect(source).not.toMatch(/Date\.now\(/);
    expect(source).not.toMatch(/new Date\(\)/);
    expect(source).not.toMatch(/\bfetch\(/);
    expect(source).not.toMatch(/from 'react'/);
  });

  it('contrato: os nomes/valores persistidos que o presenter lê ainda existem no motor e nos schemas', () => {
    const assetStateSchema = readFileSync(new URL('../../docs/schema-reference/AssetState.jsonc', import.meta.url), 'utf8');
    for (const token of ['"rsi_zone"', '"overbought"', '"oversold"', '"trend_ema"', '"bullish"', '"bearish"', '"macd_histogram"', '"rf_direction"', '"last_candle_time"']) {
      expect(assetStateSchema).toContain(token);
    }
    const confluence = readFileSync(new URL('./indicators/confluence.js', import.meta.url), 'utf8');
    expect(confluence).toContain("'against_trend'");
    const scanner = readFileSync(new URL('./scanner.js', import.meta.url), 'utf8');
    // `alignment` fica no nível de cima do sinal, antes de `context` (Codex, PR #460).
    expect(scanner).toMatch(/source: 'range_filter',\s*strength: strengthResult\.strength,\s*alignment: strengthResult\.alignment,/);
    expect(scanner).toContain('tf_1d_direction: sig.context?.tf_1d_direction');
    // Só estas duas fontes são candidatas de entrada no motor.
    expect(scanner).toContain("signal.source === 'range_filter'");
    expect(scanner).toContain("signal.source === 'smc_structure'");
  });

  it('contrato do schema: `alignment` é propriedade de nível superior do SignalEvent (e não de context) e aceita against_trend', () => {
    const raw = readFileSync(new URL('../../docs/schema-reference/SignalEvent.jsonc', import.meta.url), 'utf8');
    const schema = JSON.parse(raw.replace(/^\s*\/\/.*$/gm, ''));
    expect(schema.properties.alignment.enum).toContain('against_trend');
    expect(schema.properties.context.properties?.alignment).toBeUndefined();
  });

  it('contrato do schema: signal_timeframe ausente = operação legada 4h (TradeOperation.jsonc)', () => {
    const raw = readFileSync(new URL('../../docs/schema-reference/TradeOperation.jsonc', import.meta.url), 'utf8');
    expect(raw).toMatch(/treat missing as '4h'/);
  });
});
