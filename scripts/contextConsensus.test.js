// Item 285, addendum 30 — a projeção que o usuário registra. Sem rede: regras puras, o executável em pasta temporária e a trava do conteúdo público.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONSENSUS_KEEP_MS, CONSENSUS_MAX_ENTRIES, parseProjection, parsePrevious, isValidText, parseConsensus, setEntry, assertPublicConsensus,
  serializeConsensus, consensusFor, resolveTarget,
} from './contextConsensus.mjs';
import { main } from './context-consensus.mjs';

const NOW = Date.parse('2026-12-01T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();

describe('parseProjection: tolerante no que digita, rígido no que grava', () => {
  it('CPI/PPI/PCE: 1 número = no mês; 2 números = no mês e em 12 meses; vírgula ou ponto, vários separadores', () => {
    for (const kind of ['CPI', 'PPI', 'PCE']) {
      expect(parseProjection(kind, '0,3')).toEqual({ ok: true, text: '+0,3% m/m' });
      expect(parseProjection(kind, '+0.3')).toEqual({ ok: true, text: '+0,3% m/m' });
      expect(parseProjection(kind, '0,3 / 3,1')).toEqual({ ok: true, text: '+0,3% m/m · +3,1% a/a' });
      expect(parseProjection(kind, '0,3;3,1')).toEqual({ ok: true, text: '+0,3% m/m · +3,1% a/a' });
      expect(parseProjection(kind, ' -0,1 · 2,8 ')).toEqual({ ok: true, text: '-0,1% m/m · +2,8% a/a' });
      expect(parseProjection(kind, '0,3 3,1')).toEqual({ ok: true, text: '+0,3% m/m · +3,1% a/a' });
    }
  });
  it('CPI/PPI/PCE recusam: duas casas decimais, 3 números, letras, vazio, número enorme', () => {
    for (const ruim of ['0,25', '0,3 / 3,1 / 4,0', 'abc', '', '   ', '0', '123,4', '0,3%', '1e3']) {
      const r = parseProjection('CPI', ruim);
      expect(r.ok, ruim).toBe(false);
      expect(r.error.length).toBeGreaterThan(5);
    }
  });
  it('Payroll: inteiro em milhares com sinal opcional; recusa decimal, mais de 3 dígitos e texto', () => {
    expect(parseProjection('NFP', '150')).toEqual({ ok: true, text: '+150 mil' });
    expect(parseProjection('NFP', '-92')).toEqual({ ok: true, text: '-92 mil' });
    expect(parseProjection('NFP', '150 mil')).toEqual({ ok: true, text: '+150 mil' });
    for (const ruim of ['1,5', '1500', 'muitas', '']) expect(parseProjection('NFP', ruim).ok, ruim).toBe(false);
  });
  it('FOMC: só a lista fechada (manter, cortar/subir 25 ou 50)', () => {
    expect(parseProjection('FOMC', 'Manter')).toEqual({ ok: true, text: 'manter' });
    expect(parseProjection('FOMC', 'cortar 25')).toEqual({ ok: true, text: 'cortar 25 pb' });
    expect(parseProjection('FOMC', 'CORTAR 50 pb')).toEqual({ ok: true, text: 'cortar 50 pb' });
    expect(parseProjection('FOMC', 'subir 25')).toEqual({ ok: true, text: 'subir 25 pb' });
    for (const ruim of ['manter 25', 'cortar', 'cortar 75', 'vai cortar bastante', '']) expect(parseProjection('FOMC', ruim).ok, ruim).toBe(false);
  });
  it('tipo desconhecido não passa', () => {
    expect(parseProjection('PIB', '1,0').ok).toBe(false);
    expect(parseProjection(undefined, '1,0').ok).toBe(false);
  });
});

describe('parsePrevious', () => {
  it('é igual à projeção para os tipos numéricos', () => {
    expect(parsePrevious('PCE', '0,3 / 2,8')).toEqual({ ok: true, text: '+0,3% m/m · +2,8% a/a' });
    expect(parsePrevious('NFP', '119')).toEqual({ ok: true, text: '+119 mil' });
  });
  it('FOMC: a faixa de juros anterior, com o limite de cima maior que o de baixo', () => {
    expect(parsePrevious('FOMC', '3,75-4,00')).toEqual({ ok: true, text: '3,75%–4,00%' });
    expect(parsePrevious('FOMC', '3.75 a 4.00')).toEqual({ ok: true, text: '3,75%–4,00%' });
    expect(parsePrevious('FOMC', '4,00-3,75').ok).toBe(false);
    expect(parsePrevious('FOMC', '4,00-4,00').ok).toBe(false);
    for (const ruim of ['3,75', 'manter', '']) expect(parsePrevious('FOMC', ruim).ok, ruim).toBe(false);
  });
});

describe('estado e trava do conteúdo público', () => {
  const ok = { version: 1, items: { 'CPI-2026-12-10': { at: ISO, projection: '+0,3% m/m · +3,1% a/a' } } };

  it('setEntry grava, mescla (o campo que não veio fica) e não muda o original', () => {
    const base = { version: 1, items: {} };
    const a = setEntry(base, 'PCE-2026-12-23', { projection: '+0,2% m/m' }, NOW);
    expect(base.items).toEqual({});
    const b = setEntry(a, 'PCE-2026-12-23', { previous: '+0,3% m/m' }, NOW + 1000);
    expect(b.items['PCE-2026-12-23']).toEqual({ at: new Date(NOW + 1000).toISOString(), projection: '+0,2% m/m', previous: '+0,3% m/m' });
    const c = setEntry(b, 'PCE-2026-12-23', { projection: '+0,4% m/m' }, NOW + 2000);
    expect(c.items['PCE-2026-12-23'].projection).toBe('+0,4% m/m');
    expect(c.items['PCE-2026-12-23'].previous).toBe('+0,3% m/m');
  });
  it('setEntry ignora texto que não está no formato fechado do tipo (nunca grava lixo)', () => {
    const r = setEntry({ version: 1, items: {} }, 'CPI-2026-12-10', { projection: 'vai ser alto' }, NOW);
    expect(r.items['CPI-2026-12-10']).toEqual({ at: ISO }); // entrada vazia: a trava pública a recusa, então o CLI nunca chega a gravar isto
    expect(() => assertPublicConsensus(r)).toThrow(/consensus\.json/);
  });
  it('entradas com mais de 120 dias saem; o teto de entradas é respeitado', () => {
    const velho = new Date(NOW - CONSENSUS_KEEP_MS - 1000).toISOString();
    const lido = parseConsensus({ version: 1, items: { 'CPI-2026-01-13': { at: velho, projection: '+0,3% m/m' }, 'CPI-2026-12-10': { at: ISO, projection: '+0,3% m/m' } } }, NOW);
    expect(Object.keys(lido.items)).toEqual(['CPI-2026-12-10']);
    let s = { version: 1, items: {} };
    for (let i = 0; i < CONSENSUS_MAX_ENTRIES + 5; i += 1) s = setEntry(s, `CPI-2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`, { projection: '+0,3% m/m' }, NOW + i);
    expect(Object.keys(s.items).length).toBeLessThanOrEqual(CONSENSUS_MAX_ENTRIES);
  });
  it('parseConsensus: arquivo vem de fora; lixo vira vazio e só a entrada ruim é descartada', () => {
    for (const x of [null, undefined, 7, 'x', [], {}, { version: 2, items: {} }, { version: 1, items: [] }]) expect(parseConsensus(x, NOW)).toEqual({ version: 1, items: {} });
    const lido = parseConsensus({
      version: 1,
      items: {
        'CPI-2026-12-10': { at: ISO, projection: '+0,3% m/m', extra: 'campo a mais' },
        'CPI-2026-12-11': { at: ISO, projection: 'texto livre' },
        'PIB-2026-12-10': { at: ISO, projection: '+0,3% m/m' },
        'FOMC-2026-12-09': { at: ISO, projection: 'manter', previous: '3,75%–4,00%' },
        'NFP-2026-12-04': { at: 'ontem', projection: '+150 mil' },
      },
    }, NOW);
    expect(Object.keys(lido.items)).toEqual(['CPI-2026-12-10', 'FOMC-2026-12-09']);
    expect(lido.items['CPI-2026-12-10']).toEqual({ at: ISO, projection: '+0,3% m/m' }); // o campo a mais não passa
  });
  it('a trava aceita o formato certo e serializa com quebra de linha final', () => {
    expect(() => assertPublicConsensus(ok)).not.toThrow();
    expect(serializeConsensus(ok)).toBe(`${JSON.stringify(ok, null, 2)}\n`);
  });
  it('a trava recusa campo extra, texto livre, id ruim, formato errado do tipo, item vazio e entradas demais', () => {
    const e = (over) => ({ version: 1, items: { 'CPI-2026-12-10': { at: ISO, projection: '+0,3% m/m', ...over } } });
    const ruins = [
      { ...ok, nota: 'x' },
      { version: 2, items: {} },
      e({ nota: 'texto livre' }),
      e({ projection: 'vai ser alto' }),
      e({ projection: 'manter' }), // decisão do FOMC num tipo de inflação
      e({ at: 'ontem' }),
      e({ projection: undefined }),
      { version: 1, items: { 'cpi-2026-12-10': { at: ISO, projection: '+0,3% m/m' } } },
      { version: 1, items: { 'FOMC-2026-12-09': { at: ISO, projection: '+0,3% m/m' } } },
      { version: 1, items: { 'FOMC-2026-12-09': { at: ISO, previous: '4,00%–3,75%' } } },
      { version: 1, items: Object.fromEntries(Array.from({ length: CONSENSUS_MAX_ENTRIES + 1 }, (_, i) => [`CPI-2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}x`, { at: ISO, projection: '+0,3% m/m' }])) },
      null,
      [],
    ];
    for (const r of ruins) expect(() => assertPublicConsensus(r), JSON.stringify(r)?.slice(0, 80)).toThrow(/consensus\.json/);
  });
  it('isValidText confere o formato por tipo e campo', () => {
    expect(isValidText('CPI', 'projection', '+0,3% m/m · +3,1% a/a')).toBe(true);
    expect(isValidText('NFP', 'projection', '+150 mil')).toBe(true);
    expect(isValidText('FOMC', 'projection', 'cortar 25 pb')).toBe(true);
    expect(isValidText('FOMC', 'previous', '3,75%–4,00%')).toBe(true);
    expect(isValidText('FOMC', 'previous', '4,00%–3,75%')).toBe(false);
    expect(isValidText('CPI', 'projection', 'manter')).toBe(false);
    expect(isValidText('CPI', 'projection', 7)).toBe(false);
    expect(isValidText('XYZ', 'projection', '+0,3% m/m')).toBe(false);
  });
  it('consensusFor devolve o que foi registrado para o evento (ou null)', () => {
    const state = setEntry({ version: 1, items: {} }, 'CPI-2026-12-10', { projection: '+0,3% m/m', previous: '+0,4% m/m' }, NOW);
    expect(consensusFor(state, { id: 'CPI-2026-12-10' }, NOW)).toEqual({ projection: '+0,3% m/m', previous: '+0,4% m/m', at: ISO });
    expect(consensusFor(state, { id: 'CPI-2026-12-11' }, NOW)).toBeNull();
    expect(consensusFor(null, { id: 'CPI-2026-12-10' }, NOW)).toBeNull();
    expect(consensusFor(state, undefined, NOW)).toBeNull();
  });
});

describe('resolveTarget: qual evento o usuário quer dizer', () => {
  const ev = (id, kind, startMs) => ({ id, kind, startMs, status: 'oficial', startsAtUtc: new Date(startMs).toISOString() });
  const events = [ev('CPI-2026-11-10', 'CPI', NOW - 20 * 86400000), ev('CPI-2026-12-10', 'CPI', NOW + 9 * 86400000), ev('CPI-2027-01-13', 'CPI', NOW + 43 * 86400000), ev('NFP-2026-12-04', 'NFP', NOW + 3 * 86400000)];
  it('sem data: o PRÓXIMO do tipo (nunca um que já passou)', () => {
    expect(resolveTarget(events, 'CPI', '', NOW)).toEqual({ ok: true, event: events[1] });
    expect(resolveTarget(events, 'NFP', undefined, NOW).event.id).toBe('NFP-2026-12-04');
  });
  it('com data: o evento exato; data inexistente ou mal escrita é erro explicado', () => {
    expect(resolveTarget(events, 'CPI', '2027-01-13', NOW).event.id).toBe('CPI-2027-01-13');
    expect(resolveTarget(events, 'CPI', '2026-12-11', NOW).ok).toBe(false);
    expect(resolveTarget(events, 'CPI', '10/12/2026', NOW).error).toContain('AAAA-MM-DD');
  });
  it('tipo sem próximo evento, tipo desconhecido e agenda vazia', () => {
    expect(resolveTarget(events, 'PCE', '', NOW).ok).toBe(false);
    expect(resolveTarget(events, 'XYZ', '', NOW).ok).toBe(false);
    expect(resolveTarget(null, 'CPI', '', NOW).ok).toBe(false);
  });
});

describe('o executável (context-consensus.mjs)', () => {
  let dir;
  let saida;
  let logSpy;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-consensus-'));
    const eventos = [
      { id: 'CPI-2026-12-10', kind: 'CPI', reference: '2026-11', startsAtUtc: '2026-12-10T13:30:00.000Z', status: 'oficial', firstSeenAt: ISO, lastChangedAt: ISO },
      { id: 'FOMC-2026-12-09', kind: 'FOMC', reference: '2026-12', startsAtUtc: '2026-12-09T19:00:00.000Z', status: 'oficial', firstSeenAt: ISO, lastChangedAt: ISO },
    ];
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(eventos));
    saida = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { saida.push(a.join(' ')); });
  });
  afterEach(() => { logSpy.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); });
  const run = (argv) => { saida = []; return { code: main(argv, {}, { now: () => NOW }), texto: saida.join('\n') }; };
  const arquivo = () => path.join(dir, 'consensus.json');

  it('registra a projeção do próximo evento do tipo, no formato canônico, sem arquivo temporário', () => {
    const r = run(['--dir', dir, '--tipo', 'cpi', '--projecao', '0,3 / 3,1']);
    expect(r.code).toBe(0);
    expect(r.texto).toContain('Registrado');
    expect(r.texto).toContain('CPI-2026-12-10');
    expect(JSON.parse(fs.readFileSync(arquivo(), 'utf8'))).toEqual({ version: 1, items: { 'CPI-2026-12-10': { at: ISO, projection: '+0,3% m/m · +3,1% a/a' } } });
    expect(fs.readdirSync(dir).sort()).toEqual(['consensus.json', 'events.json']);
  });
  it('FOMC com decisão esperada e faixa anterior; nova rodada atualiza sem apagar o outro campo', () => {
    expect(run(['--dir', dir, '--tipo', 'FOMC', '--projecao', 'manter']).code).toBe(0);
    expect(run(['--dir', dir, '--tipo', 'FOMC', '--anterior', '3,75-4,00']).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(arquivo(), 'utf8')).items['FOMC-2026-12-09']).toEqual({ at: ISO, projection: 'manter', previous: '3,75%–4,00%' });
  });
  it('entrada ruim: NÃO grava nada, explica o que corrigir e sai com 1 (para cada tipo de erro)', () => {
    const casos = [
      ['--tipo', 'CPI', '--projecao', '0,25'],
      ['--tipo', 'CPI', '--projecao', ''],
      ['--tipo', 'CPI'],
      ['--tipo', 'FOMC', '--projecao', 'cortar 75'],
      ['--tipo', 'FOMC', '--anterior', '4,00-3,75'],
      ['--tipo', 'PCE', '--projecao', '0,3'], // não há próximo PCE na agenda
      ['--tipo', 'CPI', '--data', '2026-12-11', '--projecao', '0,3'],
      ['--tipo', 'XYZ', '--projecao', '0,3'],
    ];
    for (const caso of casos) {
      const r = run(['--dir', dir, ...caso]);
      expect(r.code, caso.join(' ')).toBe(1);
      expect(r.texto).toContain('Não gravei nada');
    }
    expect(fs.existsSync(arquivo())).toBe(false);
  });
  it('sem agenda legível ou sem --dir: sai com 1 sem gravar', () => {
    fs.writeFileSync(path.join(dir, 'events.json'), 'não é json');
    expect(run(['--dir', dir, '--tipo', 'CPI', '--projecao', '0,3']).code).toBe(1);
    expect(run(['--tipo', 'CPI', '--projecao', '0,3']).code).toBe(1);
    expect(fs.existsSync(arquivo())).toBe(false);
  });
  it('arquivo anterior ilegível é tratado como vazio; o texto digitado nunca vira marcação HTML na saída', () => {
    fs.writeFileSync(arquivo(), '{ lixo');
    const r = run(['--dir', dir, '--tipo', 'CPI', '--projecao', '0,3']);
    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(arquivo(), 'utf8')).version).toBe(1);
    expect(r.texto).not.toContain('<script');
  });
});
