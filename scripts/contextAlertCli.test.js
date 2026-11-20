// Item 285, addendum 26 — o executável do aviso automático (scripts/context-alert.mjs). Sem rede e sem banco. Prova: simulação nunca chama
// a rede nem grava o registro; categoria desligada não envia; envio ligado manda 1 vez e registra; a 2ª passada na janela NÃO repete;
// falha de envio não registra (tenta de novo) e sai com 1 sem o token; o relatório nunca contém segredo.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './context-alert.mjs';

const TOKEN = '123456789:AAFakeTokenValueUsedOnlyInTests_abcdefghij';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '987654321' };
const EVENT_AT = '2026-11-10T13:30:00.000Z';
const NOW = Date.parse(EVENT_AT) - 60 * 60 * 1000; // 1 h antes
const EVENTS = [
  { id: 'CPI-2026-11-10', kind: 'CPI', reference: '2026-10', startsAtUtc: EVENT_AT, status: 'oficial', firstSeenAt: '2026-10-31T12:00:00.000Z', lastChangedAt: '2026-10-31T12:00:00.000Z' },
  { id: 'FOMC-2026-12-09', kind: 'FOMC', reference: '2026-12', startsAtUtc: '2026-12-09T19:00:00.000Z', status: 'oficial', firstSeenAt: '2026-10-31T12:00:00.000Z', lastChangedAt: '2026-10-31T12:00:00.000Z' },
];

let dir;
let saida;
let logSpy;
let errSpy;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-alert-'));
  fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(EVENTS));
  saida = [];
  logSpy = vi.spyOn(console, 'log').mockImplementation((...a) => { saida.push(a.join(' ')); });
  errSpy = vi.spyOn(console, 'error').mockImplementation((...a) => { saida.push(a.join(' ')); });
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  fs.rmSync(dir, { recursive: true, force: true });
});
const ok = () => vi.fn(async () => ({ ok: true, status: 200 }));
const run = (argv, { env = {}, fetchImpl = ok(), now = NOW } = {}) => {
  saida = [];
  return main(argv, env, { fetchImpl, now: () => now }).then((code) => ({ code, fetchImpl, texto: saida.join('\n') }));
};
const sentFile = () => path.join(dir, 'alerts-sent.json');

describe('simulação (sem --enviar)', () => {
  it('mostra a mensagem, NÃO chama a rede e NÃO grava o registro', async () => {
    const r = await run(['--dir', dir, '--categorias-ligadas', 'pre-evento'], { env: ENV });
    expect(r.code).toBe(0);
    expect(r.texto).toContain('Simulação — nada foi enviado');
    expect(r.texto).toContain('🗓️');
    expect(r.texto).toContain('CPI');
    expect(r.fetchImpl).not.toHaveBeenCalled();
    expect(fs.existsSync(sentFile())).toBe(false);
  });
});

describe('envio (--enviar)', () => {
  it('categoria desligada: não envia, não registra, e explica como ligar', async () => {
    for (const ligadas of ['nenhuma', 'agenda']) {
      const r = await run(['--dir', dir, '--enviar', '--categorias-ligadas', ligadas], { env: ENV });
      expect(r.code).toBe(0);
      expect(r.texto).toContain('desligada');
      expect(r.texto).toContain('CONTEXT_TELEGRAM_CATEGORIES');
      expect(r.fetchImpl).not.toHaveBeenCalled();
      expect(fs.existsSync(sentFile())).toBe(false);
    }
  });

  it('variável vazia ou ausente = LIGADO por padrão (addendum 27); só `nenhuma` desliga', async () => {
    const r = await run(['--dir', dir, '--enviar', '--categorias-ligadas', ''], { env: ENV });
    expect(r.code).toBe(0);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.texto).toContain('Enviada ao Telegram');
    fs.rmSync(sentFile(), { force: true });
    const semArgumento = await run(['--dir', dir, '--enviar'], { env: ENV });
    expect(semArgumento.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('ligada: envia 1 mensagem, registra, e a 2ª passada dentro da janela NÃO repete', async () => {
    const r1 = await run(['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], { env: ENV });
    expect(r1.code).toBe(0);
    expect(r1.fetchImpl).toHaveBeenCalledTimes(1);
    expect(r1.texto).toContain('Enviada ao Telegram');
    const registro = JSON.parse(fs.readFileSync(sentFile(), 'utf8'));
    expect(registro).toEqual({ version: 1, sent: { 'CPI-2026-11-10:pre': new Date(NOW).toISOString() } });

    const r2 = await run(['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], { env: ENV, now: NOW + 15 * 60 * 1000 });
    expect(r2.code).toBe(0);
    expect(r2.fetchImpl).not.toHaveBeenCalled();
    expect(r2.texto).toContain('Nada a enviar agora');
  });

  it('a mensagem enviada é só fato (evento, hora, situação), sem previsão e sem operações', async () => {
    const r = await run(['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], { env: ENV });
    const corpo = JSON.parse(r.fetchImpl.mock.calls[0][1].body);
    expect(corpo.text).toContain('CPI');
    expect(corpo.text).toContain('em 1h');
    expect(corpo.text).toContain('Só informação');
    // (o rodapé fixo diz "não altera sinais nem operações"; o resto do texto não pode falar de previsão, compra, venda nem operações abertas)
    expect(corpo.text.replace('Só informação — não altera sinais nem operações.', '')).not.toMatch(/probabilidade|vai (subir|cair)|compra|venda|operaç|stop/i);
    expect(corpo.chat_id).toBe('987654321');
  });

  it('fora da janela (2 h antes, ou o evento a confirmar) não envia nada', async () => {
    const r = await run(['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], { env: ENV, now: NOW - 60 * 60 * 1000 });
    expect(r.code).toBe(0);
    expect(r.fetchImpl).not.toHaveBeenCalled();
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify([{ ...EVENTS[0], status: 'a_confirmar' }]));
    const r2 = await run(['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], { env: ENV });
    expect(r2.fetchImpl).not.toHaveBeenCalled();
  });

  it('falha de envio: sai com 1, NÃO registra (a próxima passada tenta de novo) e o relatório não traz o token', async () => {
    const fetchImpl = vi.fn(async () => { throw new Error(`falha em https://api.telegram.org/bot${TOKEN}/sendMessage`); });
    const r = await run(['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], { env: ENV, fetchImpl });
    expect(r.code).toBe(1);
    expect(r.texto).toContain('Não enviada');
    expect(r.texto).not.toContain(TOKEN);
    expect(fs.existsSync(sentFile())).toBe(false);
    // a próxima passada, agora com a rede boa, envia e registra
    const r2 = await run(['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], { env: ENV, now: NOW + 5 * 60 * 1000 });
    expect(r2.code).toBe(0);
    expect(r2.fetchImpl).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(sentFile())).toBe(true);
  });

  it('sem credenciais: não registra', async () => {
    const r = await run(['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], { env: {} });
    expect(r.code).toBe(1);
    expect(fs.existsSync(sentFile())).toBe(false);
  });

  it('dois eventos na janela: o 2º falhar não desfaz o registro do 1º', async () => {
    const outro = { ...EVENTS[0], id: 'PPI-2026-11-10', kind: 'PPI' };
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify([EVENTS[0], outro]));
    let n = 0;
    const fetchImpl = vi.fn(async () => { n += 1; return n === 1 ? { ok: true, status: 200 } : { ok: false, status: 500 }; });
    const r = await run(['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], { env: ENV, fetchImpl });
    expect(r.code).toBe(1);
    expect(Object.keys(JSON.parse(fs.readFileSync(sentFile(), 'utf8')).sent)).toEqual(['CPI-2026-11-10:pre']);
  });

  it('registro ilegível no disco vira vazio (não quebra) e é reescrito no formato certo', async () => {
    fs.writeFileSync(sentFile(), '{ isto não é json');
    const r = await run(['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], { env: ENV });
    expect(r.code).toBe(0);
    expect(JSON.parse(fs.readFileSync(sentFile(), 'utf8')).version).toBe(1);
    expect(fs.existsSync(`${sentFile()}.tmp`)).toBe(false);
  });
});

describe('o aviso completo: com o histórico das divulgações passadas (addendum 27)', () => {
  const MIN = 60 * 1000;
  const T0 = (date) => Date.parse(`${date}T13:30:00.000Z`); // novembro/outubro: 08:30 de Nova York = 13:30 UTC (horário de inverno a partir de 01/11)
  // 2026-10-24 ainda é horário de verão (12:30 UTC): usa as datas do inverno para ficar simples.
  const DATES = ['2026-11-06', '2026-12-04'];
  const klines = (t0, pct60) => JSON.stringify(Array.from({ length: 61 }, (_, i) => {
    const t = t0 + (i - 1) * MIN;
    const c = i === 0 ? 100 : 100 * (1 + (pct60 * Math.min(i, 60)) / 60 / 100);
    return [t, String(c), String(c * 1.001), String(c * 0.999), String(c), '1', t + 59999, '1', 1, '1', '1', '0'];
  }));
  const router = ({ binanceOk = true } = {}) => vi.fn(async (url, init) => {
    const u = String(url);
    if (u.startsWith('https://api.telegram.org/')) return { ok: true, status: 200 };
    if (!binanceOk) return { ok: false, status: 500, text: async () => '' };
    const t0 = Number(new URL(u).searchParams.get('startTime')) + MIN;
    return { ok: true, status: 200, text: async () => klines(t0, t0 === T0(DATES[0]) ? 0.8 : -0.4) };
  });
  beforeEach(() => {
    fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify({ version: 1, dates: { CPI: ['2026-11-06', '2026-10-03'] } }));
  });
  const SEM_ESPERA = async () => {};
  const runFull = (fetchImpl, argv) => { saida = []; return main(argv, ENV, { fetchImpl, now: () => NOW, sleep: SEM_ESPERA }).then((code) => ({ code, texto: saida.join('\n') })); };

  it('a mensagem enviada traz importância, "Anterior" indisponível (sem BLS no arquivo), projeção indisponível e o BTC das divulgações passadas', async () => {
    const fetchImpl = router();
    const r = await runFull(fetchImpl, ['--dir', dir, '--enviar', '--categorias-ligadas', '']);
    expect(r.code).toBe(0);
    const envio = fetchImpl.mock.calls.find(([u]) => String(u).startsWith('https://api.telegram.org/'));
    const texto = JSON.parse(envio[1].body).text;
    expect(texto).toContain('importância alta');
    expect(texto).toContain('<b>Projeção do mercado (consenso):</b> indisponível');
    expect(texto).toContain('<b>BTC nas últimas 2 divulgações de CPI</b>');
    expect(texto).toContain('• 06/11: <b>+0,80%</b>');
    expect(texto).toContain('• 03/10: <b>-0,40%'.replace('-', '−'));
    expect(fetchImpl.mock.calls.filter(([u]) => !String(u).startsWith('https://api.telegram.org/')).length).toBe(2);
  });

  it('a Binance fora do ar NÃO impede o aviso: a mensagem sai com "sem dado" nas linhas do BTC', async () => {
    const fetchImpl = router({ binanceOk: false });
    const r = await runFull(fetchImpl, ['--dir', dir, '--enviar', '--categorias-ligadas', '']);
    expect(r.code).toBe(0);
    const envio = fetchImpl.mock.calls.find(([u]) => String(u).startsWith('https://api.telegram.org/'));
    expect(JSON.parse(envio[1].body).text).toContain('• 06/11: sem dado');
    expect(fs.existsSync(sentFile())).toBe(true); // foi enviado e registrado
  });

  it('a simulação também busca o histórico (para mostrar a mensagem de verdade) mas NÃO manda Telegram nem grava o registro', async () => {
    const fetchImpl = router();
    const r = await runFull(fetchImpl, ['--dir', dir, '--categorias-ligadas', '']);
    expect(r.texto).toContain('+0,80%');
    expect(fetchImpl.mock.calls.some(([u]) => String(u).startsWith('https://api.telegram.org/'))).toBe(false);
    expect(fs.existsSync(sentFile())).toBe(false);
  });
});

describe('o aviso de resultado (addendum 28)', () => {
  const MIN = 60 * 1000;
  const T0 = Date.parse('2026-12-10T13:30:00.000Z');
  const AFTER = T0 + 30 * MIN;
  const RESULTADO = [{
    id: 'CPI-2026-12-10', kind: 'CPI', reference: '2026-11', startsAtUtc: '2026-12-10T13:30:00.000Z', status: 'oficial',
    firstSeenAt: '2026-10-31T12:00:00.000Z', lastChangedAt: '2026-12-10T13:40:00.000Z',
    values: { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,2% m/m · +3,1% a/a', source: 'BLS' },
  }];
  const candles = JSON.stringify(Array.from({ length: 31 }, (_, i) => {
    const t = T0 + (i - 1) * MIN;
    const c = i === 0 ? 100 : 100 + i * 0.01;
    return [t, String(c), String(c), String(c), String(c), '1', t + 59999];
  }));
  const router = () => vi.fn(async (url) => (String(url).startsWith('https://api.telegram.org/')
    ? { ok: true, status: 200 }
    : { ok: true, status: 200, text: async () => candles }));
  const go = (fetchImpl, argv, now = AFTER) => { saida = []; return main(argv, ENV, { fetchImpl, now: () => now, sleep: async () => {} }).then((code) => ({ code, texto: saida.join('\n') })); };
  const telegramBodies = (f) => f.mock.calls.filter(([u]) => String(u).startsWith('https://api.telegram.org/')).map(([, init]) => JSON.parse(init.body).text);
  beforeEach(() => { fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(RESULTADO)); });

  it('30 min depois da divulgação, com o número do BLS: envia o resultado com o BTC, registra `:post` e NÃO repete na passada seguinte', async () => {
    const f = router();
    const r = await go(f, ['--dir', dir, '--enviar', '--categorias-ligadas', '']);
    expect(r.code).toBe(0);
    const msgs = telegramBodies(f);
    expect(msgs.length).toBe(1);
    expect(msgs[0]).toContain('CPI — saiu o resultado');
    expect(msgs[0]).toContain('abaixo do anterior');
    expect(msgs[0]).toContain('BTC desde a divulgação:</b> 5 min +0,05% · 30 min +0,30% · 60 min ainda não passou');
    expect(JSON.parse(fs.readFileSync(sentFile(), 'utf8')).sent).toEqual({ 'CPI-2026-12-10:post': new Date(AFTER).toISOString() });
    const f2 = router();
    const r2 = await go(f2, ['--dir', dir, '--enviar', '--categorias-ligadas', ''], AFTER + 15 * MIN);
    expect(r2.texto).toContain('Nada a enviar agora');
    expect(telegramBodies(f2).length).toBe(0);
  });

  it('antes dos 5 min ou sem o número do BLS (e menos de 2 h): ainda não avisa', async () => {
    const f = router();
    expect((await go(f, ['--dir', dir, '--enviar', '--categorias-ligadas', ''], T0 + 4 * MIN)).texto).toContain('Nada a enviar agora');
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify([{ ...RESULTADO[0], values: null }]));
    expect((await go(f, ['--dir', dir, '--enviar', '--categorias-ligadas', ''], T0 + 60 * MIN)).texto).toContain('Nada a enviar agora');
    expect(telegramBodies(f).length).toBe(0);
  });

  it('lista que liga só `pre-evento`: o resultado fica de fora (não envia e NÃO registra, para poder enviar se a categoria for ligada depois)', async () => {
    const f = router();
    const r = await go(f, ['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento']);
    expect(r.texto).toContain('Categoria `resultado` desligada');
    expect(telegramBodies(f).length).toBe(0);
    expect(fs.existsSync(sentFile())).toBe(false);
  });

  it('a simulação mostra a mensagem do resultado sem enviar nem registrar', async () => {
    const f = router();
    const r = await go(f, ['--dir', dir, '--categorias-ligadas', '']);
    expect(r.texto).toContain('CPI-2026-12-10:post');
    expect(r.texto).toContain('saiu o resultado');
    expect(telegramBodies(f).length).toBe(0);
    expect(fs.existsSync(sentFile())).toBe(false);
  });

  it('o preço fora do ar NÃO impede o aviso do resultado (BTC "indisponível agora")', async () => {
    const f = vi.fn(async (url) => (String(url).startsWith('https://api.telegram.org/') ? { ok: true, status: 200 } : { ok: false, status: 500, text: async () => '' }));
    const r = await go(f, ['--dir', dir, '--enviar', '--categorias-ligadas', '']);
    expect(r.code).toBe(0);
    expect(telegramBodies(f)[0]).toContain('BTC desde a divulgação:</b> indisponível agora');
  });

  it('o aviso de antes e o de resultado de eventos diferentes saem na MESMA passada, cada um com a sua chave', async () => {
    const antes = { ...RESULTADO[0], id: 'FOMC-2026-12-10', kind: 'FOMC', startsAtUtc: '2026-12-10T14:30:00.000Z', values: null };
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify([RESULTADO[0], antes]));
    const f = router();
    await go(f, ['--dir', dir, '--enviar', '--categorias-ligadas', ''], Date.parse('2026-12-10T13:35:00.000Z'));
    expect(Object.keys(JSON.parse(fs.readFileSync(sentFile(), 'utf8')).sent).sort()).toEqual(['CPI-2026-12-10:post', 'FOMC-2026-12-10:pre']);
  });
});

describe('a projeção registrada pelo usuário chega ao aviso (addendum 30)', () => {
  const MIN = 60 * 1000;
  const T0 = Date.parse('2026-12-10T13:30:00.000Z');
  const EV = [{ id: 'CPI-2026-12-10', kind: 'CPI', reference: '2026-11', startsAtUtc: '2026-12-10T13:30:00.000Z', status: 'oficial', firstSeenAt: '2026-10-31T12:00:00.000Z', lastChangedAt: '2026-10-31T12:00:00.000Z',
    values: { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,2% m/m · +3,1% a/a', source: 'BLS' } }];
  const router = () => vi.fn(async (u) => (String(u).startsWith('https://api.telegram.org/') ? { ok: true, status: 200 } : { ok: false, status: 500, text: async () => '' }));
  const body = (f) => f.mock.calls.filter(([u]) => String(u).startsWith('https://api.telegram.org/')).map(([, i]) => JSON.parse(i.body).text);
  const go = (f, now) => { saida = []; return main(['--dir', dir, '--enviar', '--categorias-ligadas', ''], ENV, { fetchImpl: f, now: () => now, sleep: async () => {} }); };
  beforeEach(() => { fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(EV)); });

  it('1 h antes: usa a projeção do arquivo consensus.json', async () => {
    fs.writeFileSync(path.join(dir, 'consensus.json'), JSON.stringify({ version: 1, items: { 'CPI-2026-12-10': { at: '2026-12-09T12:00:00.000Z', projection: '+0,3% m/m · +3,1% a/a' } } }));
    const f = router();
    await go(f, T0 - 60 * MIN);
    expect(body(f)[0]).toContain('Projeção (informada por você):</b> +0,3% m/m · +3,1% a/a');
  });
  it('o resultado compara com a projeção registrada', async () => {
    fs.writeFileSync(path.join(dir, 'consensus.json'), JSON.stringify({ version: 1, items: { 'CPI-2026-12-10': { at: '2026-12-09T12:00:00.000Z', projection: '+0,3% m/m · +3,1% a/a' } } }));
    const f = router();
    await go(f, T0 + 30 * MIN);
    expect(body(f)[0]).toContain('abaixo da projeção (+0,3%)');
  });
  it('sem o arquivo, ou com ele ilegível ou com formato fora da lista fechada: segue sem projeção (nunca quebra, nunca usa texto livre)', async () => {
    for (const conteudo of [null, '{ lixo', JSON.stringify({ version: 1, items: { 'CPI-2026-12-10': { at: '2026-12-09T12:00:00.000Z', projection: 'vai ser enorme' } } })]) {
      fs.rmSync(path.join(dir, 'alerts-sent.json'), { force: true });
      if (conteudo === null) fs.rmSync(path.join(dir, 'consensus.json'), { force: true });
      else fs.writeFileSync(path.join(dir, 'consensus.json'), conteudo);
      const f = router();
      const code = await go(f, T0 - 60 * MIN);
      expect(code).toBe(0);
      expect(body(f)[0]).toContain('Projeção do mercado (consenso):</b> indisponível');
      expect(body(f)[0]).not.toContain('vai ser enorme');
    }
  });
});

describe('entrada ruim', () => {
  it('sem --dir ou com agenda ilegível: sai com 1 e explica, sem rede', async () => {
    const a = await run(['--enviar', '--categorias-ligadas', 'pre-evento'], { env: ENV });
    expect(a.code).toBe(1);
    fs.writeFileSync(path.join(dir, 'events.json'), 'não é json');
    const b = await run(['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], { env: ENV });
    expect(b.code).toBe(1);
    expect(b.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('o relatório nunca contém segredo', () => {
  it('em nenhum caminho (simulação, desligada, enviada, falha)', async () => {
    const casos = [
      [['--dir', dir, '--categorias-ligadas', 'pre-evento'], {}],
      [['--dir', dir, '--enviar', '--categorias-ligadas', ''], {}],
      [['--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], {}],
    ];
    for (const [argv, extra] of casos) {
      const r = await run(argv, { env: ENV, ...extra });
      expect(r.texto).not.toContain(TOKEN);
      expect(r.texto).not.toContain('987654321');
      fs.rmSync(sentFile(), { force: true });
    }
  });
});

// Addendum 35: o resumo do dia às 21h de Brasília.
describe('o resumo do dia (fase 4c): executável de ponta a ponta', () => {
  const MIN = 60 * 1000;
  const HOUR = 60 * MIN;
  const SAIU = '2026-11-19T13:30:00.000Z';
  const NOITE = Date.parse('2026-11-20T00:10:00Z'); // 21:10 de Brasília
  const DAY_START = Date.parse('2026-11-19T03:00:00Z');
  const DIA = [
    { id: 'CPI-2026-11-19', kind: 'CPI', reference: '2026-10', startsAtUtc: SAIU, status: 'oficial', firstSeenAt: '2026-11-01T00:00:00.000Z', lastChangedAt: '2026-11-01T00:00:00.000Z',
      values: { previous: '+0,3% m/m · +3,0% a/a', actual: '+0,2% m/m · +3,1% a/a', source: 'BLS' } },
    { id: 'PPI-2026-11-25', kind: 'PPI', reference: '2026-10', startsAtUtc: '2026-11-25T13:30:00.000Z', status: 'oficial', firstSeenAt: '2026-11-01T00:00:00.000Z', lastChangedAt: '2026-11-01T00:00:00.000Z' },
  ];
  const router = ({ binanceOk = true } = {}) => vi.fn(async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.telegram.org/')) return { ok: true, status: 200 };
    if (!binanceOk) return { ok: false, status: 500, text: async () => '' };
    const q = new URL(u).searchParams;
    const start = Number(q.get('startTime'));
    if (q.get('interval') === '1h') {
      const rows = Array.from({ length: 22 }, (_, i) => [start + i * HOUR, '100', '102', '99', i === 21 ? '101' : '100', '1', start + (i + 1) * HOUR - 1, '1', 1, '1', '1', '0']);
      return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
    }
    const rows = Array.from({ length: 61 }, (_, i) => [start + i * MIN, '100', '100.1', '99.9', i === 0 ? '100' : '100.4', '1', start + (i + 1) * MIN - 1, '1', 1, '1', '1', '0']);
    return { ok: true, status: 200, text: async () => JSON.stringify(rows) };
  });
  const SEM_ESPERA = async () => {};
  const go = (argv, fetchImpl, now = NOITE) => { saida = []; return main(argv, ENV, { fetchImpl, now: () => now, sleep: SEM_ESPERA }).then((code) => ({ code, texto: saida.join('\n') })); };
  const enviado = (f) => f.mock.calls.filter(([u]) => String(u).startsWith('https://api.telegram.org/')).map(([, init]) => JSON.parse(init.body).text);
  beforeEach(() => { fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify(DIA)); });

  it('depois das 21h de Brasília, num dia com divulgação: manda 1 resumo com números, BTC depois e BTC no dia, e registra', async () => {
    const f = router();
    const r = await go(['--dir', dir, '--enviar', '--categorias-ligadas', ''], f);
    expect(r.code).toBe(0);
    const textos = enviado(f);
    expect(textos.length).toBe(1);
    expect(textos[0]).toContain('<b>Resumo do dia — qui, 19/11</b>');
    expect(textos[0]).toContain('No mês: <b>+0,2%</b> (anterior +0,3%) — abaixo do anterior');
    expect(textos[0]).toContain('BTC depois: 5 min +0,40% · 30 min +0,40% · 60 min +0,40%');
    expect(textos[0]).toContain('+1,00% contra a abertura');
    expect(textos[0]).toContain('amplitude de 3,03% entre a mínima e a máxima');
    expect(textos[0]).toMatch(/• <b>PPI<\/b> — qua 25\/11/);
    expect(JSON.parse(fs.readFileSync(sentFile(), 'utf8')).sent).toEqual({ 'DIA-2026-11-19:dia': new Date(NOITE).toISOString() });
    // a janela da busca do dia é a do dia de Brasília
    const url1h = f.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.searchParams.get('interval') === '1h');
    expect(Number(url1h.searchParams.get('startTime'))).toBe(DAY_START);
  });

  it('a 2ª passada (15 min depois) NÃO repete; e o dia seguinte sem divulgação não manda nada', async () => {
    const f1 = router();
    await go(['--dir', dir, '--enviar', '--categorias-ligadas', ''], f1);
    const f2 = router();
    const r2 = await go(['--dir', dir, '--enviar', '--categorias-ligadas', ''], f2, NOITE + 15 * MIN);
    expect(enviado(f2)).toEqual([]);
    expect(r2.texto).toContain('Nada a enviar agora');
    const f3 = router();
    await go(['--dir', dir, '--enviar', '--categorias-ligadas', ''], f3, NOITE + 24 * HOUR); // 21h do dia 20: nada saiu no dia 20
    expect(enviado(f3)).toEqual([]);
  });

  it('antes das 21h (de tarde) não manda resumo', async () => {
    const f = router();
    await go(['--dir', dir, '--enviar', '--categorias-ligadas', ''], f, Date.parse('2026-11-19T20:00:00Z'));
    expect(enviado(f).filter((t) => t.includes('Resumo do dia'))).toEqual([]);
  });

  it('categoria `resumo` desligada (lista sem ela, ou `nenhuma`): não envia nem registra; ligada só ela: envia', async () => {
    for (const ligadas of ['pre-evento,resultado', 'nenhuma']) {
      const f = router();
      const r = await go(['--dir', dir, '--enviar', '--categorias-ligadas', ligadas], f);
      expect(enviado(f)).toEqual([]);
      expect(r.texto).toContain('Categoria `resumo` desligada');
      expect(fs.existsSync(sentFile())).toBe(false);
    }
    const f = router();
    await go(['--dir', dir, '--enviar', '--categorias-ligadas', 'resumo'], f);
    expect(enviado(f).length).toBe(1);
  });

  it('a Binance fora do ar NÃO impede o resumo: sai com "indisponível" nas linhas do BTC', async () => {
    const f = router({ binanceOk: false });
    const r = await go(['--dir', dir, '--enviar', '--categorias-ligadas', ''], f);
    expect(r.code).toBe(0);
    const [texto] = enviado(f);
    expect(texto).toContain('BTC depois: indisponível agora');
    expect(texto).toContain('<b>BTC no dia:</b> indisponível agora');
    expect(fs.existsSync(sentFile())).toBe(true);
  });

  it('ACHADO DA REVISÃO (B1): numa passada ATRASADA (01:00 de Brasília) o "BTC no dia" termina no fim do dia resumido, não entra no dia seguinte', async () => {
    const f = router();
    await go(['--dir', dir, '--enviar', '--categorias-ligadas', ''], f, Date.parse('2026-11-20T04:00:00Z'));
    const url1h = f.mock.calls.map(([u]) => new URL(String(u))).find((u) => u.searchParams.get('interval') === '1h');
    expect(Number(url1h.searchParams.get('endTime'))).toBe(Date.parse('2026-11-20T03:00:00Z') - 1);
    expect(Number(url1h.searchParams.get('startTime'))).toBe(DAY_START);
  });

  it('simulação: mostra o resumo, NÃO manda Telegram e NÃO grava o registro', async () => {
    const f = router();
    const r = await go(['--dir', dir, '--categorias-ligadas', ''], f);
    expect(r.texto).toContain('Resumo do dia');
    expect(r.texto).toContain('DIA-2026-11-19:dia');
    expect(enviado(f)).toEqual([]);
    expect(fs.existsSync(sentFile())).toBe(false);
  });

  it('falha de envio não registra (a próxima passada tenta de novo) e o relatório não traz o token', async () => {
    const f = vi.fn(async (u) => { if (String(u).startsWith('https://api.telegram.org/')) throw new Error(`falha em ${u}`); return router()(u); });
    const r = await go(['--dir', dir, '--enviar', '--categorias-ligadas', ''], f);
    expect(r.code).toBe(1);
    expect(r.texto).not.toContain(TOKEN);
    expect(fs.existsSync(sentFile())).toBe(false);
  });
});

// Addendum 42: o aviso de antes do FOMC lê a faixa-alvo do NY Fed na hora (sem chave) e a mostra como "Anterior", com a atribuição dos termos de uso.
describe('o aviso de antes do FOMC com a faixa-alvo do NY Fed (addendum 42)', () => {
  const FOMC_AT = Date.parse('2026-12-09T19:00:00.000Z');
  const NY = JSON.stringify({ refRates: [{ effectiveDate: '2026-12-08', percentRate: 3.88, targetRateFrom: 3.75, targetRateTo: 4.0 }] });
  const SEM_ESPERA = async () => {};
  const router = ({ ny = 'ok' } = {}) => vi.fn(async (url) => {
    const u = String(url);
    if (u.startsWith('https://api.telegram.org/')) return { ok: true, status: 200 };
    if (u.startsWith('https://markets.newyorkfed.org/')) {
      if (ny === 'ok') return { status: 200, text: async () => NY };
      if (ny === 'http') return { status: 503, text: async () => '' };
      throw new Error('rede caiu: https://markets.newyorkfed.org/segredo');
    }
    return { ok: false, status: 500, text: async () => '' }; // Binance fora: o aviso sai igual
  });
  const enviado = (fetchImpl) => {
    const envio = fetchImpl.mock.calls.find(([u]) => String(u).startsWith('https://api.telegram.org/'));
    return envio ? JSON.parse(envio[1].body).text : null;
  };
  const rodar = (fetchImpl) => { saida = []; return main(['--dir', dir, '--enviar', '--categorias-ligadas', ''], ENV, { fetchImpl, now: () => FOMC_AT - 60 * 60 * 1000, sleep: SEM_ESPERA }).then((code) => ({ code, texto: saida.join('\n') })); };

  it('FOMC: a mensagem enviada traz a faixa-alvo, a taxa efetiva e a atribuição do NY Fed', async () => {
    const f = router();
    const r = await rodar(f);
    expect(r.code).toBe(0);
    const texto = enviado(f);
    expect(texto).toContain('Anterior (faixa-alvo dos juros, NY Fed):</b> 3,75% a 4,00% · taxa efetiva 3,88% (em 08/12)');
    expect(texto).toContain('Termos de Uso publicados em newyorkfed.org');
    expect(f.mock.calls.some(([u]) => String(u).startsWith('https://markets.newyorkfed.org/'))).toBe(true);
  });

  it('NY Fed fora do ar (erro HTTP ou de rede): o aviso SAI do mesmo jeito, sem a faixa e sem a atribuição, e o relatório não traz o texto do erro', async () => {
    for (const ny of ['http', 'rede']) {
      const f = router({ ny });
      fs.rmSync(sentFile(), { force: true });
      const r = await rodar(f);
      expect(r.code, ny).toBe(0);
      const texto = enviado(f);
      expect(texto, ny).toContain('sem fonte oficial automática');
      expect(texto, ny).not.toContain('newyorkfed.org');
      expect(r.texto, ny).not.toMatch(/segredo|markets\.newyorkfed/);
    }
  });

  it('um evento que NÃO é FOMC nem consulta o NY Fed', async () => {
    const f = router();
    saida = [];
    await main(['--dir', dir, '--enviar', '--categorias-ligadas', ''], ENV, { fetchImpl: f, now: () => NOW, sleep: SEM_ESPERA });
    expect(f.mock.calls.some(([u]) => String(u).startsWith('https://markets.newyorkfed.org/'))).toBe(false);
  });
});
