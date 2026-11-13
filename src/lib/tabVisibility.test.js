// @vitest-environment jsdom
// "Aba escondida" (docs/known-risks.md item 301): a regra que todo poller usa para ficar quieto quando ninguém olha.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { isTabHidden } from './tabVisibility.js';

const set = (state) => Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });

describe('isTabHidden', () => {
  afterEach(() => {
    vi.unstubAllGlobals(); // primeiro: um teste deixa `document` indefinido
    delete document.visibilityState;
  });
  it('visível: não está escondida', () => {
    set('visible');
    expect(isTabHidden()).toBe(false);
  });
  it('escondida (outra aba na frente, janela minimizada, tela bloqueada): está', () => {
    set('hidden');
    expect(isTabHidden()).toBe(true);
  });
  it('estado desconhecido (ex.: "prerender") NÃO conta como escondida: só "hidden" pausa, igual ao React Query', () => {
    set('prerender');
    expect(isTabHidden()).toBe(false);
  });
  it('sem `document` (Node, scripts, SSR) nunca está escondida', () => {
    vi.stubGlobal('document', undefined);
    expect(isTabHidden()).toBe(false);
  });
});
