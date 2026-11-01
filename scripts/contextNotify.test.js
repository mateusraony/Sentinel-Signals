// Item 285, addendum 12 — o executável do aviso (scripts/context-notify.mjs). Sem rede e sem banco. Prova: simulação
// nunca chama a rede; envio só com categoria ligada (menos "teste"); falha de envio sai com 1 e explica sem o token;
// o relatório (stdout) nunca contém segredo.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from './context-notify.mjs';

const TOKEN = '123456789:AAFakeTokenValueUsedOnlyInTests_abcdefghij';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '987654321' };
const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const EVENTS = [
  { id: 'NFP-2026-11-06', kind: 'NFP', reference: '2026-10', startsAtUtc: '2026-11-06T13:30:00.000Z', status: 'oficial', firstSeenAt: '2026-10-31T12:00:00.000Z', lastChangedAt: '2026-10-31T12:00:00.000Z' },
];

let dir;
let saida;
let logSpy;
let errSpy;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctx-notify-'));
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
const run = (argv, env = {}, fetchImpl = vi.fn(async () => ({ ok: true, status: 200 }))) => main(argv, env, { fetchImpl, now: () => NOW }).then((code) => ({ code, fetchImpl, texto: saida.join('\n') }));

describe('simulação (sem --enviar)', () => {
  it('mostra a mensagem e NÃO chama a rede, para qualquer categoria', async () => {
    for (const categoria of ['teste', 'agenda', 'pre-evento']) {
      saida = [];
      const r = await run(['--categoria', categoria, '--dir', dir, '--categorias-ligadas', 'agenda,pre-evento'], ENV);
      expect(r.code).toBe(0);
      expect(r.texto).toContain('Simulação — nada foi enviado');
      expect(r.texto).toContain('🗓️');
      expect(r.fetchImpl).not.toHaveBeenCalled();
    }
  });
});

describe('envio (--enviar)', () => {
  it('"teste" envia mesmo sem categoria ligada', async () => {
    const r = await run(['--categoria', 'teste', '--dir', dir, '--enviar'], ENV);
    expect(r.code).toBe(0);
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
    expect(r.texto).toContain('Enviada ao Telegram');
  });

  it('"agenda"/"pre-evento" só enviam se a categoria estiver ligada; senão explica como ligar e não chama a rede', async () => {
    for (const categoria of ['agenda', 'pre-evento']) {
      saida = [];
      const r = await run(['--categoria', categoria, '--dir', dir, '--enviar', '--categorias-ligadas', ''], ENV);
      expect(r.code).toBe(0);
      expect(r.texto).toContain('Categoria desligada — nada foi enviado');
      expect(r.texto).toContain('CONTEXT_TELEGRAM_CATEGORIES');
      expect(r.fetchImpl).not.toHaveBeenCalled();
    }
    saida = [];
    const ligada = await run(['--categoria', 'agenda', '--dir', dir, '--enviar', '--categorias-ligadas', 'agenda'], ENV);
    expect(ligada.fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ligada.fetchImpl.mock.calls[0][1].body).text).toContain('Agenda de eventos dos EUA');
  });

  it('a variável também pode vir do ambiente (CATEGORIAS_LIGADAS)', async () => {
    const r = await run(['--categoria', 'agenda', '--dir', dir, '--enviar'], { ...ENV, CATEGORIAS_LIGADAS: 'agenda' });
    expect(r.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('o Telegram recusou: sai com 1, explica a causa e o relatório NÃO tem o token', async () => {
    const r = await run(['--categoria', 'teste', '--dir', dir, '--enviar'], ENV, vi.fn(async () => ({ ok: false, status: 401 })));
    expect(r.code).toBe(1);
    expect(r.texto).toContain('Não enviada');
    expect(r.texto).toMatch(/token/);
    expect(r.texto).not.toContain(TOKEN);
  });

  it('rede caiu citando a URL com o token: o relatório não vaza', async () => {
    const r = await run(['--categoria', 'teste', '--dir', dir, '--enviar'], ENV, async (url) => { throw new TypeError(`fetch failed ${url}`); });
    expect(r.code).toBe(1);
    expect(r.texto).not.toContain(TOKEN);
    expect(r.texto).not.toContain('api.telegram.org');
  });

  it('sem os segredos (simulação não os recebe): diz que faltam, sem chamar a rede', async () => {
    const r = await run(['--categoria', 'teste', '--dir', dir, '--enviar'], {});
    expect(r.code).toBe(1);
    expect(r.texto).toContain('faltam os segredos');
    expect(r.fetchImpl).not.toHaveBeenCalled();
  });
});

describe('entradas ruins', () => {
  it('categoria inválida ou ausente: sai com 1', async () => {
    expect((await run(['--categoria', 'resumo', '--dir', dir], ENV)).code).toBe(1);
    expect((await run(['--dir', dir], ENV)).code).toBe(1);
  });

  it('agenda ilegível ou ausente: sai com 1 e diz por quê (e não envia)', async () => {
    fs.writeFileSync(path.join(dir, 'events.json'), '{não é json');
    const r = await run(['--categoria', 'agenda', '--dir', dir, '--enviar', '--categorias-ligadas', 'agenda'], ENV);
    expect(r.code).toBe(1);
    expect(r.texto).toContain('não consegui ler a agenda');
    expect(r.fetchImpl).not.toHaveBeenCalled();
    saida = [];
    const semDir = await run(['--categoria', 'agenda'], ENV);
    expect(semDir.code).toBe(1);
    expect(semDir.texto).toContain('falta --dir');
  });

  it('pre-evento sem nenhum evento firme à frente: não há o que avisar (sai com 0, não envia)', async () => {
    fs.writeFileSync(path.join(dir, 'events.json'), JSON.stringify([{ ...EVENTS[0], status: 'a_confirmar' }]));
    const r = await run(['--categoria', 'pre-evento', '--dir', dir, '--enviar', '--categorias-ligadas', 'pre-evento'], ENV);
    expect(r.code).toBe(0);
    expect(r.texto).toContain('não há o que avisar');
    expect(r.fetchImpl).not.toHaveBeenCalled();
  });
});
