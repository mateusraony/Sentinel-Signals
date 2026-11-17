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
      expect(r.texto).toContain('Categoria desligada');
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
    expect(r2.texto).toContain('nada a enviar');
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
