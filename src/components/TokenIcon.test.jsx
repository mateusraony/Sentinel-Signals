// @vitest-environment jsdom
// Ícone do token (pedido do usuário, 11/11/2026): o logo do token ao lado do nome; sem logo, uma bolinha com a inicial. Sempre decorativo e SEM texto no DOM
// (a letra vem do CSS), para nunca atrapalhar leitor de tela nem as buscas por texto dos testes.
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import TokenIcon, { TOKEN_ICON_TICKERS, hasTokenLogo } from './TokenIcon.jsx';

afterEach(() => cleanup());

const COM_LOGO = ['AAVE', 'ADA', 'ARB', 'ATOM', 'AVAX', 'BNB', 'BTC', 'CRV', 'DOGE', 'DOT', 'DYDX', 'ETC', 'ETH', 'FET', 'FIL', 'ICP', 'LDO', 'LINK', 'LTC', 'METIS', 'NEAR', 'OP', 'PAXG', 'PENDLE', 'SOL', 'SUI', 'TRX', 'UNI', 'USDT', 'XRP', 'XTZ', 'ZIL'];
const SEM_LOGO = ['ZRO', 'ENA', 'ETHFI', 'ONDO', 'INJ', 'EIGEN'];

describe('TokenIcon — com logo', () => {
  it('BTC mostra a imagem do logo: decorativa (alt vazio, escondida do leitor de tela), do tamanho pedido e sem nenhum texto', () => {
    const { container } = render(<TokenIcon symbol="BTCUSDT" size={20} />);
    const img = container.querySelector('img[data-token="BTC"]');
    expect(img).not.toBeNull();
    expect(img.getAttribute('src')).toBeTruthy();
    expect(img.getAttribute('alt')).toBe('');
    expect(img.getAttribute('aria-hidden')).toBe('true');
    expect(img.getAttribute('width')).toBe('20');
    expect(img.getAttribute('height')).toBe('20');
    expect(container.textContent).toBe('');
  });

  it('as várias grafias do mesmo par dão o MESMO logo (BTCUSDT, BTC/USDT, btc, BTC-USDT)', () => {
    const src = (symbol) => {
      const { container, unmount } = render(<TokenIcon symbol={symbol} />);
      const s = container.querySelector('img')?.getAttribute('src');
      unmount();
      return s;
    };
    const ref = src('BTCUSDT');
    expect(ref).toBeTruthy();
    for (const s of ['BTC/USDT', 'btc', 'BTC-USDT', ' btcusdt ']) expect(src(s), s).toBe(ref);
    expect(src('ETHUSDT')).not.toBe(ref);
  });

  it('os 32 tokens que têm logo no pacote estão todos na pasta (e nenhum a mais por engano)', () => {
    expect([...TOKEN_ICON_TICKERS].sort()).toEqual([...COM_LOGO].sort());
    for (const t of COM_LOGO) {
      const { container, unmount } = render(<TokenIcon symbol={`${t}USDT`} />);
      expect(container.querySelector(`img[data-token="${t}"]`), t).not.toBeNull();
      unmount();
    }
  });

  it('o ícone não altera o texto da tela: o nome ao lado continua sendo achado por getByText', () => {
    render(<div><TokenIcon symbol="BTCUSDT" /><span>BTC/USDT</span></div>);
    expect(screen.getByText('BTC/USDT')).toBeTruthy();
  });
});

describe('TokenIcon — sem logo (bolinha com a inicial)', () => {
  it('token novo (ENA, ZRO, ETHFI, ONDO, INJ, EIGEN) vira uma bolinha com a inicial vinda do CSS, nunca texto no DOM', () => {
    for (const t of SEM_LOGO) {
      const { container, unmount } = render(<TokenIcon symbol={`${t}USDT`} size={18} />);
      expect(container.querySelector('img'), t).toBeNull();
      const bolinha = container.querySelector(`span[data-token="${t}"]`);
      expect(bolinha, t).not.toBeNull();
      expect(bolinha.getAttribute('data-letter')).toBe(t[0]);
      expect(bolinha.getAttribute('aria-hidden')).toBe('true');
      expect(bolinha.style.width).toBe('18px');
      expect(bolinha.style.background).toMatch(/^(hsl|rgb)/); // o jsdom converte hsl em rgb
      expect(bolinha.className).toMatch(/before:content-\[attr\(data-letter\)\]/);
      expect(container.textContent, t).toBe('');
      unmount();
    }
  });

  it('a letra da bolinha nunca colide com uma busca por texto (uma letra "B" solta é achada só uma vez)', () => {
    render(<div><TokenIcon symbol="BEAMUSDT" /><span>B</span></div>);
    expect(screen.getAllByText('B')).toHaveLength(1);
  });
});

describe('TokenIcon — entrada sem token', () => {
  it('símbolo vazio, inválido ou ausente: não desenha nada', () => {
    for (const symbol of ['', '   ', '/-', null, undefined, 42]) {
      const { container, unmount } = render(<TokenIcon symbol={symbol} />);
      expect(container.innerHTML, String(symbol)).toBe('');
      unmount();
    }
  });
});

describe('hasTokenLogo — o token tem logo na pasta? (usado no cadastro de ativo novo)', () => {
  it('token com logo (em qualquer grafia) sim; token novo, vazio e inválido não', () => {
    for (const t of COM_LOGO) expect(hasTokenLogo(`${t}USDT`), t).toBe(true);
    expect(hasTokenLogo('btc/usdt')).toBe(true);
    for (const t of SEM_LOGO) expect(hasTokenLogo(`${t}USDT`), t).toBe(false);
    for (const x of ['', '  ', null, undefined, 42]) expect(hasTokenLogo(x), String(x)).toBe(false);
  });
});
