// Item 285, addendum 14 — o "Anterior" dos números oficiais (BLS). Rede toda simulada. O que se prova: as contas (variação no mês e em 12 meses,
// vagas do Payroll) batem com a mão e com o período CERTO (o anterior ao `reference`); dado faltando ou fora de faixa faz a parte do número SUMIR
// (nunca se preenche); a chave recusada cai na versão sem chave sem gastar consulta; e a chave NUNCA aparece no resultado, nem numa falha.
import { describe, it, expect } from 'vitest';
import {
  BLS_SERIES, BLS_SOURCE, BLS_V1, BLS_V2, PREVIOUS_TEXT_RE, allSeriesIds, parseBlsSeries, shiftMonth, formatPct, formatJobs,
  previousValueText, previousValues, fetchBlsSeries,
} from './contextBls.mjs';
import { MAX_BODY_BYTES } from './contextProbe.mjs';

const KEY = 'k3y0123456789abcdef0123456789abcd';

/** Resposta do BLS no formato real (v1/v2): mais recente primeiro, `value` como texto. */
const resposta = (seriesID, pontos) => JSON.stringify({
  status: 'REQUEST_SUCCEEDED',
  responseTime: 12,
  message: [],
  Results: {
    series: [{
      seriesID,
      data: pontos.map(([year, period, value], i) => ({ year, period, periodName: period, latest: i === 0 ? 'true' : undefined, value, footnotes: [{}] })),
    }],
  },
});
const mapa = (pontos) => new Map(pontos);

// Séries de teste (valores escolhidos para dar contas redondas):
//   CPI (com ajuste)  : ago/26 100,000 → set/26 100,300  = +0,3 % no mês
//   CPI (sem ajuste)  : set/25 100,000 → set/26 103,000  = +3,0 % em 12 meses
//   PPI (com ajuste)  : ago/26 150,0   → set/26 149,7    = -0,2 % no mês
//   PPI (sem ajuste)  : set/25 148,0   → set/26 150,96   = +2,0 % em 12 meses
//   Payroll (mil)     : ago/26 159.000 → set/26 159.119  = +119 mil
const SERIES = {
  CUSR0000SA0: mapa([['2026-09', 100.3], ['2026-08', 100]]),
  CUUR0000SA0: mapa([['2026-09', 103], ['2025-09', 100]]),
  WPSFD4: mapa([['2026-09', 149.7], ['2026-08', 150]]),
  WPUFD4: mapa([['2026-09', 150.96], ['2025-09', 148]]),
  CES0000000001: mapa([['2026-09', 159119], ['2026-08', 159000]]),
};

describe('séries e formato', () => {
  it('as séries por tipo e a lista de códigos (sem repetir)', () => {
    expect(BLS_SERIES.CPI).toEqual({ month: 'CUSR0000SA0', year: 'CUUR0000SA0' });
    expect(BLS_SERIES.PPI).toEqual({ month: 'WPSFD4', year: 'WPUFD4' });
    expect(BLS_SERIES.NFP).toEqual({ jobs: 'CES0000000001' });
    expect(allSeriesIds().sort()).toEqual(['CES0000000001', 'CUSR0000SA0', 'CUUR0000SA0', 'WPSFD4', 'WPUFD4']);
    expect(BLS_SOURCE).toBe('BLS');
  });

  it('shiftMonth atravessa o ano nos dois sentidos', () => {
    expect(shiftMonth('2026-10', -1)).toBe('2026-09');
    expect(shiftMonth('2026-01', -1)).toBe('2025-12');
    expect(shiftMonth('2026-12', 1)).toBe('2027-01');
    expect(shiftMonth('2026-09', -12)).toBe('2025-09');
    expect(shiftMonth('2027-01', -13)).toBe('2025-12');
  });

  it('formatPct: 1 casa, vírgula, sinal, meio para longe do zero, nunca "-0,0%"', () => {
    expect(formatPct(0.3)).toBe('+0,3%');
    expect(formatPct(-0.2)).toBe('-0,2%');
    expect(formatPct(3)).toBe('+3,0%');
    expect(formatPct(0)).toBe('0,0%');
    expect(formatPct(-0.04)).toBe('0,0%');
    expect(formatPct(0.04)).toBe('0,0%');
    expect(formatPct(0.25)).toBe('+0,3%');
    expect(formatPct(-0.25)).toBe('-0,3%');
    expect(formatPct((100.25 / 100 - 1) * 100)).toBe('+0,3%'); // ponto flutuante dá 0,24999999999998
    expect(formatPct(12.34)).toBe('+12,3%');
  });

  it('formatJobs: milhares com ponto, sinal, zero sem sinal', () => {
    expect(formatJobs(119)).toBe('+119 mil');
    expect(formatJobs(-92)).toBe('-92 mil');
    expect(formatJobs(1234)).toBe('+1.234 mil');
    expect(formatJobs(0)).toBe('0 mil');
    expect(formatJobs(118.6)).toBe('+119 mil');
  });

  it('o regex público aceita só os formatos produzidos e recusa texto livre', () => {
    for (const ok of ['+0,3% m/m', '+3,0% a/a', '+0,3% m/m · +3,0% a/a', '-0,2% m/m · +2,0% a/a', '0,0% m/m', '+119 mil', '-92 mil', '+1.234 mil', '0 mil', '+12,3% m/m · +30,0% a/a']) {
      expect(PREVIOUS_TEXT_RE.test(ok), ok).toBe(true);
    }
    for (const ruim of ['', '+0,3%', '+0.3% m/m', 'https://api.bls.gov/x', 'a/a', '+0,3% a/a · +3,0% a/a', '+0,3% m/m · +3,0% m/m', 'CPI subiu', '+119', '+119 mil\nx', '+0,3% m/m · +3,0% a/a · +1,0% a/a', '+1234 mil']) {
      expect(PREVIOUS_TEXT_RE.test(ruim), JSON.stringify(ruim)).toBe(false);
    }
  });
});

describe('leitura da resposta do BLS', () => {
  it('lê os meses (M01–M12) com valor numérico e ignora a média anual (M13) e "-"', () => {
    const r = parseBlsSeries(resposta('CUSR0000SA0', [['2026', 'M09', '100.300'], ['2026', 'M13', '99.000'], ['2026', 'M08', '-'], ['2026', 'M07', '99.500']]), 'CUSR0000SA0');
    expect(r.reason).toBe('ok');
    expect([...r.values.entries()]).toEqual([['2026-09', 100.3], ['2026-07', 99.5]]);
  });
  it('mês repetido vale o primeiro; valor com vírgula não é número (não vira 15 em silêncio)', () => {
    const r = parseBlsSeries(resposta('X', [['2026', 'M09', '1.5'], ['2026', 'M09', '2.5'], ['2026', 'M08', '1,5']]), 'X');
    expect([...r.values.entries()]).toEqual([['2026-09', 1.5]]);
  });
  it('chave recusada: reconhece a mensagem REAL que o BLS devolveu à sonda', () => {
    const corpo = JSON.stringify({ status: 'REQUEST_NOT_PROCESSED', responseTime: 0, message: ['The key:*** provided by the User is invalid. Please provide a proper key for the operation to be successful'], Results: {} });
    expect(parseBlsSeries(corpo, 'CUSR0000SA0')).toEqual({ values: null, reason: 'key_rejected' });
  });
  it('limite diário e outros erros do BLS', () => {
    const limite = JSON.stringify({ status: 'REQUEST_NOT_PROCESSED', message: ['Request could not be serviced, as the daily threshold for total number of requests allocated to the user has been reached.'] });
    expect(parseBlsSeries(limite, 'X')).toEqual({ values: null, reason: 'limit' });
    expect(parseBlsSeries(JSON.stringify({ status: 'REQUEST_NOT_PROCESSED', message: ['No Data Available for Series X Year: 2026'] }), 'X').reason).toBe('format');
  });
  it('corpo que não serve: não é JSON, outra série, sem dados, sem meses válidos', () => {
    expect(parseBlsSeries('<html>erro</html>', 'X').reason).toBe('format');
    expect(parseBlsSeries('null', 'X').reason).toBe('format');
    expect(parseBlsSeries(resposta('OUTRA', [['2026', 'M09', '1']]), 'X').reason).toBe('format');
    expect(parseBlsSeries(resposta('X', []), 'X').reason).toBe('no_data');
    expect(parseBlsSeries(resposta('X', [['2026', 'M13', '1'], ['26', 'M09', '1'], ['2026', 'M09', '-']]), 'X').reason).toBe('no_data');
    expect(parseBlsSeries(undefined, 'X').reason).toBe('format');
  });
});

describe('o "Anterior" de cada tipo (contas à mão, período certo)', () => {
  it('CPI de 10/11 (mede outubro): Anterior = setembro → +0,3% no mês e +3,0% em 12 meses', () => {
    expect(previousValueText('CPI', SERIES, '2026-10')).toBe('+0,3% m/m · +3,0% a/a');
  });
  it('PPI: -0,2% no mês e +2,0% em 12 meses', () => {
    expect(previousValueText('PPI', SERIES, '2026-10')).toBe('-0,2% m/m · +2,0% a/a');
  });
  it('Payroll de 06/11 (mede outubro): Anterior = variação de setembro → +119 mil; queda vira "-92 mil"', () => {
    expect(previousValueText('NFP', SERIES, '2026-10')).toBe('+119 mil');
    expect(previousValueText('NFP', { ...SERIES, CES0000000001: mapa([['2026-09', 158908], ['2026-08', 159000]]) }, '2026-10')).toBe('-92 mil');
  });
  it('usa o período ANTERIOR ao `reference`, não o último que a API tem (depois da divulgação a API já traz o mês novo)', () => {
    const comOutubro = { ...SERIES, CUSR0000SA0: mapa([['2026-10', 101.3], ['2026-09', 100.3], ['2026-08', 100]]), CUUR0000SA0: mapa([['2026-10', 105], ['2026-09', 103], ['2025-09', 100], ['2025-10', 100]]) };
    expect(previousValueText('CPI', comOutubro, '2026-10')).toBe('+0,3% m/m · +3,0% a/a'); // continua setembro
    expect(previousValueText('CPI', comOutubro, '2026-11')).toBe('+1,0% m/m · +5,0% a/a'); // para novembro o anterior é outubro
  });
  it('virada de ano: reference 2027-01 → anterior é dezembro/26', () => {
    const s = { CES0000000001: mapa([['2026-12', 160500], ['2026-11', 160400]]) };
    expect(previousValueText('NFP', s, '2027-01')).toBe('+100 mil');
  });

  it('dado faltando: a parte do número SOME; sem nenhuma parte, o Anterior não existe', () => {
    const semAgo = { ...SERIES, CUSR0000SA0: mapa([['2026-09', 100.3]]) };
    expect(previousValueText('CPI', semAgo, '2026-10')).toBe('+3,0% a/a');
    const semSet25 = { ...SERIES, CUUR0000SA0: mapa([['2026-09', 103]]) };
    expect(previousValueText('CPI', semSet25, '2026-10')).toBe('+0,3% m/m');
    expect(previousValueText('CPI', { ...semAgo, CUUR0000SA0: mapa([['2026-09', 103]]) }, '2026-10')).toBeNull();
    expect(previousValueText('CPI', { CUSR0000SA0: null, CUUR0000SA0: null }, '2026-10')).toBeNull();
    expect(previousValueText('NFP', { CES0000000001: mapa([['2026-09', 159119]]) }, '2026-10')).toBeNull();
    expect(previousValueText('CPI', {}, '2026-10')).toBeNull();
    expect(previousValueText('CPI', undefined, '2026-10')).toBeNull();
  });
  it('sem `reference` válido, ou tipo sem série (PCE, FOMC): nada', () => {
    for (const ref of [null, undefined, '', '2026-13', '2026-00', '2026-9', 'set/26']) expect(previousValueText('CPI', SERIES, ref), String(ref)).toBeNull();
    expect(previousValueText('PCE', SERIES, '2026-10')).toBeNull();
    expect(previousValueText('FOMC', SERIES, '2026-12')).toBeNull();
  });
  it('número fora de faixa plausível é descartado (série errada / dado corrompido)', () => {
    const mesAlto = { ...SERIES, CUSR0000SA0: mapa([['2026-09', 110.1], ['2026-08', 100]]) }; // +10,1 % no mês
    expect(previousValueText('CPI', mesAlto, '2026-10')).toBe('+3,0% a/a');
    const anoAlto = { ...SERIES, CUUR0000SA0: mapa([['2026-09', 140], ['2025-09', 100]]) }; // +40 % em 12 meses
    expect(previousValueText('CPI', anoAlto, '2026-10')).toBe('+0,3% m/m');
    expect(previousValueText('NFP', { CES0000000001: mapa([['2026-09', 163000], ['2026-08', 159000]]) }, '2026-10')).toBeNull(); // +4.000 mil
    expect(previousValueText('CPI', { CUSR0000SA0: mapa([['2026-09', 1], ['2026-08', 0]]), CUUR0000SA0: mapa([['2026-09', 1], ['2025-09', 0]]) }, '2026-10')).toBeNull(); // divisão por zero
  });
  it('todo texto produzido passa no regex público (e é curto o bastante para a faixa: 24 caracteres)', () => {
    for (const [kind, ref] of [['CPI', '2026-10'], ['PPI', '2026-10'], ['NFP', '2026-10']]) {
      const t = previousValueText(kind, SERIES, ref);
      expect(PREVIOUS_TEXT_RE.test(t), t).toBe(true);
      expect(t.length).toBeLessThanOrEqual(24);
    }
  });
  it('previousValues devolve o objeto público { previous, source: "BLS" } ou null', () => {
    expect(previousValues('NFP', SERIES, '2026-10')).toEqual({ previous: '+119 mil', source: 'BLS' });
    expect(previousValues('NFP', {}, '2026-10')).toBeNull();
  });
});

describe('busca no BLS (v2 com chave, v1 sem chave)', () => {
  /** fetch de mentira: devolve a série pedida (pela URL) com os dados de SERIES; `modo` muda o comportamento por versão. */
  function fakeFetch({ v2 = 'ok', v1 = 'ok' } = {}) {
    const calls = [];
    const impl = async (url, opts) => {
      calls.push({ url, headers: opts?.headers });
      const versao = url.startsWith(BLS_V2) ? 'v2' : 'v1';
      const modo = versao === 'v2' ? v2 : v1;
      const id = url.slice(url.lastIndexOf('/') + 1).split('?')[0];
      if (modo === 'rede') throw new Error(`falha de rede em ${url}`); // a mensagem cita a URL (e a chave)
      if (modo === 'http500') return new Response('x', { status: 500 });
      if (modo === 'chave') return new Response(JSON.stringify({ status: 'REQUEST_NOT_PROCESSED', message: ['The key:*** provided by the User is invalid. Please provide a proper key for the operation to be successful'] }), { status: 200 });
      if (modo === 'limite') return new Response(JSON.stringify({ status: 'REQUEST_NOT_PROCESSED', message: ['Request could not be serviced, as the daily threshold for total number of requests allocated to the user has been reached.'] }), { status: 200 });
      if (modo === 'lixo') return new Response('<html>', { status: 200 });
      const dados = [...SERIES[id].entries()].map(([ym, v]) => [ym.slice(0, 4), `M${ym.slice(5)}`, String(v)]);
      return new Response(resposta(id, dados), { status: 200 });
    };
    return { impl, calls };
  }

  it('sem chave: só a v1, 1 consulta por série, nenhuma URL com chave', async () => {
    const f = fakeFetch();
    const r = await fetchBlsSeries({ fetchImpl: f.impl, env: {} });
    expect(f.calls).toHaveLength(5);
    expect(f.calls.every((c) => c.url.startsWith(BLS_V1) && !/registrationkey/i.test(c.url))).toBe(true);
    expect(r.tally).toEqual({ v2: 0, v1: 5, failed: 0 });
    expect(r).toMatchObject({ keyPresent: false, keyRejected: false, limitHit: false });
    expect(r.series.CES0000000001.get('2026-09')).toBe(159119);
  });
  it('com chave válida: só a v2 (a chave na URL), sem gastar a v1', async () => {
    const f = fakeFetch();
    const r = await fetchBlsSeries({ fetchImpl: f.impl, env: { BLS_API_KEY: KEY } });
    expect(f.calls).toHaveLength(5);
    expect(f.calls.every((c) => c.url.startsWith(BLS_V2) && c.url.endsWith(`?registrationkey=${KEY}`))).toBe(true);
    expect(r.tally).toEqual({ v2: 5, v1: 0, failed: 0 });
    expect(r).toMatchObject({ keyPresent: true, keyRejected: false });
  });
  it('chave com espaço ou quebra de linha nas pontas (erro comum de cópia) é limpa antes de usar', async () => {
    const f = fakeFetch();
    await fetchBlsSeries({ fetchImpl: f.impl, env: { BLS_API_KEY: `  ${KEY}\n` }, ids: ['CES0000000001'] });
    expect(f.calls[0].url).toBe(`${BLS_V2}/CES0000000001?registrationkey=${KEY}`);
  });
  it('chave RECUSADA: tenta a v2 uma vez só, e todas as séries vêm da v1', async () => {
    const f = fakeFetch({ v2: 'chave' });
    const r = await fetchBlsSeries({ fetchImpl: f.impl, env: { BLS_API_KEY: KEY } });
    expect(f.calls.filter((c) => c.url.startsWith(BLS_V2))).toHaveLength(1);
    expect(f.calls.filter((c) => c.url.startsWith(BLS_V1))).toHaveLength(5);
    expect(r.tally).toEqual({ v2: 0, v1: 5, failed: 0 });
    expect(r.keyRejected).toBe(true);
    expect(r.series.CUSR0000SA0.get('2026-09')).toBe(100.3);
  });
  it('falha de uma série na v2 (rede, HTTP, corpo ruim) cai na v1 só para ela; a chave segue valendo para as outras', async () => {
    for (const modo of ['rede', 'http500', 'lixo']) {
      const f = fakeFetch({ v2: modo });
      const r = await fetchBlsSeries({ fetchImpl: f.impl, env: { BLS_API_KEY: KEY } });
      expect(f.calls.filter((c) => c.url.startsWith(BLS_V2)), modo).toHaveLength(5); // não é "chave recusada": tenta a v2 em todas
      expect(r.tally, modo).toEqual({ v2: 0, v1: 5, failed: 0 });
      expect(r.keyRejected, modo).toBe(false);
    }
  });
  it('tudo falha: séries nulas, contagem de falhas, NADA lançado', async () => {
    const f = fakeFetch({ v2: 'rede', v1: 'rede' });
    const r = await fetchBlsSeries({ fetchImpl: f.impl, env: { BLS_API_KEY: KEY } });
    expect(Object.values(r.series).every((v) => v === null)).toBe(true);
    expect(r.tally).toEqual({ v2: 0, v1: 0, failed: 5 });
    expect(previousValueText('CPI', r.series, '2026-10')).toBeNull();
  });
  it('limite diário do BLS é sinalizado', async () => {
    const r = await fetchBlsSeries({ fetchImpl: fakeFetch({ v1: 'limite' }).impl, env: {} });
    expect(r.limitHit).toBe(true);
    expect(r.tally.failed).toBe(5);
  });
  it('SEGREDO: a chave nunca aparece no resultado — nem com chave recusada, nem com falha de rede que cita a URL', async () => {
    for (const cfg of [{ v2: 'ok' }, { v2: 'chave' }, { v2: 'rede', v1: 'rede' }, { v2: 'http500', v1: 'lixo' }]) {
      const r = await fetchBlsSeries({ fetchImpl: fakeFetch(cfg).impl, env: { BLS_API_KEY: KEY } });
      const texto = JSON.stringify(r, (_k, v) => (v instanceof Map ? [...v.entries()] : v));
      expect(texto, JSON.stringify(cfg)).not.toContain(KEY);
      expect(texto, JSON.stringify(cfg)).not.toMatch(/registrationkey|https?:\/\//i);
    }
  });
  it('a chave é codificada na URL: caractere especial não quebra a consulta nem injeta parâmetro', async () => {
    const f = fakeFetch();
    await fetchBlsSeries({ fetchImpl: f.impl, env: { BLS_API_KEY: ' ab&c=d \n' }, ids: ['WPSFD4'] });
    expect(f.calls[0].url).toBe(`${BLS_V2}/WPSFD4?registrationkey=ab%26c%3Dd`);
  });
  it('HTTP de erro ou corpo grande demais é recusado mesmo que o corpo seja um JSON válido', async () => {
    const valido = resposta('CES0000000001', [['2026', 'M09', '159119'], ['2026', 'M08', '159000']]);
    expect(parseBlsSeries(valido, 'CES0000000001').reason).toBe('ok'); // o corpo, sozinho, serviria
    for (const [status, corpo] of [[500, valido], [403, valido], [200, `${valido}${' '.repeat(MAX_BODY_BYTES + 1)}`]]) {
      const r = await fetchBlsSeries({ fetchImpl: async () => new Response(corpo, { status }), env: {}, ids: ['CES0000000001'] });
      expect(r.series.CES0000000001, String(status)).toBeNull();
      expect(r.tally.failed, String(status)).toBe(1);
    }
  });
  it('envia o contato do robô no User-Agent (o BLS bloqueia robô anônimo)', async () => {
    const f = fakeFetch();
    await fetchBlsSeries({ fetchImpl: f.impl, env: { CONTEXT_CONTACT_EMAIL: 'robo@exemplo.com' }, ids: ['WPSFD4'] });
    expect(String(f.calls[0].headers['User-Agent'])).toContain('robo@exemplo.com');
  });
});

// Addendum 21 (base própria do BLS): a linha "-" que o BLS devolve para um mês que NUNCA foi publicado (ex.: outubro de 2025, paralisação do governo
// dos EUA) vira uma LACUNA OFICIAL com o motivo em lista fechada. O texto do BLS nunca é guardado nem publicado: só o código do motivo.
describe('lacunas oficiais (linha "-" do BLS)', () => {
  const comNotas = (seriesID, linhas) => JSON.stringify({ status: 'REQUEST_SUCCEEDED', message: [], Results: { series: [{ seriesID, data: linhas }] } });
  const linha = (year, period, value, footnotes = [{}]) => ({ year, period, periodName: period, value, footnotes });
  const SHUTDOWN = [{ code: 'X', text: 'Data unavailable due to the 2025 lapse in appropriations.' }];

  it('"-" vira lacuna com o motivo da nota de rodapé: paralisação de 2025, ou "não divulgado" sem nota', () => {
    const r = parseBlsSeries(comNotas('CUUR0000SA0', [
      linha('2026', 'M09', '103.000'),
      linha('2025', 'M10', '-', SHUTDOWN),
      linha('2025', 'M05', '-'),
      linha('2025', 'M09', '100.000'),
    ]), 'CUUR0000SA0');
    expect([...r.gaps.entries()]).toEqual([['2025-10', 'paralisacao_2025'], ['2025-05', 'nao_divulgado']]);
    expect([...r.values.keys()]).toEqual(['2026-09', '2025-09']);
    expect(r.reason).toBe('ok');
  });

  it('só o CÓDIGO do motivo sai do parser: o texto do BLS nunca é guardado (nem outra nota vira motivo)', () => {
    const r = parseBlsSeries(comNotas('X', [
      linha('2025', 'M10', '-', [{ code: 'P', text: 'Preliminary. All indexes are subject to revision.' }]),
      linha('2025', 'M11', '-', [{ code: 'S', text: 'federal government SHUTDOWN, see https://exemplo.invalido/?k=segredo' }]),
    ]), 'X');
    expect([...r.gaps.values()].sort()).toEqual(['nao_divulgado', 'paralisacao_2025']);
    expect(JSON.stringify([...r.gaps.entries()])).not.toMatch(/segredo|https?:|Preliminary/);
  });

  it('valor corrompido ("1,5"), a média anual (M13) e mês mal formado NÃO são lacuna', () => {
    const r = parseBlsSeries(comNotas('X', [linha('2026', 'M09', '1.5'), linha('2026', 'M08', '1,5'), linha('2026', 'M13', '-'), linha('26', 'M07', '-'), linha('2026', 'M06', '')]), 'X');
    expect(r.gaps).toBeNull();
  });

  it('mês com valor E com "-" (resposta incoerente): o valor vence, não há lacuna', () => {
    const r = parseBlsSeries(comNotas('X', [linha('2025', 'M10', '-', SHUTDOWN), linha('2025', 'M10', '100.000')]), 'X');
    expect([...r.values.entries()]).toEqual([['2025-10', 100]]);
    expect(r.gaps).toBeNull();
  });

  it('só lacunas, nenhum valor: continua "sem dados", mas as lacunas vêm junto', () => {
    const r = parseBlsSeries(comNotas('X', [linha('2025', 'M10', '-', SHUTDOWN)]), 'X');
    expect(r.values).toBeNull();
    expect(r.reason).toBe('no_data');
    expect([...r.gaps.entries()]).toEqual([['2025-10', 'paralisacao_2025']]);
  });

  it('sem nenhuma linha "-": `gaps` é null (e os erros do BLS seguem com o formato de antes)', () => {
    expect(parseBlsSeries(resposta('X', [['2026', 'M09', '1.5']]), 'X').gaps).toBeNull();
    expect(parseBlsSeries('lixo', 'X')).toEqual({ values: null, reason: 'format' });
  });

  it('fetchBlsSeries devolve as lacunas por série (v2 e v1), null onde não há, e a chave não vaza', async () => {
    const corpo = (id) => (id === 'CUUR0000SA0'
      ? comNotas(id, [linha('2026', 'M10', '104.000'), linha('2025', 'M10', '-', SHUTDOWN), linha('2025', 'M09', '100.000')])
      : resposta(id, [['2026', 'M09', '1.5']]));
    const impl = async (url) => new Response(corpo(url.slice(url.lastIndexOf('/') + 1).split('?')[0]), { status: 200 });
    for (const env of [{ BLS_API_KEY: KEY }, {}]) {
      const r = await fetchBlsSeries({ fetchImpl: impl, env });
      expect([...r.gaps.CUUR0000SA0.entries()]).toEqual([['2025-10', 'paralisacao_2025']]);
      for (const id of allSeriesIds().filter((x) => x !== 'CUUR0000SA0')) expect(r.gaps[id], id).toBeNull();
      expect(JSON.stringify([...r.gaps.CUUR0000SA0])).not.toContain(KEY);
    }
    const falha = await fetchBlsSeries({ fetchImpl: async () => new Response('x', { status: 500 }), env: {} });
    for (const id of allSeriesIds()) expect(falha.gaps[id], id).toBeNull();
  });
});
