// Item 285, addenda 30 e 31 — a projeção que o usuário registra. Sem rede: regras puras, o executável em pasta temporária e a trava do conteúdo público.
// Addendum 31: o formulário passou a ter UM campo por coisa (no mês, 12 meses, vagas, juros, anterior); campo de outro tipo é ignorado com aviso; o FOMC é a taxa.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CONSENSUS_KEEP_MS, CONSENSUS_MAX_ENTRIES, buildFields, describeFomc, isValidText, parseConsensus, setEntry, assertPublicConsensus,
  serializeConsensus, consensusFor, resolveTarget,
} from './contextConsensus.mjs';
import { main } from './context-consensus.mjs';

const NOW = Date.parse('2026-12-01T12:00:00.000Z');
const ISO = new Date(NOW).toISOString();

describe('buildFields: um campo por coisa, tolerante no que digita, rígido no que grava', () => {
  it('CPI/PPI/PCE: campo 3 (no mês) e, se quiser, campo 4 (12 meses); vírgula ou ponto, com ou sem "%"', () => {
    for (const kind of ['CPI', 'PPI', 'PCE']) {
      expect(buildFields(kind, { mes: '0,3' })).toEqual({ ok: true, fields: { projection: '+0,3% m/m' }, notes: [] });
      expect(buildFields(kind, { mes: '0.3%' }).fields.projection).toBe('+0,3% m/m');
      expect(buildFields(kind, { mes: '0,3', ano: '3,1' }).fields.projection).toBe('+0,3% m/m · +3,1% a/a');
      expect(buildFields(kind, { mes: '-0,1', ano: '2.8%' }).fields.projection).toBe('-0,1% m/m · +2,8% a/a');
      expect(buildFields(kind, { mes: '0,3% MoM' }).fields.projection).toBe('+0,3% m/m');
    }
  });
  it('duas casas decimais são ARREDONDADAS para uma (é o que o órgão publica) e o aviso diz', () => {
    const r = buildFields('PCE', { mes: '0,25' });
    expect(r.ok).toBe(true);
    expect(r.fields.projection).toBe('+0,3% m/m');
    expect(r.notes.join(' ')).toContain('arredondado para +0,3%');
    expect(buildFields('PCE', { mes: '-0,04' }).fields.projection).toBe('+0,0% m/m'); // arredonda para zero: sem "-0,0"
  });
  it('Payroll: campo 5, inteiro em milhares; aceita "150k" e "150 mil"', () => {
    expect(buildFields('NFP', { vagas: '150' }).fields.projection).toBe('+150 mil');
    expect(buildFields('NFP', { vagas: '150K' }).fields.projection).toBe('+150 mil');
    expect(buildFields('NFP', { vagas: '-92 mil' }).fields.projection).toBe('-92 mil');
    expect(buildFields('NFP', { vagas: '1,5' }).ok).toBe(false);
    expect(buildFields('NFP', { vagas: '1500' }).ok).toBe(false);
  });
  it('FOMC: campo 6 é a TAXA esperada (como o TradingView mostra); campo 7 é a taxa atual', () => {
    expect(buildFields('FOMC', { juros: '3,75' }).fields).toEqual({ projection: '3,75%' });
    expect(buildFields('FOMC', { juros: '4%', anterior: '4,25' }).fields).toEqual({ projection: '4,00%', previous: '4,25%' });
    expect(buildFields('FOMC', { juros: '3.5' }).fields.projection).toBe('3,50%');
    for (const ruim of ['manter', '30', '-1', 'abc']) expect(buildFields('FOMC', { juros: ruim }).ok, ruim).toBe(false);
  });
  it('REGRESSÃO (19/11): o que o usuário colou no 1º teste — exemplos de vários tipos num campo só — dá erro que aponta o campo e mostra o exemplo', () => {
    const r = buildFields('CPI', { mes: '0,3 / 3,1. 150. manter', anterior: '3,75-4,00' });
    expect(r.ok).toBe(false);
    expect(r.error).toContain('campo 3');
    expect(r.error).toContain('Exemplo: 0,3');
  });
  it('REGRESSÃO (19/11): tudo em branco diz QUAL campo preencher para o tipo escolhido', () => {
    expect(buildFields('CPI', {}).error).toContain('campo 3');
    expect(buildFields('NFP', {}).error).toContain('campo 5');
    expect(buildFields('FOMC', { juros: '  ' }).error).toContain('campo 6');
  });
  it('campo de OUTRO tipo é ignorado com aviso e NÃO impede o registro', () => {
    const r = buildFields('PCE', { mes: '0,2', vagas: '150', juros: '3,75' });
    expect(r.ok).toBe(true);
    expect(r.fields).toEqual({ projection: '+0,2% m/m' });
    expect(r.notes.join(' ')).toContain('campo 5');
    expect(r.notes.join(' ')).toContain('campo 6');
  });
  it('só o campo 4 (sem o 3) é erro explicado; só o anterior é aceito (PCE/FOMC sem projeção ainda)', () => {
    expect(buildFields('CPI', { ano: '3,1' }).error).toContain('campo 3');
    expect(buildFields('PCE', { anterior: '0,3' })).toEqual({ ok: true, fields: { previous: '+0,3% m/m' }, notes: [] });
    expect(buildFields('NFP', { anterior: '119' }).fields.previous).toBe('+119 mil');
  });
  it('anterior fora do formato do tipo é erro que diz o formato certo', () => {
    expect(buildFields('FOMC', { juros: '3,75', anterior: '3,75-4,00' }).error).toContain('juros atual em %');
    expect(buildFields('PCE', { mes: '0,2', anterior: 'muito' }).error).toContain('campo 7');
  });
  it('tipo desconhecido não passa', () => {
    expect(buildFields('PIB', { mes: '1,0' }).ok).toBe(false);
    expect(buildFields(undefined, { mes: '1,0' }).ok).toBe(false);
  });
});

describe('describeFomc: o que a taxa projetada implica contra a atual (conta, não previsão)', () => {
  it('corte, alta e manter', () => {
    expect(describeFomc('3,75%', '4,00%')).toBe('corte de 0,25 p.p. (de 4,00% para 3,75%)');
    expect(describeFomc('4,50%', '4,00%')).toBe('alta de 0,50 p.p. (de 4,00% para 4,50%)');
    expect(describeFomc('4,00%', '4,00%')).toBe('manter em 4,00%');
  });
  it('faltando um dos dois ou formato ruim: null', () => {
    expect(describeFomc('3,75%', null)).toBeNull();
    expect(describeFomc(null, '4,00%')).toBeNull();
    expect(describeFomc('manter', '4,00%')).toBeNull();
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
  it('setEntry ignora texto fora do formato fechado do tipo (nunca grava lixo)', () => {
    const r = setEntry({ version: 1, items: {} }, 'CPI-2026-12-10', { projection: 'vai ser alto' }, NOW);
    expect(r.items['CPI-2026-12-10']).toEqual({ at: ISO });
    expect(() => assertPublicConsensus(r)).toThrow(/consensus\.json/);
  });
  it('entradas com mais de 120 dias saem; o teto de entradas é respeitado', () => {
    const velho = new Date(NOW - CONSENSUS_KEEP_MS - 1000).toISOString();
    const lido = parseConsensus({ version: 1, items: { 'CPI-2026-01-13': { at: velho, projection: '+0,3% m/m' }, 'CPI-2026-12-10': { at: ISO, projection: '+0,3% m/m' } } }, NOW);
    expect(Object.keys(lido.items)).toEqual(['CPI-2026-12-10']);
    let st = { version: 1, items: {} };
    for (let i = 0; i < CONSENSUS_MAX_ENTRIES + 5; i += 1) st = setEntry(st, `CPI-2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}`, { projection: '+0,3% m/m' }, NOW + i);
    expect(Object.keys(st.items).length).toBeLessThanOrEqual(CONSENSUS_MAX_ENTRIES);
  });
  it('parseConsensus: arquivo vem de fora; lixo vira vazio e só a entrada ruim é descartada', () => {
    for (const x of [null, undefined, 7, 'x', [], {}, { version: 2, items: {} }, { version: 1, items: [] }]) expect(parseConsensus(x, NOW)).toEqual({ version: 1, items: {} });
    const lido = parseConsensus({
      version: 1,
      items: {
        'CPI-2026-12-10': { at: ISO, projection: '+0,3% m/m', extra: 'campo a mais' },
        'CPI-2026-12-11': { at: ISO, projection: 'texto livre' },
        'PIB-2026-12-10': { at: ISO, projection: '+0,3% m/m' },
        'FOMC-2026-12-09': { at: ISO, projection: '3,75%', previous: '4,00%' },
        'NFP-2026-12-04': { at: 'ontem', projection: '+150 mil' },
      },
    }, NOW);
    expect(Object.keys(lido.items)).toEqual(['CPI-2026-12-10', 'FOMC-2026-12-09']);
    expect(lido.items['CPI-2026-12-10']).toEqual({ at: ISO, projection: '+0,3% m/m' });
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
      e({ projection: '3,75%' }), // taxa do FOMC num tipo de inflação
      e({ at: 'ontem' }),
      e({ projection: undefined }),
      { version: 1, items: { 'cpi-2026-12-10': { at: ISO, projection: '+0,3% m/m' } } },
      { version: 1, items: { 'FOMC-2026-12-09': { at: ISO, projection: '+0,3% m/m' } } },
      { version: 1, items: { 'FOMC-2026-12-09': { at: ISO, previous: '99,00%' } } },
      { version: 1, items: Object.fromEntries(Array.from({ length: CONSENSUS_MAX_ENTRIES + 1 }, (_, i) => [`CPI-2026-${String((i % 12) + 1).padStart(2, '0')}-${String((i % 27) + 1).padStart(2, '0')}x`, { at: ISO, projection: '+0,3% m/m' }])) },
      null,
      [],
    ];
    for (const r of ruins) expect(() => assertPublicConsensus(r), JSON.stringify(r)?.slice(0, 80)).toThrow(/consensus\.json/);
  });
  it('isValidText confere o formato por tipo', () => {
    expect(isValidText('CPI', 'projection', '+0,3% m/m · +3,1% a/a')).toBe(true);
    expect(isValidText('NFP', 'projection', '+150 mil')).toBe(true);
    expect(isValidText('FOMC', 'projection', '3,75%')).toBe(true);
    expect(isValidText('FOMC', 'previous', '4,00%')).toBe(true);
    expect(isValidText('FOMC', 'previous', '30,00%')).toBe(false);
    expect(isValidText('FOMC', 'projection', 'manter')).toBe(false);
    expect(isValidText('CPI', 'projection', '3,75%')).toBe(false);
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
      { id: 'PCE-2026-12-23', kind: 'PCE', reference: '2026-11', startsAtUtc: '2026-12-23T13:30:00.000Z', status: 'oficial', firstSeenAt: ISO, lastChangedAt: ISO },
      { id: 'FOMC-2026-12-09', kind: 'FOMC', reference: '2026-12', startsAtUtc: '2026-12-09T19:00:00.000Z', status: 'oficial', firstSeenAt: ISO, lastChangedAt: ISO },
    ];
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(eventos));
    saida = [];
    logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { saida.push(a.join(' ')); });
  });
  afterEach(() => { logSpy.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); });
  const run = (argv) => { saida = []; return { code: main(argv, {}, { now: () => NOW }), texto: saida.join('\n') }; };
  const arquivo = () => path.join(dir, 'consensus.json');
  // Como o workflow chama: TODOS os campos, os vazios como "".
  const todos = (over) => {
    const f = { tipo: 'PCE', data: '', mes: '', ano: '', vagas: '', juros: '', anterior: '', ...over };
    return ['--dir', dir, '--tipo', f.tipo, '--data', f.data, '--mes', f.mes, '--ano', f.ano, '--vagas', f.vagas, '--juros', f.juros, '--anterior', f.anterior];
  };

  it('PCE (o teste pedido ao usuário): projeção e anterior do próximo PCE, no formato canônico, sem arquivo temporário', () => {
    const r = run(todos({ tipo: 'PCE', mes: '0,2', anterior: '0,3' }));
    expect(r.code).toBe(0);
    expect(r.texto).toContain('Registrado');
    expect(r.texto).toContain('PCE-2026-12-23');
    expect(JSON.parse(fs.readFileSync(arquivo(), 'utf8'))).toEqual({ version: 1, items: { 'PCE-2026-12-23': { at: ISO, projection: '+0,2% m/m', previous: '+0,3% m/m' } } });
    expect(fs.readdirSync(dir).sort()).toEqual(['consensus.json', 'events.json']);
  });
  it('REGRESSÃO: os campos vazios que o workflow manda como "" não atrapalham (o argumento vazio não "come" o próximo)', () => {
    const r = run(todos({ tipo: 'CPI', mes: '0,3', ano: '3,1' }));
    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(arquivo(), 'utf8')).items['CPI-2026-12-10'].projection).toBe('+0,3% m/m · +3,1% a/a');
  });
  it('FOMC: taxa esperada e atual; a saída diz o que isso significa (corte de 0,25 p.p.)', () => {
    const r = run(todos({ tipo: 'FOMC', juros: '3,75', anterior: '4,00' }));
    expect(r.code).toBe(0);
    expect(r.texto).toContain('corte de 0,25 p.p.');
    expect(JSON.parse(fs.readFileSync(arquivo(), 'utf8')).items['FOMC-2026-12-09']).toEqual({ at: ISO, projection: '3,75%', previous: '4,00%' });
  });
  it('campo de outro tipo: grava o que é do tipo e AVISA o que ignorou', () => {
    const r = run(todos({ tipo: 'PCE', mes: '0,2', vagas: '150' }));
    expect(r.code).toBe(0);
    expect(r.texto).toContain('campo 5');
    expect(r.texto).toContain('ignorado');
  });
  it('REGRESSÃO (19/11): os dois testes do usuário saem com 1, sem gravar, e explicam qual campo preencher', () => {
    const colado = run(todos({ tipo: 'CPI', mes: '0,3 / 3,1. 150. manter', anterior: '3,75-4,00' }));
    expect(colado.code).toBe(1);
    expect(colado.texto).toContain('campo 3');
    expect(colado.texto).toContain('Como preencher');
    const vazio = run(todos({ tipo: 'CPI' }));
    expect(vazio.code).toBe(1);
    expect(vazio.texto).toContain('preencha o campo 3');
    expect(fs.existsSync(arquivo())).toBe(false);
  });
  it('entrada ruim: NÃO grava nada e sai com 1 (para cada tipo de erro)', () => {
    const casos = [
      todos({ tipo: 'FOMC', juros: 'manter' }),
      todos({ tipo: 'FOMC', juros: '3,75', anterior: '3,75-4,00' }),
      todos({ tipo: 'NFP', vagas: '150' }), // não há próximo Payroll na agenda deste teste
      todos({ tipo: 'CPI', data: '2026-12-11', mes: '0,3' }),
      todos({ tipo: 'XYZ', mes: '0,3' }),
    ];
    for (const caso of casos) {
      const r = run(caso);
      expect(r.code, caso.join(' ')).toBe(1);
      expect(r.texto).toContain('Não gravei nada');
    }
    expect(fs.existsSync(arquivo())).toBe(false);
  });
  it('rodar de novo atualiza sem apagar o outro campo', () => {
    expect(run(todos({ tipo: 'PCE', anterior: '0,3' })).code).toBe(0);
    expect(run(todos({ tipo: 'PCE', mes: '0,2' })).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(arquivo(), 'utf8')).items['PCE-2026-12-23']).toEqual({ at: ISO, projection: '+0,2% m/m', previous: '+0,3% m/m' });
  });
  it('sem agenda legível ou sem --dir: sai com 1 sem gravar', () => {
    fs.writeFileSync(path.join(dir, 'events.json'), 'não é json');
    expect(run(todos({ tipo: 'CPI', mes: '0,3' })).code).toBe(1);
    expect(run(['--tipo', 'CPI', '--mes', '0,3']).code).toBe(1);
    expect(fs.existsSync(arquivo())).toBe(false);
  });
  it('arquivo anterior ilegível é tratado como vazio', () => {
    fs.writeFileSync(arquivo(), '{ lixo');
    expect(run(todos({ tipo: 'CPI', mes: '0,3' })).code).toBe(0);
    expect(JSON.parse(fs.readFileSync(arquivo(), 'utf8')).version).toBe(1);
  });
});
