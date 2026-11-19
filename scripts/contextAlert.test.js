// Item 285, addendum 26 — Fase 4b: regras puras do aviso automático "1 hora antes". Sem rede, sem arquivo, sem relógio.
import { describe, it, expect } from 'vitest';
import {
  PRE_ALERT_FROM_MS, PRE_ALERT_TO_MS, SENT_KEEP_MS, SENT_MAX_ENTRIES, alertKey, parseSent, pickDueEvents, markSent, assertPublicSent, serializeSent,
  pickDueResults, RESULT_AFTER_ACTUAL_MS, RESULT_BLS_WAIT_MS, RESULT_NO_NUMBER_AFTER_MS, RESULT_MAX_AFTER_MS,
  summaryDay, dayBoundsBrt, eventsOfDay, pickDueSummary,
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

// Fase 4b-3 (addendum 28): quando avisar o RESULTADO.
describe('pickDueResults: o resultado, depois da divulgação', () => {
  const after = (min, over = {}) => ev({ startMs: NOW - min * MIN, ...over });
  const COM_NUMERO = { values: { previous: '+0,3% m/m', actual: '+0,2% m/m', source: 'BLS' } };

  it('com o "Atual" do BLS: avisa a partir de 5 min depois (inclusive) e até 6 h', () => {
    for (const min of [5, 6, 30, 120, 360]) expect(pickDueResults([after(min, COM_NUMERO)], NOW).length, `${min} min`).toBe(1);
    for (const min of [4, 0, -10, 361, 1440]) expect(pickDueResults([after(min, COM_NUMERO)], NOW).length, `${min} min`).toBe(0);
    expect([RESULT_AFTER_ACTUAL_MS, RESULT_MAX_AFTER_MS]).toEqual([5 * MIN, 360 * MIN]);
  });

  it('CPI/PPI/Payroll SEM o número ainda: espera o BLS até 2 h; passado isso avisa só com o BTC', () => {
    expect(pickDueResults([after(60)], NOW).length).toBe(0);
    expect(pickDueResults([after(119)], NOW).length).toBe(0);
    expect(pickDueResults([after(120)], NOW).length).toBe(1);
    expect(RESULT_BLS_WAIT_MS).toBe(120 * MIN);
    for (const kind of ['PPI', 'NFP']) expect(pickDueResults([after(130, { kind, id: `${kind}-2026-11-10` })], NOW).length).toBe(1);
  });

  it('FOMC (sem número oficial coletado): avisa depois de 35 min', () => {
    expect(pickDueResults([after(34, { kind: 'FOMC', id: 'FOMC-2026-11-10' })], NOW).length).toBe(0);
    expect(pickDueResults([after(35, { kind: 'FOMC', id: 'FOMC-2026-11-10' })], NOW).length).toBe(1);
    expect(RESULT_NO_NUMBER_AFTER_MS).toBe(35 * MIN);
  });

  it('PCE (addendum 33, números da BEA): espera o número como o BLS — com ele avisa em 5 min; sem ele espera até 2 h', () => {
    const pce = (min, over = {}) => after(min, { kind: 'PCE', id: 'PCE-2026-11-10', ...over });
    const BEA = { values: { previous: '+0,5% m/m', actual: '+0,3% m/m', source: 'BEA' } };
    expect(pickDueResults([pce(35)], NOW).length).toBe(0);
    expect(pickDueResults([pce(119)], NOW).length).toBe(0);
    expect(pickDueResults([pce(120)], NOW).length).toBe(1);
    expect(pickDueResults([pce(4, BEA)], NOW).length).toBe(0);
    expect(pickDueResults([pce(5, BEA)], NOW).length).toBe(1);
  });

  it('só data firme; a_confirmar nunca', () => {
    expect(pickDueResults([after(30, { ...COM_NUMERO, status: 'a_confirmar' })], NOW).length).toBe(0);
    expect(pickDueResults([after(30, { ...COM_NUMERO, status: 'confirmada' })], NOW).length).toBe(1);
  });

  it('o registro `post` é independente do `pre`: avisar antes não impede o resultado, e avisar o resultado não repete', () => {
    const e = after(30, COM_NUMERO);
    const soPre = markSent(undefined, e, NOW, 'pre');
    expect(pickDueResults([e], NOW, soPre).length).toBe(1);
    const comPost = markSent(soPre, e, NOW, 'post');
    expect(pickDueResults([e], NOW, comPost).length).toBe(0);
    expect(Object.keys(comPost.sent).sort()).toEqual(['CPI-2026-11-10:post', 'CPI-2026-11-10:pre']);
    expect(alertKey(e, 'post')).toBe('CPI-2026-11-10:post');
    expect(alertKey(e)).toBe('CPI-2026-11-10:pre');
  });

  it('o registro `post` também passa pela trava pública e pelo parse; fase inventada não', () => {
    const ok = { version: 1, sent: { 'CPI-2026-11-10:post': '2026-11-10T14:00:00.000Z' } };
    expect(() => assertPublicSent(ok)).not.toThrow();
    expect(parseSent(ok).sent).toEqual(ok.sent);
    expect(() => assertPublicSent({ version: 1, sent: { 'CPI-2026-11-10:resultado': '2026-11-10T14:00:00.000Z' } })).toThrow(/alerts-sent\.json/);
    expect(parseSent({ version: 1, sent: { 'CPI-2026-11-10:xyz': '2026-11-10T14:00:00.000Z' } }).sent).toEqual({});
  });

  it('vários: do mais antigo ao mais novo; lixo é ignorado', () => {
    const lista = [after(30, { ...COM_NUMERO, id: 'PPI-2026-11-10', kind: 'PPI', startMs: NOW - 30 * MIN }), after(90, { ...COM_NUMERO, id: 'NFP-2026-11-10', kind: 'NFP' }), null, {}, 7];
    expect(pickDueResults(lista, NOW).map((e) => e.id)).toEqual(['NFP-2026-11-10', 'PPI-2026-11-10']);
    expect(pickDueResults('x', NOW)).toEqual([]);
  });
});

// Fase 4c (addendum 35): o resumo do dia, depois das 21h de Brasília (UTC−3).
describe('summaryDay: o dia de Brasília que o resumo cobre agora', () => {
  const dia = (iso) => summaryDay(Date.parse(iso));
  it('de 21:00 de Brasília (00:00 UTC) até 02:59 do dia seguinte: cobre o dia que acabou', () => {
    expect(dia('2026-11-20T00:00:00Z')).toBe('2026-11-19');
    expect(dia('2026-11-20T00:15:00Z')).toBe('2026-11-19');
    expect(dia('2026-11-20T05:59:59Z')).toBe('2026-11-19');
  });
  it('fora da janela (antes das 21h e depois das 02:59 de Brasília): nada', () => {
    for (const iso of ['2026-11-19T23:59:59Z', '2026-11-20T06:00:00Z', '2026-11-20T12:00:00Z', '2026-11-19T15:00:00Z']) expect(dia(iso), iso).toBeNull();
  });
  it('virada de ano e de mês: o dia é o de Brasília, não o de UTC', () => {
    expect(dia('2027-01-01T04:00:00Z')).toBe('2026-12-31');
    expect(dia('2026-12-01T01:00:00Z')).toBe('2026-11-30');
    expect(dia('2028-03-01T02:00:00Z')).toBe('2028-02-29'); // ano bissexto
  });
  it('entrada ruim: null', () => {
    expect(summaryDay(NaN)).toBeNull();
    expect(summaryDay(undefined)).toBeNull();
  });
  it('dayBoundsBrt: o dia de Brasília vai de 03:00 UTC a 03:00 UTC do dia seguinte', () => {
    expect(dayBoundsBrt('2026-11-19')).toEqual({ startMs: Date.parse('2026-11-19T03:00:00Z'), endMs: Date.parse('2026-11-20T03:00:00Z') });
  });
});

describe('eventsOfDay e pickDueSummary', () => {
  const T = (iso) => Date.parse(iso);
  const at = (iso, over = {}) => ev({ startsAtUtc: iso, startMs: T(iso), ...over });
  const NOITE = T('2026-11-20T00:10:00Z'); // 21:10 de Brasília de 19/11
  const cpi = at('2026-11-19T13:30:00.000Z', { id: 'CPI-2026-11-19' });
  const fomc = at('2026-11-19T19:00:00.000Z', { id: 'FOMC-2026-11-19', kind: 'FOMC' });

  it('só eventos do dia de Brasília que já aconteceram e têm data firme, do mais cedo ao mais tarde', () => {
    const naBorda = at('2026-11-19T02:59:59.000Z', { id: 'X-2026-11-19' }); // 23:59:59 de 18/11 em Brasília
    const proximoDia = at('2026-11-20T03:00:00.000Z', { id: 'Y-2026-11-20' }); // 00:00 de 20/11 em Brasília
    const aConfirmar = at('2026-11-19T15:00:00.000Z', { id: 'PPI-2026-11-19', status: 'a_confirmar' });
    const futuro = at('2026-11-20T00:30:00.000Z', { id: 'Z-2026-11-19' }); // ainda não aconteceu (agora é 00:10)
    const lista = eventsOfDay([fomc, naBorda, proximoDia, aConfirmar, futuro, cpi], '2026-11-19', NOITE);
    expect(lista.map((e) => e.id)).toEqual(['CPI-2026-11-19', 'FOMC-2026-11-19']);
    expect(eventsOfDay(null, '2026-11-19', NOITE)).toEqual([]);
  });

  it('há resumo quando é hora, o dia teve divulgação e ainda não foi enviado', () => {
    const r = pickDueSummary([cpi, fomc], NOITE);
    expect(r.day).toBe('2026-11-19');
    expect(r.id).toBe('DIA-2026-11-19');
    expect(r.events.map((e) => e.id)).toEqual(['CPI-2026-11-19', 'FOMC-2026-11-19']);
  });
  it('dia SEM divulgação não manda nada (volume de mensagens é risco registrado)', () => {
    expect(pickDueSummary([at('2026-11-18T13:30:00.000Z', { id: 'CPI-2026-11-18' })], NOITE)).toBeNull();
    expect(pickDueSummary([], NOITE)).toBeNull();
  });
  it('fora da hora de resumo (de tarde) não manda, mesmo com divulgação', () => {
    expect(pickDueSummary([cpi], T('2026-11-19T20:00:00Z'))).toBeNull();
  });
  it('registrado: a 2ª passada não repete; o registro `dia` não atrapalha os avisos de antes/depois', () => {
    const state = markSent(null, { id: 'DIA-2026-11-19' }, NOITE, 'dia');
    expect(Object.keys(state.sent)).toEqual(['DIA-2026-11-19:dia']);
    expect(() => assertPublicSent(state)).not.toThrow();
    expect(pickDueSummary([cpi], NOITE + 15 * MIN, state)).toBeNull();
    // outro dia continua devido
    const amanha = at('2026-11-20T13:30:00.000Z', { id: 'CPI-2026-11-20' });
    expect(pickDueSummary([amanha], T('2026-11-21T00:10:00Z'), state)?.id).toBe('DIA-2026-11-20');
    // o registro de resumo não conta como o aviso de resultado do mesmo evento
    expect(pickDueResults([cpi], T('2026-11-19T16:00:00Z'), state).length).toBe(1); // CPI sem número espera 2 h; às 16:00Z já passaram 2h30
  });
  it('a trava pública aceita a chave `dia` e continua recusando fase desconhecida', () => {
    expect(() => assertPublicSent({ version: 1, sent: { 'DIA-2026-11-19:dia': '2026-11-20T00:10:00.000Z' } })).not.toThrow();
    expect(() => assertPublicSent({ version: 1, sent: { 'DIA-2026-11-19:resumo': '2026-11-20T00:10:00.000Z' } })).toThrow(/chave inválida/);
  });
});
