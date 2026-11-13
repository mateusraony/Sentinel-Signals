import { describe, it, expect } from 'vitest';
import {
  buildOpenTradeStory, describeStopMove, describeProtectionProgress, STOP_MOVE_REASON_CODES,
} from './openTradeStory.js';
import { buildPreTp1TrailingSnapshot, buildPreTp1BreakevenSnapshot } from './decisionSnapshot.js';

const fmt = (iso) => `<${iso.slice(0, 16)}>`;

// O caso real do item 302/303: QNT/USDT, venda, stop já além da entrada, último snapshot ainda é o do avanço da trilha.
const trailSnapshot = (overrides = {}) => buildPreTp1TrailingSnapshot({
  isBuy: false, entry: 180.56, stopBefore: 172, stopAfter: 171.6, favorableExtreme: 160.23, atrValue: 5.6857,
  startAtrMult: 1, trailAtrMult: 2, closePrice: 161.79, evaluatedAt: '2026-11-12T20:10:00.000Z',
  marketTime: '2026-11-12T19:59:59.999Z', ...overrides,
});

const qnt = (overrides = {}) => ({
  id: 'qnt', symbol: 'QNTUSDT', side: 'SELL', status: 'SIGNAL_CONFIRMED', timeframe: '15m', signal_timeframe: '4h',
  entry_price: 180.56, initial_stop: 199.4, current_stop: 171.6, tp1: 152.3, tp2: 124.04,
  partial_percent: 50, runner_percent: 50,
  created_date: '2026-11-10T19:57:00.000Z',
  mfe_r: 1.08, mae_r: -0.05, bars_to_mfe: 9,
  pre_tp1_stop_advanced_at: '2026-11-12T20:10:00.000Z',
  pre_tp1_stop_advanced_candle_time: '2026-11-12T19:59:59.999Z',
  decision_snapshot: trailSnapshot(),
  ...overrides,
});

const step = (story, key) => story.find((s) => s.key === key)?.text;

describe('describeStopMove — só o que o motor realmente grava', () => {
  it('snapshot ainda é o do avanço: devolve o "de A para B" e a hora da última mudança', () => {
    const move = describeStopMove(qnt());
    expect(move).toEqual({
      initial: 199.4, current: 171.6, moved: true, favorable: true,
      lastMove: { from: 172, to: 171.6 }, when: '2026-11-12T20:10:00.000Z', whenKind: 'at',
    });
  });

  it('REGRESSÃO (achado do Codex, PR #576): snapshot regravado como "dormant" perde o valor anterior — não inventa', () => {
    const dormant = trailSnapshot({ stopBefore: 171.6, stopAfter: 171.6 });
    expect(dormant.reason_code).toBe('pre_tp1_trailing_dormant');
    const move = describeStopMove(qnt({ decision_snapshot: dormant }));
    expect(move.lastMove).toBeNull();
    expect(move.moved).toBe(true);
    expect(move.initial).toBe(199.4);
    expect(move.current).toBe(171.6);
    expect(move.when).toBe('2026-11-12T20:10:00.000Z');
  });

  it('snapshot de avanço ANTIGO (o stop já mudou de novo depois) não vale como última mudança', () => {
    const move = describeStopMove(qnt({ current_stop: 169 }));
    expect(move.lastMove).toBeNull();
    expect(move.moved).toBe(true);
  });

  it('snapshot com outro motivo não vira mudança de stop, mesmo trazendo stop_before/stop_after', () => {
    const fake = { reason_code: 'awaiting_tp1', facts: { stop_before: 172, stop_after: 171.6 } };
    expect(describeStopMove(qnt({ decision_snapshot: fake })).lastMove).toBeNull();
  });

  it('cada motivo de mudança registrado é aceito', () => {
    expect(STOP_MOVE_REASON_CODES).toEqual([
      'pre_tp1_trailing_advanced', 'breakeven_triggered', 'tp1_hit_stop_to_breakeven', 'runner_trailing_advanced',
    ]);
    for (const reason_code of STOP_MOVE_REASON_CODES) {
      const snap = { reason_code, facts: { stop_before: 172, stop_after: 171.6 } };
      expect(describeStopMove(qnt({ decision_snapshot: snap })).lastMove).toEqual({ from: 172, to: 171.6 });
    }
  });

  it('stop nunca saiu do inicial: moved=false, sem hora', () => {
    const move = describeStopMove(qnt({ current_stop: 199.4, decision_snapshot: null, pre_tp1_stop_advanced_at: null }));
    expect(move).toMatchObject({ moved: false, favorable: false, lastMove: null, when: null, whenKind: null });
  });

  it('hora: antes do TP1 usa o carimbo da subida; no runner usa a VELA do trailing; sem carimbo, nada', () => {
    const noSnap = { decision_snapshot: null };
    expect(describeStopMove(qnt(noSnap))).toMatchObject({ when: '2026-11-12T20:10:00.000Z', whenKind: 'at' });
    const runner = qnt({ ...noSnap, status: 'RUNNER_ACTIVE', tp1_hit: true, runner_stop_advanced_candle_time: '2026-11-13T03:59:59.999Z' });
    expect(describeStopMove(runner)).toMatchObject({ when: '2026-11-13T03:59:59.999Z', whenKind: 'candle' });
    // runner sem vela de trailing: o carimbo pré-TP1 pode ser de uma mudança ANTERIOR à do TP1 — não é usado
    const runnerNoCandle = qnt({ ...noSnap, status: 'RUNNER_ACTIVE', tp1_hit: true });
    expect(describeStopMove(runnerNoCandle)).toMatchObject({ moved: true, when: null, whenKind: null });
    expect(describeStopMove(qnt({ ...noSnap, pre_tp1_stop_advanced_at: null }))).toMatchObject({ moved: true, when: null });
  });

  it('compra: favorável é o stop SUBIR', () => {
    const buy = { side: 'BUY', status: 'SIGNAL_CONFIRMED', entry_price: 100, initial_stop: 95, current_stop: 97 };
    expect(describeStopMove(buy).favorable).toBe(true);
    expect(describeStopMove({ ...buy, current_stop: 93 }).favorable).toBe(false);
    expect(describeStopMove(qnt({ current_stop: 205, decision_snapshot: null })).favorable).toBe(false);
  });

  it('sem initial_stop (legado): só sabe o atual', () => {
    const move = describeStopMove(qnt({ initial_stop: null, decision_snapshot: null }));
    expect(move).toMatchObject({ initial: null, current: 171.6, moved: false, lastMove: null, when: null });
  });

  it('sem stop utilizável: null', () => {
    for (const bad of [null, undefined, NaN, 0, '171.6']) expect(describeStopMove(qnt({ current_stop: bad }))).toBeNull();
    expect(describeStopMove(null)).toBeNull();
  });
});

describe('buildOpenTradeStory — a operação aberta em frases, em ordem', () => {
  it('caso QNT completo: abriu → plano → caminho → stop protegido (de A para B, com hora)', () => {
    const story = buildOpenTradeStory(qnt(), { fmt });
    expect(story.map((s) => s.key)).toEqual(['opened', 'plan', 'path', 'stop']);
    expect(step(story, 'opened')).toBe('📍 Abriu uma operação de venda a $180.56 em <2026-11-10T19:57> (aviso do gráfico de 4H, confirmado no de 15M).');
    expect(step(story, 'plan')).toBe('O stop inicial ficou em $199.40: o risco assumido era de -10.43% (isso é 1R, a régua das contas abaixo).');
    expect(step(story, 'path')).toBe('Desde a entrada: no melhor ponto chegou a +11.27% (+1.08R); no pior ponto, a -0.52% (-0.05R) (o melhor ponto veio ~36 h depois da entrada).');
    expect(step(story, 'stop')).toBe('🛡️ Stop protegido: a última mudança foi em <2026-11-12T20:10>, de $172.00 para $171.60 (o inicial era $199.40).');
  });

  it('snapshot já regravado: só inicial → atual e a hora da última mudança, sem valor intermediário', () => {
    const story = buildOpenTradeStory(qnt({ decision_snapshot: trailSnapshot({ stopBefore: 171.6, stopAfter: 171.6 }) }), { fmt });
    expect(step(story, 'stop')).toBe('🛡️ Stop protegido: saiu de $199.40 (inicial) para $171.60 (atual); a última mudança foi em <2026-11-12T20:10>.');
    expect(step(story, 'stop')).not.toMatch(/172/);
  });

  it('stop que andou mas ainda arrisca NÃO ganha o escudo', () => {
    const story = buildOpenTradeStory(qnt({ current_stop: 190, decision_snapshot: null }), { fmt });
    expect(step(story, 'stop')).toBe('Stop aproximado: saiu de $199.40 (inicial) para $190.00 (atual); a última mudança foi em <2026-11-12T20:10>.');
  });

  it('stop exatamente na entrada (breakeven) ganha o escudo', () => {
    const story = buildOpenTradeStory(qnt({ current_stop: 180.56, decision_snapshot: null }), { fmt });
    expect(step(story, 'stop')).toMatch(/^🛡️ Stop protegido: saiu de \$199\.40 \(inicial\) para \$180\.56 \(atual\)/);
  });

  it('stop parado no inicial: frase curta, sem "mudança"', () => {
    const story = buildOpenTradeStory(qnt({ current_stop: 199.4, decision_snapshot: null, pre_tp1_stop_advanced_at: null }), { fmt });
    expect(step(story, 'stop')).toBe('O stop continua no valor inicial ($199.40).');
  });

  it('stop piorado à mão é dito como tal', () => {
    const story = buildOpenTradeStory(qnt({ current_stop: 205, decision_snapshot: null, pre_tp1_stop_advanced_at: null }), { fmt });
    expect(step(story, 'stop')).toBe('Stop aproximado: saiu de $199.40 (inicial) para $205.00 (atual) — contra a posição (alterado à mão).');
  });

  it('runner: conta o TP1 e data a mudança pela vela', () => {
    const story = buildOpenTradeStory(qnt({
      status: 'RUNNER_ACTIVE', tp1_hit: true, tp1_hit_price: 152.3, tp1_hit_at: '2026-11-13T02:15:00.000Z',
      current_stop: 165, decision_snapshot: null, runner_stop_advanced_candle_time: '2026-11-13T07:59:59.999Z',
    }), { fmt });
    expect(story.map((s) => s.key)).toEqual(['opened', 'plan', 'path', 'tp1', 'stop']);
    expect(step(story, 'tp1')).toBe('🎯 Bateu o TP1 ($152.30) em <2026-11-13T02:15> e realizou 50% da posição, deixando o resto correndo.');
    expect(step(story, 'stop')).toBe('🛡️ Stop protegido: saiu de $199.40 (inicial) para $165.00 (atual); a última mudança foi na vela de <2026-11-13T07:59>.');
  });

  it('TP1 prefere o horário real da vela ao da detecção', () => {
    const story = buildOpenTradeStory(qnt({
      status: 'RUNNER_ACTIVE', tp1_hit: true, tp1_hit_at: '2026-11-13T02:15:00.000Z', tp1_hit_real_time: '2026-11-13T01:59:59.999Z',
    }), { fmt });
    expect(step(story, 'tp1')).toMatch(/em <2026-11-13T01:59>/);
  });

  it('caminho: melhor ponto ainda negativo e pior ponto não-negativo viram frases honestas, sem "+… contra"', () => {
    const neverFor = buildOpenTradeStory(qnt({ mfe_r: -0.1, mae_r: -0.6, bars_to_mfe: 0 }), { fmt });
    expect(step(neverFor, 'path')).toBe('Desde a entrada: ainda não ficou a favor; no pior ponto, a -6.26% (-0.60R).');
    const neverAgainst = buildOpenTradeStory(qnt({ mfe_r: 0.5, mae_r: 0.02, bars_to_mfe: 1 }), { fmt });
    expect(step(neverAgainst, 'path')).toBe('Desde a entrada: no melhor ponto chegou a +5.22% (+0.50R); não chegou a ficar contra a posição (o melhor ponto veio ~4 h depois da entrada).');
  });

  it('operação legada (sem stop inicial, sem MFE/MAE, sem snapshot): só o que existe', () => {
    const story = buildOpenTradeStory({
      side: 'BUY', status: 'SIGNAL_CONFIRMED', timeframe: '4h', entry_price: 100, current_stop: 95, tp1: 110, tp2: 120,
      created_date: '2026-11-10T19:57:00.000Z',
    }, { fmt });
    expect(story.map((s) => s.key)).toEqual(['opened']);
    expect(story[0].text).toBe('📍 Abriu uma operação de compra a $100.00 em <2026-11-10T19:57>.');
  });

  it('nunca escreve undefined/NaN/null/Invalid, com qualquer combinação de campo faltando', () => {
    const fields = ['side', 'timeframe', 'signal_timeframe', 'entry_price', 'initial_stop', 'current_stop', 'created_date',
      'mfe_r', 'mae_r', 'bars_to_mfe', 'pre_tp1_stop_advanced_at', 'decision_snapshot', 'partial_percent'];
    const bads = [undefined, null, NaN, '', 'lixo', true];
    for (const field of fields) {
      for (const bad of bads) {
        const story = buildOpenTradeStory(qnt({ [field]: bad }), { fmt: (iso) => (iso === 'lixo' ? 'Invalid date' : fmt(iso)) });
        for (const s of story) expect(s.text, `${field}=${String(bad)} → ${s.text}`).not.toMatch(/undefined|NaN|null|Invalid|\$—/);
      }
    }
  });

  it('entrada que não é operação: lista vazia', () => {
    expect(buildOpenTradeStory(null)).toEqual([]);
    expect(buildOpenTradeStory('x')).toEqual([]);
  });
});

describe('describeProtectionProgress — os números do snapshot em linguagem simples', () => {
  it('trilha ativa: quanto precisa andar × quanto já andou, em preço e em % da entrada', () => {
    expect(describeProtectionProgress(qnt())).toBe(
      'A trilha do stop só começa a agir depois que o preço anda $5.6857 (3.15% da entrada) a favor. No melhor ponto ele já andou $20.3300 (11.26%): a proteção está ativa.',
    );
  });

  it('trilha ainda dormindo', () => {
    const snap = trailSnapshot({ stopBefore: 199.4, stopAfter: 199.4, favorableExtreme: 178 });
    expect(describeProtectionProgress(qnt({ decision_snapshot: snap }))).toBe(
      'A trilha do stop só começa a agir depois que o preço anda $5.6857 (3.15% da entrada) a favor. No melhor ponto ele já andou $2.5600 (1.42%): ainda não chegou lá.',
    );
  });

  it('preço contra a posição (ou sem MFE ainda): não chama número negativo de "a favor"', () => {
    for (const favorableExtreme of [185, null]) {
      const snap = trailSnapshot({ stopBefore: 199.4, stopAfter: 199.4, favorableExtreme });
      expect(describeProtectionProgress(qnt({ decision_snapshot: snap }))).toBe(
        'A trilha do stop só começa a agir depois que o preço anda $5.6857 (3.15% da entrada) a favor. Até a última avaliação o preço ainda não tinha andado a favor.',
      );
    }
  });

  it('modo breakeven: o número é o da última avaliação, não o melhor ponto', () => {
    const snap = buildPreTp1BreakevenSnapshot({
      isBuy: true, entry: 100, stopBefore: 95, stopAfter: 95, closePrice: 101, atrValue: 2, triggerAtrMult: 1,
    });
    const op = { side: 'BUY', status: 'SIGNAL_CONFIRMED', entry_price: 100, decision_snapshot: snap };
    expect(describeProtectionProgress(op)).toBe(
      'O stop só vai para a entrada depois que o preço anda $2.0000 (2.00% da entrada) a favor. Na última avaliação ele estava $1.0000 (1.00%) a favor: ainda não chegou lá.',
    );
  });

  it('outros motivos, sem snapshot ou sem os números: null', () => {
    expect(describeProtectionProgress(qnt({ decision_snapshot: null }))).toBeNull();
    expect(describeProtectionProgress(qnt({ decision_snapshot: { reason_code: 'awaiting_tp1', facts: { required_move: 5 } } }))).toBeNull();
    expect(describeProtectionProgress(qnt({ decision_snapshot: trailSnapshot({ atrValue: NaN }) }))).toBeNull();
    expect(describeProtectionProgress(qnt({ entry_price: null }))).toBeNull();
    expect(describeProtectionProgress(null)).toBeNull();
  });
});
