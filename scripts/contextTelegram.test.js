// Item 285, addendum 12 — o remetente de Telegram do Contexto (sem banco). Rede toda simulada. O que se prova:
// manda o POST certo, falha devolve só um CÓDIGO e o token NUNCA aparece no resultado nem no que o relatório mostra
// (uma mensagem de erro de rede pode citar a URL, que tem o token), sem credencial nem chama a rede.
import { describe, it, expect, vi } from 'vitest';
import { sendTelegram, describeSendFailure, TELEGRAM_MAX_CHARS } from './contextTelegram.mjs';

const TOKEN = '123456789:AAFakeTokenValueUsedOnlyInTests_abcdefghij';
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '987654321' };
const okRes = (status = 200) => ({ ok: status >= 200 && status < 300, status });

describe('sendTelegram — envio', () => {
  it('faz 1 POST ao sendMessage com chat, texto em HTML e sem pré-visualização de link', async () => {
    const fetchImpl = vi.fn(async () => okRes());
    const out = await sendTelegram({ text: '<b>oi</b>', env: ENV, fetchImpl });
    expect(out).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ chat_id: '987654321', text: '<b>oi</b>', parse_mode: 'HTML', disable_web_page_preview: true });
  });

  it('sem credenciais (um dos dois, ou os dois): não chama a rede', async () => {
    const fetchImpl = vi.fn(async () => okRes());
    for (const env of [{}, { TELEGRAM_BOT_TOKEN: TOKEN }, { TELEGRAM_CHAT_ID: '1' }, { TELEGRAM_BOT_TOKEN: '  ', TELEGRAM_CHAT_ID: '1' }]) {
      expect(await sendTelegram({ text: 'x', env, fetchImpl })).toEqual({ ok: false, reason: 'sem_credenciais' });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('texto vazio ou maior que 4.096 caracteres é recusado (nunca cortado no meio de uma tag), sem chamar a rede', async () => {
    const fetchImpl = vi.fn(async () => okRes());
    expect(await sendTelegram({ text: '   ', env: ENV, fetchImpl })).toEqual({ ok: false, reason: 'texto_vazio' });
    expect(await sendTelegram({ text: 'a'.repeat(TELEGRAM_MAX_CHARS + 1), env: ENV, fetchImpl })).toEqual({ ok: false, reason: 'texto_longo' });
    expect((await sendTelegram({ text: 'a'.repeat(TELEGRAM_MAX_CHARS), env: ENV, fetchImpl })).ok).toBe(true); // no limite ainda vale
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('sendTelegram — falhas devolvem só um código e nunca o token', () => {
  it('erros HTTP viram http_<status>', async () => {
    for (const status of [400, 401, 403, 404, 429, 500]) {
      const out = await sendTelegram({ text: 'x', env: ENV, fetchImpl: async () => okRes(status) });
      expect(out).toEqual({ ok: false, reason: `http_${status}` });
    }
  });

  it('rede caiu: o erro cita a URL com o token, e mesmo assim o resultado traz só "rede"', async () => {
    const fetchImpl = async (url) => { throw new TypeError(`fetch failed: ${url}`); };
    const out = await sendTelegram({ text: 'x', env: ENV, fetchImpl });
    expect(out).toEqual({ ok: false, reason: 'rede' });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
  });

  it('prazo estourado vira "prazo"', async () => {
    const fetchImpl = (url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    expect(await sendTelegram({ text: 'x', env: ENV, fetchImpl, timeoutMs: 20 })).toEqual({ ok: false, reason: 'prazo' });
  });

  it('sem fetch no ambiente vira "rede"', async () => {
    expect(await sendTelegram({ text: 'x', env: ENV, fetchImpl: null })).toEqual({ ok: false, reason: 'rede' });
  });

  it('o texto do relatório (describeSendFailure) é em português, cobre todos os códigos e nunca tem o token', () => {
    const codigos = ['sem_credenciais', 'texto_vazio', 'texto_longo', 'http_400', 'http_401', 'http_403', 'http_404', 'http_429', 'http_500', 'prazo', 'rede', 'qualquer'];
    for (const c of codigos) {
      const t = describeSendFailure(c);
      expect(t.length).toBeGreaterThan(10);
      expect(t).not.toContain(TOKEN);
    }
    expect(describeSendFailure('http_401')).toMatch(/token/);
    expect(describeSendFailure('http_500')).toMatch(/500/);
  });
});
