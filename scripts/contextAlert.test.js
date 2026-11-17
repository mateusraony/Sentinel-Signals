// Item 285, addendum 26 — Fase 4b: regras puras do aviso automático "1 hora antes". Sem rede, sem arquivo, sem relógio.
import { describe, it, expect } from 'vitest';
import {
  PRE_ALERT_FROM_MS, PRE_ALERT_TO_MS, SENT_KEEP_MS, SENT_MAX_ENTRIES, alertKey, parseSent, pickDueEvents, markSent, assertPublicSent, serializeSent,
} from './contextAlert.mjs';

const MIN = 60 * 1000;
const NOW = Date.parse('2026-11-10T12:00:00.000Z');
const ev = (over = {}) => ({
  id: 'CPI-2026-11-10', kind: 'CPI', status: 'oficial', startsAtUtc: '2026-11-10T13:30:00.000Z', startMs: NOW + 90 * MIN, ...over,
});
const at = (min, over = {}) => ev({ startMs: NOW + min * MIN, ...over });

describe('janela: de 45 a 75 minutos antes, inclusive', () => {
  it('pega 45, 60 e 75 min; não pega 44, 76, 0, passado nem 24 h', () => {
    for (const min of [45, 60, 75]) expect(pickDueEvents([at(min)], NOW).length, `${min} min`).toBe(1);
    for (const min of [44, 76, 0, -30, 1440]) expect(pickDueEvents([at(min)], NOW).length, `${min} min`).toBe(0);
  });
  it('a janela é de 30 min: com passadas a cada 15 min sempre cai ao menos uma dentro (mesmo com 1 passada pulada)', () => {
    expect(PRE_ALERT_TO_MS - PRE_ALERT_FROM_MS).toBe(30 * MIN);
    // Qualquer defasagem (0 a 14 min) entre o relógio das passadas e o evento: as passadas têm falta = defasagem + 15·k min.
    for (let defasagem = 0; defasagem < 15; defasagem += 1) {
      let dentro = 0;
      for (let k = 0; k <= 10; k += 1) if (pickDueEvents([at(defasagem + 15 * k)], NOW).length) dentro += 1;
      expect(dentro, `defasagem ${defasagem} min`).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('quem entra: só data firme', () => {
  it('oficial e confirmada avisam; a_confirmar nunca (a hora pode mudar)', () => {
    expect(pickDueEvents([at(60, { status: 'oficial' })], NOW).length).toBe(1);
    expect(pickDueEvents([at(60, { status: 'confirmada' })], NOW).length).toBe(1);
    expect(pickDueEvents([at(60, { status: 'a_confirmar' })], NOW).length).toBe(0);
    expect(pickDueEvents([at(60, { status: 'qualquer' })], NOW).length).toBe(0);
  });
  it('linha ruim é ignorada, não derruba', () => {
    const ruins = [null, undefined, 7, 'x', {}, { id: 3 }, { id: 'A', startMs: NaN, status: 'oficial' }, { id: 'B', status: 'oficial' }];
    expect(pickDueEvents([...ruins, at(60)], NOW).length).toBe(1);
    expect(pickDueEvents('nao-lista', NOW)).toEqual([]);
    expect(pickDueEvents(null, NOW)).toEqual([]);
  });
  it('vários na janela: do mais próximo ao mais distante, desempate por id', () => {
    const lista = [at(70, { id: 'PPI-2026-11-10' }), at(50, { id: 'NFP-2026-11-10' }), at(50, { id: 'CPI-2026-11-10' })];
    expect(pickDueEvents(lista, NOW).map((e) => e.id)).toEqual(['CPI-2026-11-10', 'NFP-2026-11-10', 'PPI-2026-11-10']);
  });
});

describe('registro do "já avisei"', () => {
  it('evento já marcado não volta; outro evento na mesma janela continua devido', () => {
    const e1 = at(60);
    const e2 = at(60, { id: 'PPI-2026-11-10' });
    const estado = markSent({ version: 1, sent: {} }, e1, NOW);
    expect(pickDueEvents([e1, e2], NOW, estado).map((e) => e.id)).toEqual(['PPI-2026-11-10']);
  });
  it('remarcar a data (id novo) é um aviso novo', () => {
    const estado = markSent(undefined, at(60), NOW);
    expect(pickDueEvents([at(60, { id: 'CPI-2026-11-11' })], NOW, estado).length).toBe(1);
  });
  it('markSent não muda o original, grava o instante e a chave certa', () => {
    const original = { version: 1, sent: {} };
    const novo = markSent(original, at(60), NOW);
    expect(original).toEqual({ version: 1, sent: {} });
    expect(novo.sent[alertKey(at(60))]).toBe('2026-11-10T12:00:00.000Z');
    expect(alertKey(at(60))).toBe('CPI-2026-11-10:pre');
  });
  it('entradas com mais de 30 dias saem; as recentes ficam', () => {
    const velho = new Date(NOW - SENT_KEEP_MS - 1000).toISOString();
    const recente = new Date(NOW - SENT_KEEP_MS + 60 * MIN).toISOString();
    const estado = { version: 1, sent: { 'CPI-2026-10-01:pre': velho, 'NFP-2026-10-10:pre': recente } };
    const novo = markSent(estado, at(60), NOW);
    expect(Object.keys(novo.sent).sort()).toEqual(['CPI-2026-11-10:pre', 'NFP-2026-10-10:pre']);
  });
  it('respeita o teto de entradas (sai a mais antiga)', () => {
    const sent = {};
    for (let i = 0; i < SENT_MAX_ENTRIES; i += 1) sent[`CPI-2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}:pre`] = new Date(NOW - (i + 1) * MIN).toISOString();
    const novo = markSent({ version: 1, sent }, at(60), NOW);
    expect(Object.keys(novo.sent).length).toBeLessThanOrEqual(SENT_MAX_ENTRIES);
    expect(novo.sent['CPI-2026-11-10:pre']).toBeDefined();
  });
});

describe('parseSent: o arquivo vem do disco/rede e não é confiável', () => {
  it('lixo vira registro vazio (pior caso: um aviso repetido, nunca quebra)', () => {
    for (const x of [null, undefined, 7, 'x', [], {}, { version: 2, sent: {} }, { version: 1, sent: [] }, { version: 1 }]) {
      expect(parseSent(x), JSON.stringify(x)).toEqual({ version: 1, sent: {} });
    }
  });
  it('descarta só a entrada ruim (chave fora do formato, instante inválido, valor que não é texto)', () => {
    const lido = parseSent({
      version: 1,
      sent: { 'CPI-2026-11-10:pre': '2026-11-10T12:00:00.000Z', 'x': '2026-11-10T12:00:00.000Z', 'NFP-2026-11-06:pre': 'ontem', 'PPI-2026-11-13:pre': 5, 'cpi-2026-11-10:pre': '2026-11-10T12:00:00.000Z' },
    });
    expect(lido.sent).toEqual({ 'CPI-2026-11-10:pre': '2026-11-10T12:00:00.000Z' });
  });
});

describe('trava do conteúdo público', () => {
  const ok = { version: 1, sent: { 'CPI-2026-11-10:pre': '2026-11-10T12:00:00.000Z' } };
  it('aceita o formato certo e serializa com chaves em ordem e quebra de linha final', () => {
    expect(() => assertPublicSent(ok)).not.toThrow();
    expect(serializeSent(ok)).toBe(`${JSON.stringify(ok, null, 2)}\n`);
    expect(serializeSent({ version: 1, sent: {} })).toBe('{\n  "version": 1,\n  "sent": {}\n}\n');
  });
  it('recusa campo extra, texto livre, chave ruim, instante ruim, versão errada e entradas demais', () => {
    const ruins = [
      { ...ok, extra: 'mensagem enviada' },
      { version: 1, sent: { 'CPI-2026-11-10:pre': 'enviado para o chat 123' } },
      { version: 1, sent: { 'chat 123': '2026-11-10T12:00:00.000Z' } },
      { version: 1, sent: { 'CPI-2026-11-10:pre': '2026-11-10' } },
      { version: 2, sent: {} },
      { sent: {} },
      null,
      [],
      { version: 1, sent: Object.fromEntries(Array.from({ length: SENT_MAX_ENTRIES + 1 }, (_, i) => [`CPI-2026-01-${String(i).padStart(2, '0')}:pre`, '2026-11-10T12:00:00.000Z'])) },
    ];
    for (const r of ruins) expect(() => assertPublicSent(r), JSON.stringify(r)?.slice(0, 80)).toThrow(/alerts-sent\.json/);
  });
});
