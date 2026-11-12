// Modo de observação sem banco, fase O2a (docs/known-risks.md item 299): os textos que o vigia manda no Telegram.
// Funções puras: recebem números e textos, devolvem HTML do Telegram. Nada de rede, banco ou relógio.
import { describe, it, expect } from 'vitest';
import {
  buildWatchAlert, buildStartNotice, buildStaleNotice, buildNoSnapshotNotice, buildRecoveryNotice, formatBrasilia,
} from './observationMessages.mjs';
import { TELEGRAM_MAX_CHARS } from './contextTelegram.mjs';
import { fmtP } from '../src/lib/notificationTemplates.js';

const T = Date.parse('2026-11-12T10:15:00.000Z'); // 07:15 em Brasília
const op = (extra = {}) => ({
  id: 'op1', symbol: 'BTCUSDT', side: 'BUY', signal_timeframe: '4h', timeframe: '15m',
  entry_price: 100, current_stop: 95, tp1: 110, tp2: 120, ...extra,
});

// Só as marcações do próprio template; qualquer outro `<` ou `>` solto quebraria o parse_mode HTML do Telegram.
const SO_TAGS_DO_TEMPLATE = (html) => html.replace(/<\/?(b|i)>/g, '');
const semMarcacaoSolta = (html) => !/[<>]/.test(SO_TAGS_DO_TEMPLATE(html));

describe('formatBrasilia — UTC−3 fixo (o Brasil não tem horário de verão desde 2019)', () => {
  it('formata dia/mês hora:minuto', () => {
    expect(formatBrasilia(T)).toBe('12/11 07:15');
  });
  it('vira o dia para trás quando UTC ainda está na madrugada', () => {
    expect(formatBrasilia(Date.parse('2026-11-12T01:05:00.000Z'))).toBe('11/11 22:05');
  });
  it('número ilegível não vira "NaN"', () => {
    expect(formatBrasilia(NaN)).toBe('—');
    expect(formatBrasilia(undefined)).toBe('—');
  });
});

describe('formato de preço igual ao do canal normal', () => {
  it.each([0.000123, 0.5, 1, 95, 1234.5678, 9999.99, 10000, 65432.1, 123456.789])('%s', (p) => {
    const m = buildWatchAlert({ event: 'stop', op: op({ entry_price: p }), level: p, candleOpenMs: T, snapshotAtMs: T });
    // "$1.0000" também é prefixo de "$1.000000": exige que o número termine ali (sem mais dígitos depois)
    const exato = new RegExp(`\\$${fmtP(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![0-9])`);
    expect(m).toMatch(exato);
  });
});

describe('buildWatchAlert', () => {
  const alerta = (event, extra = {}) => buildWatchAlert({ event, op: op(), level: 95, candleOpenMs: T, snapshotAtMs: T - 30 * 60_000, ambiguous: false, ...extra });

  it('stop: diz o ativo, o lado, o nível, a vela e que é o modo de observação', () => {
    const m = alerta('stop');
    expect(m).toContain('🛑');
    expect(m).toContain('Stop atingido');
    expect(m).toContain('BTC/USDT');
    expect(m).toContain('BUY');
    expect(m).toContain('4H'); // o timeframe do SINAL, não o da entrada (15m)
    expect(m).toContain('95.0000');
    expect(m).toContain('12/11 07:15');
    expect(m).toMatch(/modo de observa/i);
  });
  it('explica por que o aviso vem assim e que NADA foi fechado no painel', () => {
    const m = alerta('stop');
    expect(m).toMatch(/sem cota/i);
    expect(m).toMatch(/continua .aberta. no painel|nada foi fechado/i);
    expect(m).toContain('12/11 06:45'); // a hora do retrato usado
  });
  it('stop ambíguo avisa que a regra do sistema é "vale o stop"; sem ambiguidade não fala nisso', () => {
    expect(alerta('stop', { ambiguous: true })).toMatch(/mesma vela/i);
    expect(alerta('stop', { ambiguous: false })).not.toMatch(/mesma vela/i);
  });
  it('stop depois do TP1 diz que o stop estava protegido na entrada; sem TP1 não diz', () => {
    expect(alerta('stop', { afterTp1: true })).toMatch(/TP1 já tinha sido atingido/i);
    expect(alerta('stop', { afterTp1: false })).not.toMatch(/TP1 já tinha sido atingido/i);
  });
  it('tp1: stop vai para a entrada, o vigia NÃO acompanha o trailing, e o próximo alvo aparece', () => {
    const m = alerta('tp1', { level: 110 });
    expect(m).toContain('🎯');
    expect(m).toContain('TP1');
    expect(m).toContain('110.0000');
    expect(m).toMatch(/entrada/i);
    expect(m).toMatch(/trailing/i);
    expect(m).toContain('120.0000'); // TP2
  });
  it('tp1 com TP2 desligado não inventa um alvo final', () => {
    const m = alerta('tp1', { level: 110, op: op({ tp2_cap_disabled: true }) });
    expect(m).not.toContain('120.0000');
    expect(m).toMatch(/sem TP2|sem alvo final/i);
  });
  it('tp1_full: posição encerrada 100% no TP1', () => {
    const m = alerta('tp1_full', { level: 110 });
    expect(m).toMatch(/100%/);
    expect(m).toContain('110.0000');
    expect(m).not.toMatch(/trailing/i);
  });
  it('tp2: alvo final', () => {
    const m = alerta('tp2', { level: 120 });
    expect(m).toContain('🏆');
    expect(m).toMatch(/alvo final/i);
    expect(m).toContain('120.0000');
  });
  it('venda mostra o lado SELL', () => {
    expect(alerta('stop', { op: op({ side: 'SELL', symbol: 'ETHUSDT' }) })).toMatch(/ETH\/USDT[\s\S]*SELL/);
  });
  it('sem timeframe do sinal usa o da operação; sem nenhum, omite (sem "undefined")', () => {
    expect(alerta('stop', { op: op({ signal_timeframe: undefined, timeframe: '1h' }) })).toContain('1H');
    const m = alerta('stop', { op: op({ signal_timeframe: undefined, timeframe: undefined }) });
    expect(m).not.toMatch(/undefined|null|NaN/);
  });
  it('preço pequeno usa mais casas (mesma regra de fmtP do canal normal)', () => {
    expect(alerta('stop', { level: 0.123456, op: op({ entry_price: 0.2 }) })).toContain('0.123456');
  });
  it('preço grande usa separador de milhar', () => {
    expect(alerta('stop', { level: 65432.1 })).toContain('65,432.10');
  });
  it('dado ausente vira "—", nunca "undefined"/"NaN"', () => {
    const m = buildWatchAlert({ event: 'tp1', op: { id: 'x', symbol: 'BTCUSDT', side: 'BUY' }, level: undefined, candleOpenMs: NaN, snapshotAtMs: undefined });
    expect(m).not.toMatch(/undefined|NaN|null/);
    expect(m).toContain('—');
  });
  it('escapa o texto que vem de fora (símbolo) e só deixa as marcações do template', () => {
    const m = alerta('stop', { op: op({ symbol: '<img src=x onerror=1>&USDT', side: 'BUY' }) });
    expect(m).toContain('&lt;img');
    expect(m).toContain('&amp;');
    expect(semMarcacaoSolta(m)).toBe(true);
  });
  it('lado desconhecido não entra na mensagem (lista fechada), evitando texto livre do banco', () => {
    const m = alerta('stop', { op: op({ side: '<b>HACK</b>' }) });
    expect(m).not.toContain('HACK');
  });
  it('timeframe fora do formato (texto livre do banco) é descartado, não escapado nem exibido', () => {
    const m = alerta('stop', { op: op({ signal_timeframe: '<b>x</b>', timeframe: '15m' }) });
    expect(m).not.toContain('x</b>');
    expect(semMarcacaoSolta(m)).toBe(true);
  });
  it('evento desconhecido => sem mensagem (não inventa texto)', () => {
    expect(buildWatchAlert({ event: 'qualquer', op: op(), level: 1, candleOpenMs: T })).toBeNull();
  });
  it('cabe no Telegram com folga e termina com a assinatura do sistema', () => {
    for (const e of ['stop', 'tp1', 'tp1_full', 'tp2']) {
      const m = alerta(e, { ambiguous: true, afterTp1: true });
      expect(m.length).toBeLessThan(1500);
      expect(m).toContain('Sentinel Signals');
    }
  });
  it('não cita link do painel (o painel está sem dados durante a queda)', () => {
    expect(alerta('stop')).not.toMatch(/https?:\/\//);
  });
});

describe('buildStartNotice — o vigia ligou', () => {
  const ops = [{ symbol: 'BTCUSDT', side: 'BUY' }, { symbol: 'ETHUSDT', side: 'SELL' }];
  it('lista o que vigia, a base (retrato) e o que NÃO vigia', () => {
    const m = buildStartNotice({ operations: ops, dropped: 0, snapshotAtMs: T });
    expect(m).toMatch(/2 opera/);
    expect(m).toContain('BTC/USDT');
    expect(m).toContain('ETH/USDT');
    expect(m).toContain('12/11 07:15');
    expect(m).toMatch(/Time Stop/i);
    expect(m).toMatch(/invalida/i);
    expect(m).not.toMatch(/FORA do retrato/);
  });
  it('singular: "1 operação"', () => {
    expect(buildStartNotice({ operations: [ops[0]], dropped: 0, snapshotAtMs: T })).toMatch(/1 opera[çc][ãa]o\b/);
  });
  it('operações fora do retrato são avisadas com a contagem', () => {
    const m = buildStartNotice({ operations: ops, dropped: 3, snapshotAtMs: T });
    expect(m).toMatch(/3 opera[^.]*FORA do retrato/);
  });
  it('só operações fora do retrato (nenhuma vigiada) ainda avisa', () => {
    const m = buildStartNotice({ operations: [], dropped: 2, snapshotAtMs: T });
    expect(m).toMatch(/FORA do retrato/);
  });
  it('muitas operações: a lista é cortada e o aviso cabe no Telegram', () => {
    const muitas = Array.from({ length: 100 }, (_, i) => ({ symbol: `MOEDA${i}USDT`, side: 'BUY' }));
    const m = buildStartNotice({ operations: muitas, dropped: 0, snapshotAtMs: T });
    expect(m.length).toBeLessThan(TELEGRAM_MAX_CHARS);
    expect(m).toMatch(/e mais \d+/);
    expect(m).toMatch(/100 opera/);
  });
  it('escapa os símbolos', () => {
    const m = buildStartNotice({ operations: [{ symbol: '<b>X</b>USDT', side: 'BUY' }], dropped: 0, snapshotAtMs: T });
    expect(m).toContain('&lt;b&gt;');
    expect(semMarcacaoSolta(m)).toBe(true);
  });
  it('entrada ruim não quebra', () => {
    expect(() => buildStartNotice({ operations: null, dropped: undefined, snapshotAtMs: undefined })).not.toThrow();
    expect(buildStartNotice({ operations: null, dropped: undefined, snapshotAtMs: undefined })).not.toMatch(/undefined|NaN|null/);
  });
});

describe('avisos de que o vigia NÃO está vigiando', () => {
  it('retrato velho demais: diz a idade do retrato no início da queda e manda conferir à mão', () => {
    const m = buildStaleNotice({ snapshotAtMs: T, startedAtMs: T + 5 * 60 * 60_000 });
    expect(m).toMatch(/N[ÃA]O est[áa] vigiando/i);
    expect(m).toContain('12/11 07:15');
    expect(m).toContain('12/11 12:15');
    expect(m).toMatch(/2 h/);
    expect(m).toMatch(/confira/i);
  });
  it('sem retrato: diz que não há base e manda conferir à mão', () => {
    const m = buildNoSnapshotNotice({ startedAtMs: T });
    expect(m).toMatch(/N[ÃA]O est[áa] vigiando/i);
    expect(m).toMatch(/retrato/i);
    expect(m).toMatch(/confira/i);
  });
  it('cabem no Telegram e não têm texto de erro cru', () => {
    for (const m of [buildStaleNotice({ snapshotAtMs: T, startedAtMs: T }), buildNoSnapshotNotice({ startedAtMs: T })]) {
      expect(m.length).toBeLessThan(1500);
      expect(m).not.toMatch(/undefined|NaN|null|Error/);
      expect(semMarcacaoSolta(m)).toBe(true);
    }
  });
});

describe('buildRecoveryNotice — o banco voltou', () => {
  it('conta os avisos (plural) e diz que o que passou NÃO foi reprocessado sozinho', () => {
    const m = buildRecoveryNotice({ alertsSent: 3, status: 'watching', startedAtMs: T, endedAtMs: T + 26 * 60 * 60_000 });
    expect(m).toMatch(/3 avisos/);
    expect(m).toContain('12/11 07:15');
    expect(m).toContain('13/11 09:15');
    expect(m).toMatch(/n[ãa]o foi reprocessad|n[ãa]o foram reprocessad/i);
    expect(m).toContain('Recuperação após pausa do banco');
  });
  it('singular e zero', () => {
    expect(buildRecoveryNotice({ alertsSent: 1, status: 'watching', startedAtMs: T, endedAtMs: T })).toMatch(/1 aviso\b/);
    expect(buildRecoveryNotice({ alertsSent: 0, status: 'watching', startedAtMs: T, endedAtMs: T })).toMatch(/nenhum aviso/i);
  });
  it('queda sem vigia (retrato velho/ausente) não diz que "vigiou": lembra que ficou sem vigia', () => {
    for (const status of ['stale', 'no_snapshot']) {
      const m = buildRecoveryNotice({ alertsSent: 0, status, startedAtMs: T, endedAtMs: T });
      expect(m).toMatch(/sem vigia|n[ãa]o vigiou|n[ãa]o estava vigiando/i);
    }
  });
  it('cabe no Telegram, sem marcação solta nem "undefined"', () => {
    const m = buildRecoveryNotice({ alertsSent: 2, status: 'watching', startedAtMs: T, endedAtMs: T });
    expect(m.length).toBeLessThan(1500);
    expect(semMarcacaoSolta(m)).toBe(true);
    expect(buildRecoveryNotice({})).not.toMatch(/undefined|NaN|null/);
  });
});
