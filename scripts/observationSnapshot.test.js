// Modo de observação sem banco, fase O1 (docs/known-risks.md item 299): o RETRATO do estado que fica em RTDB para o vigia da O2.
// Parte pura: só decide O QUE entra (lista fechada de campos), o que é recusado e o tamanho. Nada de rede nem de banco.
// O retrato guarda entrada, stop e alvos de operações reais: por isso é uma lista FECHADA de campos primitivos, nunca "a linha inteira".
import { describe, it, expect } from 'vitest';
import {
  SNAPSHOT_VERSION,
  LIVE_STATUSES,
  OPERATION_FIELDS,
  ASSET_FIELDS,
  MAX_OPERATIONS,
  MAX_SNAPSHOT_BYTES,
  buildSnapshot,
} from './observationSnapshot.mjs';
import { TRADE_OP_STATUSES, TERMINAL_STATUSES } from '../src/lib/opTransition.js';

const NOW = Date.parse('2026-11-11T12:00:00Z');

const op = (extra = {}) => ({
  id: 'op-1', asset_id: 'asset-btc', symbol: 'BTCUSDT', side: 'BUY', status: 'SIGNAL_CONFIRMED', cascade: '4h_15m',
  entry_price: 100, initial_stop: 95, current_stop: 95, tp1: 107.5, tp2: 115, tp1_hit: false, tp2_hit: false,
  partial_percent: 50, market_source: 'binance_spot', entry_candle_time_15m: '2026-11-11T10:15:00.000Z', created_date: '2026-11-11T10:15:03.000Z',
  ...extra,
});
const asset = (extra = {}) => ({ id: 'asset-btc', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true, ...extra });
const montar = (extra = {}) => buildSnapshot({ operations: [op()], assets: [asset()], telegramFilters: { sources: ['cron', 'browser'] }, nowMs: NOW, scanId: 'scan-123', ...extra });

describe('buildSnapshot — forma', () => {
  it('monta o retrato com versão, carimbo de frescor ISO, contagens e as listas', () => {
    const r = montar();
    expect(r.ok).toBe(true);
    expect(r.snapshot).toMatchObject({
      version: SNAPSHOT_VERSION, snapshot_at: '2026-11-11T12:00:00.000Z', scan_id: 'scan-123',
      counts: { operations: 1, assets: 1 }, dropped_operations: 0, telegram_filters: { sources: ['cron', 'browser'] },
    });
    expect(r.snapshot.operations).toHaveLength(1);
    expect(r.snapshot.assets).toEqual([{ id: 'asset-btc', symbol: 'BTCUSDT', display_name: 'BTC/USDT', is_active: true }]);
    expect(r.bytes).toBeGreaterThan(100);
  });

  it('o carimbo de frescor reflete o relógio recebido (é ele que a O2 usa para recusar retrato velho)', () => {
    expect(montar({ nowMs: NOW + 90 * 60000 }).snapshot.snapshot_at).toBe('2026-11-11T13:30:00.000Z');
  });

  it('é determinístico e não altera a entrada', () => {
    const ops = [op()];
    const copia = structuredClone(ops);
    const a = buildSnapshot({ operations: ops, assets: [asset()], telegramFilters: null, nowMs: NOW });
    const b = buildSnapshot({ operations: ops, assets: [asset()], telegramFilters: null, nowMs: NOW });
    expect(a).toEqual(b);
    expect(ops).toEqual(copia);
  });

  it('é JSON puro: ida e volta idêntica, sem undefined nem Date (o RTDB recusa undefined)', () => {
    const r = montar({ operations: [op({ tp2_cap_disabled: undefined, exit_mode: undefined })] });
    expect(JSON.parse(JSON.stringify(r.snapshot))).toEqual(r.snapshot);
    expect(JSON.stringify(r.snapshot)).not.toContain('undefined');
  });

  it('sem filtros do Telegram o campo vira null (a O2 então avisa tudo, como o cron faz)', () => {
    expect(montar({ telegramFilters: null }).snapshot.telegram_filters).toBeNull();
    expect(montar({ telegramFilters: undefined }).snapshot.telegram_filters).toBeNull();
  });
});

describe('buildSnapshot — lista fechada de campos (o retrato nunca leva a linha inteira)', () => {
  it('só os campos permitidos passam; campo desconhecido, objeto, vetor e segredo plantados ficam de fora', () => {
    const r = montar({
      operations: [op({
        decision_snapshot: { facts: { x: 1 } }, notes: 'texto livre do usuário', user_email: 'a@b.c', telegram_token: 'segredo',
        timeline: [1, 2, 3], nested: { a: { b: 1 } }, when: new Date(NOW),
      })],
      assets: [asset({ owner_email: 'a@b.c', api_key: 'segredo', config: { x: 1 } })],
    });
    const texto = JSON.stringify(r.snapshot);
    for (const proibido of ['decision_snapshot', 'texto livre', 'a@b.c', 'segredo', 'timeline', 'nested', 'owner_email', 'api_key', 'config', 'when']) {
      expect(texto, proibido).not.toContain(proibido);
    }
    for (const chave of Object.keys(r.snapshot.operations[0])) expect(OPERATION_FIELDS).toContain(chave);
    for (const chave of Object.keys(r.snapshot.assets[0])) expect(ASSET_FIELDS).toContain(chave);
  });

  it('só valores primitivos: número não finito num campo SECUNDÁRIO vira null e texto longo é cortado', () => {
    const r = montar({ operations: [op({ partial_percent: NaN, hierarchical_cascade: Infinity, cascade: 'x'.repeat(500) })] });
    const o = r.snapshot.operations[0];
    expect(o.partial_percent).toBeNull();
    expect(o.hierarchical_cascade).toBeNull();
    expect(o.cascade.length).toBeLessThanOrEqual(100);
  });

  it('preço CRÍTICO não finito (entrada, stop, alvo) torna a operação inutilizável: descartada e contada, nunca com null no lugar do preço', () => {
    for (const campo of ['entry_price', 'current_stop', 'tp1', 'tp2']) {
      for (const ruim of [NaN, Infinity, -Infinity]) {
        const r = montar({ operations: [op({ id: 'bom' }), op({ id: 'ruim', [campo]: ruim })] });
        expect(r.snapshot.operations.map((o) => o.id), `${campo}=${ruim}`).toEqual(['bom']);
        expect(r.snapshot.dropped_operations).toBe(1);
      }
    }
  });

  it('null é preservado (campo existe e está vazio), campo ausente continua ausente', () => {
    const r = montar({ operations: [op({ entry_candle_time_5m: null })] });
    expect(r.snapshot.operations[0].entry_candle_time_5m).toBeNull();
    expect('entry_candle_time_4h' in r.snapshot.operations[0]).toBe(false);
  });

  it('os campos que o vigia precisa para decidir stop e alvo estão na lista', () => {
    for (const campo of ['id', 'symbol', 'side', 'status', 'entry_price', 'initial_stop', 'current_stop', 'tp1', 'tp2', 'tp1_hit', 'partial_percent', 'entry_candle_time_15m', 'candle_close_time', 'market_source']) {
      expect(OPERATION_FIELDS, campo).toContain(campo);
    }
  });
});

describe('buildSnapshot — só operações VIVAS e válidas', () => {
  it('as duas situações vivas somadas às terminais são exatamente as situações do motor (não deriva do opTransition)', () => {
    expect([...LIVE_STATUSES, ...TERMINAL_STATUSES].sort()).toEqual([...TRADE_OP_STATUSES].sort());
    for (const s of LIVE_STATUSES) expect(TERMINAL_STATUSES).not.toContain(s);
  });

  it('operação encerrada não entra (o retrato é só do que ainda precisa de vigia)', () => {
    const r = montar({ operations: [op({ id: 'vivo' }), op({ id: 'fechado', status: 'STOP_HIT' }), op({ id: 'fechado2', status: 'CLOSED' }), op({ id: 'runner', status: 'RUNNER_ACTIVE' })] });
    expect(r.snapshot.operations.map((o) => o.id)).toEqual(['vivo', 'runner']);
    expect(r.snapshot.dropped_operations).toBe(0);
  });

  it('operação viva MAS inválida (sem id, lado estranho, sem stop numérico) é descartada E contada, nunca some em silêncio', () => {
    const r = montar({ operations: [
      op({ id: 'ok' }), op({ id: '' }), op({ id: 'lado', side: 'LONG' }), op({ id: 'semstop', current_stop: null }), op({ id: 'semsimbolo', symbol: '' }),
      op({ id: 'semtp', tp1: null }),
    ] });
    expect(r.snapshot.operations.map((o) => o.id)).toEqual(['ok']);
    expect(r.snapshot.dropped_operations).toBe(5);
    expect(r.snapshot.counts.operations).toBe(1);
  });

  it('muitas operações: RECUSA o retrato inteiro em vez de cortar (um retrato cortado deixaria a O2 cega sem avisar)', () => {
    const muitas = Array.from({ length: MAX_OPERATIONS + 1 }, (_, i) => op({ id: `op-${i}` }));
    const r = montar({ operations: muitas });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('muitas_operacoes');
    expect(montar({ operations: muitas.slice(0, MAX_OPERATIONS) }).ok).toBe(true);
  });

  it('retrato acima do teto de bytes é recusado', () => {
    // ativos demais (cada um com texto no limite) estouram o teto sem passar do limite de operações
    const ativos = Array.from({ length: 5000 }, (_, i) => asset({ id: `a-${i}`, symbol: `S${i}USDT`, display_name: 'x'.repeat(100) }));
    const r = montar({ assets: ativos });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('retrato_grande_demais');
    expect(MAX_SNAPSHOT_BYTES).toBeGreaterThan(50000);
  });
});

describe('buildSnapshot — entrada ruim', () => {
  it('relógio inválido ou listas que não são vetor são recusados com motivo, sem exceção', () => {
    expect(montar({ nowMs: NaN })).toMatchObject({ ok: false, reason: 'relogio_invalido' });
    expect(montar({ nowMs: 'agora' })).toMatchObject({ ok: false, reason: 'relogio_invalido' });
    expect(montar({ operations: null })).toMatchObject({ ok: false, reason: 'entrada_invalida' });
    expect(montar({ operations: 'x' })).toMatchObject({ ok: false, reason: 'entrada_invalida' });
    expect(montar({ assets: {} })).toMatchObject({ ok: false, reason: 'entrada_invalida' });
  });

  it('scan_id fora do formato seguro vira null (nunca texto livre no retrato)', () => {
    expect(montar({ scanId: 'scan_ok-1' }).snapshot.scan_id).toBe('scan_ok-1');
    expect(montar({ scanId: 'tem espaço e /barra' }).snapshot.scan_id).toBeNull();
    expect(montar({ scanId: 'x'.repeat(200) }).snapshot.scan_id).toBeNull();
    expect(montar({ scanId: undefined }).snapshot.scan_id).toBeNull();
  });

  it('filtros do Telegram: só `sources` (lista de textos curtos); o resto é ignorado', () => {
    expect(montar({ telegramFilters: { sources: ['cron'], min_score: 50, events: ['x'], token: 'segredo' } }).snapshot.telegram_filters).toEqual({ sources: ['cron'] });
    expect(montar({ telegramFilters: { sources: 'cron' } }).snapshot.telegram_filters).toBeNull();
    expect(montar({ telegramFilters: { sources: [1, {}, 'ok', 'y'.repeat(100)] } }).snapshot.telegram_filters).toEqual({ sources: ['ok'] });
    expect(montar({ telegramFilters: {} }).snapshot.telegram_filters).toBeNull();
  });
});
