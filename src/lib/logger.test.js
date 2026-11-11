// @vitest-environment jsdom
// Logger global — captura de erros do navegador no SystemLog.
// Achado real (11/11/2026): o Debug Log mostrou "Unhandled Promise: Failed to connect to MetaMask" com a pilha em
// chrome-extension://…/inpage.js. Quem lança isso é a EXTENSÃO MetaMask do navegador do usuário (ela injeta um script em toda página);
// o Sentinel não usa carteira nenhuma. O logger global não sabia separar erro do app de erro de extensão e gravava os dois como "ERROR".
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';

const { bulkCreate } = vi.hoisted(() => ({ bulkCreate: vi.fn() }));
vi.mock('@/api/entities', () => ({
  backend: {
    entities: {
      SystemLog: { bulkCreate },
      MonitoredAsset: { filter: vi.fn().mockResolvedValue([]) },
      TradeOperation: { filter: vi.fn().mockResolvedValue([]) },
    },
  },
}));

import { initLogger, isBrowserExtensionNoise } from './logger';

const EXT_FRAME = 'at Object.connect (chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js:9:6184)';
const APP_FRAME = 'at connect (https://sentinel-signals.onrender.com/assets/index-abc123.js:1:2345)';

function rejection(reason) {
  const ev = new Event('unhandledrejection');
  Object.defineProperty(ev, 'reason', { value: reason });
  window.dispatchEvent(ev);
}

function windowError(message, filename) {
  const ev = new Event('error');
  Object.defineProperty(ev, 'message', { value: message });
  Object.defineProperty(ev, 'filename', { value: filename });
  Object.defineProperty(ev, 'lineno', { value: 1 });
  Object.defineProperty(ev, 'colno', { value: 1 });
  window.dispatchEvent(ev);
}

const withStack = (message, frame) => Object.assign(new Error(message), { stack: `Error: ${message}\n    ${frame}` });

/** Tudo que já foi gravado no SystemLog (esvazia a fila do logger antes de ler). */
async function gravados() {
  await vi.advanceTimersByTimeAsync(6000);
  return bulkCreate.mock.calls.flatMap((c) => c[0]);
}

describe('isBrowserExtensionNoise (função pura)', () => {
  it('pilha cujo PRIMEIRO frame é de extensão (Chrome, Firefox, Safari) é ruído', () => {
    expect(isBrowserExtensionNoise({ stack: `Error: x\n    ${EXT_FRAME}` })).toBe(true);
    expect(isBrowserExtensionNoise({ stack: 'connect@moz-extension://1234-abcd/inpage.js:9:6184\nfoo@https://app/x.js:1:1' })).toBe(true);
    expect(isBrowserExtensionNoise({ stack: 'connect@safari-web-extension://AB12/inpage.js:9:6184' })).toBe(true);
  });

  it('erro de janela com o arquivo da extensão é ruído', () => {
    expect(isBrowserExtensionNoise({ filename: 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/scripts/inpage.js' })).toBe(true);
  });

  it('erro do PRÓPRIO app nunca é ruído (nem quando um frame mais abaixo é de extensão)', () => {
    expect(isBrowserExtensionNoise({ stack: `Error: x\n    ${APP_FRAME}` })).toBe(false);
    expect(isBrowserExtensionNoise({ stack: `Error: x\n    ${APP_FRAME}\n    ${EXT_FRAME}` })).toBe(false);
    expect(isBrowserExtensionNoise({ filename: 'https://sentinel-signals.onrender.com/assets/index-abc123.js' })).toBe(false);
  });

  it('a palavra "extension" no texto da mensagem não conta; sem pilha nem arquivo, não é ruído', () => {
    expect(isBrowserExtensionNoise({ stack: 'Error: chrome-extension://x falhou\n    ' + APP_FRAME })).toBe(false);
    expect(isBrowserExtensionNoise({})).toBe(false);
    expect(isBrowserExtensionNoise()).toBe(false);
    expect(isBrowserExtensionNoise({ stack: 42, filename: null })).toBe(false);
  });
});

describe('initLogger — o que vai para o SystemLog', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    initLogger();
  });
  afterAll(() => vi.useRealTimers());
  beforeEach(() => bulkCreate.mockReset().mockResolvedValue([]));

  it('REGRESSÃO: "Failed to connect to MetaMask" vindo da extensão NÃO é gravado', async () => {
    rejection(withStack('Failed to connect to MetaMask', EXT_FRAME));
    const logs = await gravados();
    expect(logs.filter((l) => /MetaMask/.test(l.message))).toEqual([]);
  });

  it('o mesmo texto vindo do código do app CONTINUA sendo gravado (o filtro não esconde erro nosso)', async () => {
    rejection(withStack('Failed to connect to MetaMask (do app)', APP_FRAME));
    const logs = await gravados();
    expect(logs.filter((l) => /do app/.test(l.message))).toHaveLength(1);
    expect(logs.find((l) => /do app/.test(l.message)).level).toBe('error');
  });

  it('rejeição sem pilha (texto solto) continua gravada', async () => {
    rejection('algo falhou sem pilha');
    const logs = await gravados();
    expect(logs.filter((l) => /algo falhou sem pilha/.test(l.message))).toHaveLength(1);
  });

  it('erro de janela: arquivo da extensão não é gravado; arquivo do app é', async () => {
    windowError('Extension context invalidated', 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn/content.js');
    windowError('Cannot read properties of undefined (do app)', 'https://sentinel-signals.onrender.com/assets/index-abc123.js');
    const logs = await gravados();
    expect(logs.filter((l) => /Extension context invalidated/.test(l.message))).toEqual([]);
    expect(logs.filter((l) => /do app/.test(l.message))).toHaveLength(1);
  });
});
