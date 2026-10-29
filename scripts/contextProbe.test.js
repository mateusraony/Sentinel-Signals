// Item 285 — a sonda das fontes. Rede toda simulada: o que se prova aqui é que
// a sonda NÃO aprova resposta ruim (página de erro com status 200, arquivo
// cortado, 429, bloqueio regional, timeout) e que o portão da fase só abre
// quando as fontes obrigatórias realmente respondem bem.
import { describe, it, expect } from 'vitest';
import {
  SOURCES, USER_AGENT, SITE_ORIGIN, evaluateResponse, probeSource, summarize, formatProbeMarkdown,
  validateIcs, validateFearGreed, validateRss, validateBinanceTicker, validateRawGithubCors,
  validateDefillamaChains, validateHtmlContains, extractRateLimit, contactEmail, buildUserAgent,
  collectIsoDates, validateFinanceCalendar, validateFredRelease, validateFredDates,
} from './contextProbe.mjs';

const src = (id) => SOURCES.find((s) => s.id === id);

const ICS_OK = 'BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nSUMMARY:CPI\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nSUMMARY:Jobs\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n';
const RSS_OK = '<?xml version="1.0"?><rss version="2.0"><channel><item><title>x</title></item></channel></rss>';
const FNG_OK = JSON.stringify({ data: [{ value: '34', value_classification: 'Fear', timestamp: '1788000000' }] });
const TICKER_OK = JSON.stringify([{ symbol: 'BTCUSDT', price: '70000.10' }, { symbol: 'ETHUSDT', price: '3500.50' }]);
const HTML_ERROR = '<!doctype html><html><body>Access Denied</body></html>';

describe('validadores de formato', () => {
  it('ICS: aceita o bom e reprova página de erro, arquivo cortado e calendário vazio', () => {
    expect(validateIcs({ body: ICS_OK })).toEqual({ ok: true, detail: '2 eventos' });
    expect(validateIcs({ body: HTML_ERROR }).ok).toBe(false);
    expect(validateIcs({ body: ICS_OK.slice(0, 60) }).detail).toMatch(/cortado/);
    expect(validateIcs({ body: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR' }).detail).toMatch(/sem nenhum evento/);
  });

  it('Medo e Ganância: exige valor 0..100 e timestamp', () => {
    expect(validateFearGreed({ body: FNG_OK }).ok).toBe(true);
    expect(validateFearGreed({ body: HTML_ERROR }).ok).toBe(false);
    expect(validateFearGreed({ body: JSON.stringify({ data: [{ value: '250', timestamp: '1' }] }) }).ok).toBe(false);
    expect(validateFearGreed({ body: JSON.stringify({ data: [] }) }).ok).toBe(false);
    expect(validateFearGreed({ body: JSON.stringify({ data: [{ value: '34' }] }) }).ok).toBe(false);
  });

  it('RSS: reprova HTML, feed cortado e feed sem itens', () => {
    expect(validateRss({ body: RSS_OK }).ok).toBe(true);
    expect(validateRss({ body: HTML_ERROR }).ok).toBe(false);
    expect(validateRss({ body: RSS_OK.slice(0, 50) }).detail).toMatch(/cortado/);
    expect(validateRss({ body: '<?xml version="1.0"?><rss><channel></channel></rss>' }).detail).toMatch(/sem nenhum item/);
  });

  it('Binance: exige as duas moedas com preço positivo', () => {
    expect(validateBinanceTicker({ body: TICKER_OK }).ok).toBe(true);
    expect(validateBinanceTicker({ body: JSON.stringify([{ symbol: 'BTCUSDT', price: '1' }]) }).ok).toBe(false);
    expect(validateBinanceTicker({ body: JSON.stringify([{ symbol: 'BTCUSDT', price: '0' }, { symbol: 'ETHUSDT', price: '1' }]) }).ok).toBe(false);
    expect(validateBinanceTicker({ body: JSON.stringify({ code: -1121, msg: 'Invalid symbol.' }) }).ok).toBe(false);
  });

  it('CORS do GitHub raw: libera o site (ou *) e mostra o cache; sem cabeçalho reprova', () => {
    expect(validateRawGithubCors({ headers: { 'access-control-allow-origin': '*', 'cache-control': 'max-age=300' } })).toEqual({ ok: true, detail: 'CORS *; max-age=300' });
    expect(validateRawGithubCors({ headers: { 'access-control-allow-origin': SITE_ORIGIN } }).ok).toBe(true);
    expect(validateRawGithubCors({ headers: {} }).ok).toBe(false);
    expect(validateRawGithubCors({ headers: { 'access-control-allow-origin': 'https://outro.site' } }).ok).toBe(false);
  });

  it('DefiLlama e páginas: número positivo / texto esperado', () => {
    const chains = JSON.stringify([{ name: 'Solana', tvl: 9e9 }, { name: 'Ethereum', tvl: 65e9 }]);
    expect(validateDefillamaChains({ body: chains }).ok).toBe(true);
    expect(validateDefillamaChains({ body: '' }).ok).toBe(false); // o caso real: 200 com corpo vazio
    expect(validateDefillamaChains({ body: JSON.stringify([{ name: 'Solana', tvl: 1 }]) }).ok).toBe(false);
    expect(validateDefillamaChains({ body: JSON.stringify([{ name: 'Ethereum', tvl: 0 }]) }).ok).toBe(false);
    expect(validateHtmlContains('FOMC', '2026')({ body: 'FOMC calendar 2026' }).ok).toBe(true);
    expect(validateHtmlContains('FOMC', '2026')({ body: 'nada' }).ok).toBe(false);
  });
});

describe('evaluateResponse: o que a sonda NÃO aprova', () => {
  const bls = src('bls-calendar');

  it('200 com página de erro dentro reprova (o caso mais traiçoeiro)', () => {
    const r = evaluateResponse(bls, { status: 200, headers: {}, body: HTML_ERROR });
    expect(r.status).toBe('FALHOU');
    expect(r.detail).toMatch(/formato inválido/);
  });

  it('429 diz que é limite de uso e mostra o Retry-After', () => {
    const r = evaluateResponse(bls, { status: 429, headers: { 'retry-after': '60' }, body: '' });
    expect(r.status).toBe('FALHOU');
    expect(r.detail).toMatch(/429/);
    expect(r.detail).toMatch(/60/);
  });

  it('451 e 403 são bloqueio da origem, não "erro de formato"', () => {
    for (const status of [451, 403]) {
      const r = evaluateResponse(bls, { status, headers: {}, body: '' });
      expect(r.detail).toMatch(/bloqueado/);
    }
  });

  it('500 reprova; 200 com conteúdo bom aprova', () => {
    expect(evaluateResponse(bls, { status: 500, headers: {}, body: ICS_OK }).status).toBe('FALHOU');
    expect(evaluateResponse(bls, { status: 200, headers: {}, body: ICS_OK }).status).toBe('OK');
  });
});

describe('probeSource: rede injetada', () => {
  const okFetch = (body, init = {}) => async () => new Response(body, { status: 200, ...init });

  it('manda User-Agent identificado e devolve tempo e bytes', async () => {
    let seen;
    const fetchImpl = async (url, opts) => { seen = opts.headers; return new Response(ICS_OK, { status: 200 }); };
    let t = 1000;
    const r = await probeSource(src('bls-calendar'), { fetchImpl, now: () => (t += 25) });
    expect(seen['User-Agent']).toBe(USER_AGENT);
    expect(r.status).toBe('OK');
    expect(r.latencyMs).toBe(25);
    expect(r.bytes).toBe(Buffer.byteLength(ICS_OK));
  });

  it('o teste de CORS manda o Origin do site e lê o cabeçalho da resposta', async () => {
    let seen;
    const fetchImpl = async (url, opts) => {
      seen = opts.headers;
      return new Response('# Sentinel Signals', { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=300' } });
    };
    const r = await probeSource(src('raw-github-cors'), { fetchImpl });
    expect(seen.Origin).toBe(SITE_ORIGIN);
    expect(r.status).toBe('OK');
    expect(r.detail).toContain('max-age=300');
  });

  it('erro de rede vira linha FALHOU, nunca exceção', async () => {
    const fetchImpl = async () => { const e = new TypeError('fetch failed'); e.cause = { code: 'ECONNREFUSED' }; throw e; };
    const r = await probeSource(src('alternative-me-fng'), { fetchImpl });
    expect(r.status).toBe('FALHOU');
    expect(r.detail).toMatch(/ECONNREFUSED/);
  });

  it('sem resposta dentro do prazo vira timeout', async () => {
    const fetchImpl = (url, { signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    const r = await probeSource(src('alternative-me-fng'), { fetchImpl, timeoutMs: 20 });
    expect(r.status).toBe('FALHOU');
    expect(r.detail).toMatch(/timeout/);
  });

  it('fonte opcional que precisa de chave é PULADA sem a chave, e usa o cabeçalho com ela', async () => {
    const global = src('coingecko-global');
    const semChave = await probeSource(global, { fetchImpl: okFetch('{}'), env: {} });
    expect(semChave.status).toBe('PULADO');
    let seen;
    const fetchImpl = async (url, opts) => { seen = opts.headers; return new Response(JSON.stringify({ data: { total_market_cap: {}, market_cap_percentage: { btc: 58.2 } } }), { status: 200 }); };
    const comChave = await probeSource(global, { fetchImpl, env: { COINGECKO_API_KEY: 'k' } });
    expect(seen['x-cg-demo-api-key']).toBe('k');
    expect(comChave.status).toBe('OK');
  });

  it('resposta gigante é recusada', async () => {
    const r = await probeSource(src('bls-calendar'), { fetchImpl: okFetch('x'.repeat(2 * 1024 * 1024 + 1)) });
    expect(r.status).toBe('FALHOU');
    expect(r.detail).toMatch(/grande demais/);
  });

  it('registra sinais de limite dos cabeçalhos', async () => {
    const r = await probeSource(src('bls-calendar'), { fetchImpl: okFetch(ICS_OK, { headers: { 'x-ratelimit-remaining': '99' } }) });
    expect(r.rateLimit).toBe('x-ratelimit-remaining=99');
    expect(extractRateLimit({ 'content-type': 'x' })).toBe('');
  });
});


describe('contato do robô (política do BLS, item 286)', () => {
  const EMAIL = 'robo.dedicado@example.com';

  it('sem segredo, o identificador é o de sempre; com segredo válido, leva o contato', () => {
    expect(buildUserAgent({})).toBe(USER_AGENT);
    expect(contactEmail({ CONTEXT_CONTACT_EMAIL: EMAIL })).toBe(EMAIL);
    const ua = buildUserAgent({ CONTEXT_CONTACT_EMAIL: EMAIL });
    expect(ua).toContain(EMAIL);
    expect(ua.startsWith('SentinelSignals-ContextProbe/1.0 (+https://github.com/mateusraony/Sentinel-Signals;')).toBe(true);
    expect(ua.endsWith(')')).toBe(true);
  });

  it('valor malformado é ignorado em vez de derrubar a sonda ou vazar lixo no cabeçalho', () => {
    for (const bad of ['', '   ', 'sem-arroba', 'a b@c.com', 'x@y', 'a@b.com; DROP', 'a@b.com\nX-Evil: 1', '机器人@example.com', 'a@b.com\u0000', 'a@b.cömé']) {
      expect(contactEmail({ CONTEXT_CONTACT_EMAIL: bad }), JSON.stringify(bad)).toBeNull();
      expect(buildUserAgent({ CONTEXT_CONTACT_EMAIL: bad })).toBe(USER_AGENT);
    }
  });

  it('o e-mail vai SÓ no cabeçalho User-Agent: nunca na URL, no resultado, na tabela nem no JSON', async () => {
    let seenUrl; let seenHeaders;
    const fetchImpl = async (url, opts) => { seenUrl = url; seenHeaders = opts.headers; return new Response(ICS_OK, { status: 200 }); };
    const r = await probeSource(src('bls-calendar'), { fetchImpl, env: { CONTEXT_CONTACT_EMAIL: EMAIL } });
    expect(seenHeaders['User-Agent']).toContain(EMAIL);
    expect(seenUrl).not.toContain(EMAIL);
    expect(JSON.stringify(r)).not.toContain(EMAIL);
    const md = formatProbeMarkdown([r], { startedAt: 'x', runner: 'y', contactConfigured: true });
    expect(md).not.toContain(EMAIL);
    expect(md).toContain('Contato do robô no identificador: informado');
    expect(formatProbeMarkdown([r], { contactConfigured: false })).toContain('NÃO informado');
  });

  it('BLS 403: a mensagem explica a causa e o que fazer (sem inventar que o formato é inválido)', () => {
    const r = evaluateResponse(src('bls-calendar'), { status: 403, headers: {}, body: '<html>Access Denied</html>' });
    expect(r.status).toBe('FALHOU');
    expect(r.detail).toMatch(/403/);
    expect(r.detail).toMatch(/CONTEXT_CONTACT_EMAIL/);
    expect(r.detail).not.toMatch(/formato inválido/);
  });

  it('calendário dos EUA: 3 caminhos oficiais, todos do BLS e todos com dica; basta UM responder', () => {
    const us = SOURCES.filter((s) => s.group === 'us-calendar');
    expect(us.map((s) => s.id)).toEqual(['bls-calendar', 'bls-cpi-page', 'bls-empsit-page']);
    for (const s of us) { expect(s.required).toBe(true); expect(s.blockHint).toBeTruthy(); }
    const row = (id, status) => ({ id, name: id, required: true, group: 'us-calendar', status, httpStatus: 200, latencyMs: 1, bytes: 1, rateLimit: '', detail: '' });
    expect(summarize([row('bls-calendar', 'FALHOU'), row('bls-cpi-page', 'OK'), row('bls-empsit-page', 'FALHOU')]).gateOk).toBe(true);
    expect(summarize([row('bls-calendar', 'FALHOU'), row('bls-cpi-page', 'FALHOU'), row('bls-empsit-page', 'FALHOU')]).gateOk).toBe(false);
  });

  it('as páginas do BLS só passam com o conteúdo certo (200 com página de erro reprova)', () => {
    const cpi = src('bls-cpi-page');
    expect(evaluateResponse(cpi, { status: 200, headers: {}, body: '<h1>Consumer Price Index</h1> Release Schedule' }).status).toBe('OK');
    expect(evaluateResponse(cpi, { status: 200, headers: {}, body: '<html>Access Denied</html>' }).status).toBe('FALHOU');
    const emp = src('bls-empsit-page');
    expect(evaluateResponse(emp, { status: 200, headers: {}, body: 'The Employment Situation' }).status).toBe('OK');
    expect(evaluateResponse(emp, { status: 200, headers: {}, body: 'nada' }).status).toBe('FALHOU');
  });
});

describe('portão da fase (summarize)', () => {
  const row = (id, status, extra = {}) => ({ id, name: id, required: true, group: null, status, httpStatus: 200, latencyMs: 1, bytes: 1, rateLimit: '', detail: '', ...extra });

  it('aprova quando toda obrigatória responde e cada grupo tem ao menos uma alternativa OK', () => {
    const sum = summarize([
      row('bls', 'OK'), row('fng', 'OK'),
      row('fed-a', 'FALHOU', { group: 'fed-rss' }), row('fed-b', 'OK', { group: 'fed-rss' }),
      row('bin-a', 'OK', { group: 'binance-spot' }), row('bin-b', 'FALHOU', { group: 'binance-spot' }),
      row('cg', 'FALHOU', { required: false }),
    ]);
    expect(sum.gateOk).toBe(true);
    expect(sum.optionalFailed).toEqual(['cg']);
  });

  it('reprova se uma obrigatória sem grupo falha', () => {
    const sum = summarize([row('bls', 'FALHOU'), row('fng', 'OK')]);
    expect(sum.gateOk).toBe(false);
    expect(sum.failedRequired).toEqual(['bls']);
  });

  it('reprova se NENHUMA alternativa de um grupo responde', () => {
    const sum = summarize([row('fed-a', 'FALHOU', { group: 'fed-rss' }), row('fed-b', 'FALHOU', { group: 'fed-rss' })]);
    expect(sum.gateOk).toBe(false);
    expect(sum.failedRequired[0]).toMatch(/fed-rss/);
  });

  it('fonte PULADA obrigatória não conta como OK', () => {
    expect(summarize([row('bls', 'PULADO')]).gateOk).toBe(false);
  });
});

describe('lista de fontes', () => {
  it('ids únicos, https, validador presente e nenhuma chave dentro da URL', () => {
    const ids = SOURCES.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of SOURCES) {
      expect(s.url.startsWith('https://')).toBe(true);
      expect(typeof s.validate).toBe('function');
      // Única exceção: o molde `<NOME>` de uma fonte que declara `secretInUrl` (FRED). Valor literal, nunca.
      const visible = s.secretInUrl ? s.url.replace(`api_key=<${s.secretInUrl}>`, '') : s.url;
      expect(/key|token|secret/i.test(visible), s.id).toBe(false);
      if (s.secretInUrl) {
        expect(s.url).toContain(`<${s.secretInUrl}>`);
        expect(s.needsEnv).toBe(s.secretInUrl);
      }
    }
  });

  it('as fontes novas (financecalendar, FRED) são opcionais: não mudam o portão da fase', () => {
    const novas = SOURCES.filter((s) => /^(financecalendar|fred)-/.test(s.id));
    expect(novas.map((s) => s.id).sort()).toEqual([
      'financecalendar-cpi', 'financecalendar-nfp', 'fred-dates-cpi', 'fred-dates-nfp', 'fred-release-cpi', 'fred-release-nfp',
    ]);
    for (const s of novas) expect(s.required).toBe(false);
  });

  it('o portão cobre as 5 áreas do plano (BLS, Medo e Ganância, Fed, Binance Spot, CORS do raw)', () => {
    const req = SOURCES.filter((s) => s.required);
    const areas = new Set(req.map((s) => s.group || s.id));
    expect(areas).toEqual(new Set(['us-calendar', 'alternative-me-fng', 'fed-rss', 'binance-spot', 'raw-github-cors']));
  });

  it('só fontes públicas de leitura: nenhuma exige chave para ser obrigatória', () => {
    expect(SOURCES.filter((s) => s.required && s.needsEnv)).toEqual([]);
  });
});

describe('tabela em markdown', () => {
  it('mostra o veredito e não usa emoji (regra do emojiRegistry)', () => {
    const results = [
      { id: 'a', name: 'A', required: true, group: null, status: 'FALHOU', httpStatus: 451, latencyMs: 12, bytes: 0, rateLimit: '', detail: 'acesso bloqueado desta origem (HTTP 451)' },
    ];
    const md = formatProbeMarkdown(results, { startedAt: '2026-10-28T12:00:00Z', runner: 'ambiente local — NÃO vale como teste do GitHub' });
    expect(md).toContain('REPROVADO');
    expect(md).toContain('2026-10-28T12:00:00Z');
    expect(md).toContain('NÃO vale como teste do GitHub');
    expect(/\p{Extended_Pictographic}/u.test(md)).toBe(false);
  });
});

describe('fontes alternativas ao BLS (item 285, addendum 3)', () => {
  it('collectIsoDates acha datas em qualquer profundidade, sem repetir e em ordem', () => {
    const v = { a: [{ release: '2026-12-04T08:30:00-05:00' }, { d: '2026-11-06' }], b: 'x 2026-11-06 y', c: 5 };
    expect(collectIsoDates(v)).toEqual(['2026-11-06', '2026-12-04']);
    expect(collectIsoDates({ nada: 'sem data', n: 1 })).toEqual([]);
  });

  it('financecalendar: aceita JSON com datas e compara com a lista fixa; reprova HTML e JSON sem data', () => {
    const body = JSON.stringify({ events: [{ date: '2026-11-10', time: '08:30' }, { date: '2026-12-11' }] });
    const v = validateFinanceCalendar('CPI')({ body });
    expect(v.ok).toBe(true);
    expect(v.detail).toMatch(/chaves: events/);
    expect(v.detail).toMatch(/bate: 2026-11-10/);
    expect(v.detail).toMatch(/só na fonte: 2026-12-11/); // a divergência 10×11/12 aparece
    expect(v.detail).toMatch(/ausente na fonte: 2026-12-10, 2027-01-13/);
    expect(validateFinanceCalendar('CPI')({ body: HTML_ERROR }).ok).toBe(false);
    expect(validateFinanceCalendar('NFP')({ body: '{"ok":true}' }).detail).toMatch(/sem nenhuma data/);
  });

  it('FRED release: confere o NOME (um id errado não passa calado)', () => {
    const ok = JSON.stringify({ releases: [{ id: 10, name: 'Consumer Price Index' }] });
    expect(validateFredRelease('Consumer Price Index')({ body: ok })).toEqual({ ok: true, detail: 'release: Consumer Price Index' });
    const errado = JSON.stringify({ releases: [{ id: 10, name: 'Producer Price Index' }] });
    expect(validateFredRelease('Consumer Price Index')({ body: errado }).ok).toBe(false);
    expect(validateFredRelease('X')({ body: '{}' }).detail).toMatch(/sem releases/);
  });

  it('FRED datas: lê release_dates e compara com a lista fixa', () => {
    const body = JSON.stringify({ release_dates: [{ release_id: 50, date: '2027-01-08' }, { release_id: 50, date: '2026-12-04' }, { release_id: 50, date: '2026-11-06' }] });
    const v = validateFredDates('NFP')({ body });
    expect(v.ok).toBe(true);
    expect(v.detail).toMatch(/3 data\(s\) \(2026-11-06 a 2027-01-08\)/);
    expect(v.detail).toMatch(/bate: 2026-11-06, 2026-12-04, 2027-01-08/);
    expect(validateFredDates('NFP')({ body: '{"release_dates":[]}' }).ok).toBe(false);
  });

  it('FRED sem chave → PULADO, sem nenhuma requisição', async () => {
    let called = false;
    const r = await probeSource(src('fred-dates-cpi'), { fetchImpl: async () => { called = true; return new Response('{}'); }, env: {} });
    expect(r.status).toBe('PULADO');
    expect(called).toBe(false);
  });

  it('a chave do FRED vai SÓ na URL da requisição: nunca no resultado, na tabela nem no JSON', async () => {
    const KEY = 'abcdef0123456789abcdef0123456789';
    let seenUrl;
    const fetchImpl = async (url) => { seenUrl = url; return new Response(JSON.stringify({ release_dates: [{ date: '2026-11-10' }] }), { status: 200 }); };
    const r = await probeSource(src('fred-dates-cpi'), { fetchImpl, env: { FRED_API_KEY: KEY } });
    expect(r.status).toBe('OK');
    expect(seenUrl).toContain(`api_key=${KEY}`);
    expect(r.url).toContain('api_key=<FRED_API_KEY>');
    expect(JSON.stringify(r)).not.toContain(KEY);
    expect(formatProbeMarkdown([r], { startedAt: 'x', runner: 'y' })).not.toContain(KEY);
  });

  it('erro de rede que cita a URL (com a chave) é limpo antes de virar resultado', async () => {
    const KEY = 'fedcba9876543210fedcba9876543210';
    const fetchImpl = async (url) => { throw new Error(`falha ao abrir ${url}`); };
    const r = await probeSource(src('fred-release-cpi'), { fetchImpl, env: { FRED_API_KEY: KEY } });
    expect(r.status).toBe('FALHOU');
    expect(r.detail).toMatch(/\*\*\*/);
    expect(JSON.stringify(r)).not.toContain(KEY);
  });
});
