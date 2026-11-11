// Ícone do token (pedido do usuário, 11/11/2026): do símbolo ("BTCUSDT", "BTC/USDT", "BTC") ao ticker do token ("BTC") — função PURA.
import { describe, it, expect } from 'vitest';
import { baseAsset, monogramColor } from './tokenIcons';

describe('baseAsset — o token por trás do símbolo', () => {
  it('par com USDT (colado, com barra ou com hífen) devolve só o token', () => {
    expect(baseAsset('BTCUSDT')).toBe('BTC');
    expect(baseAsset('BTC/USDT')).toBe('BTC');
    expect(baseAsset('eth-usdt')).toBe('ETH');
    expect(baseAsset('  sol/usdt ')).toBe('SOL');
  });

  it('outras moedas de cotação (USDC, FDUSD, BUSD, TUSD, USD) também saem', () => {
    expect(baseAsset('ETHUSDC')).toBe('ETH');
    expect(baseAsset('BNBFDUSD')).toBe('BNB');
    expect(baseAsset('ADABUSD')).toBe('ADA');
    expect(baseAsset('XRPTUSD')).toBe('XRP');
    expect(baseAsset('DOGEUSD')).toBe('DOGE');
  });

  it('só o token (sem cotação) fica como está', () => {
    expect(baseAsset('BTC')).toBe('BTC');
    expect(baseAsset('pendle')).toBe('PENDLE');
  });

  it('as próprias moedas de cotação não viram vazio: USDT é USDT, e USDC/USDT é USDC', () => {
    expect(baseAsset('USDT')).toBe('USDT');
    expect(baseAsset('USDCUSDT')).toBe('USDC');
    expect(baseAsset('BUSDUSDT')).toBe('BUSD');
  });

  it('prefixo de multiplicador da Binance (1000PEPE, 1MBABYDOGE) sai, mas 1INCH não é mexido', () => {
    expect(baseAsset('1000PEPEUSDT')).toBe('PEPE');
    expect(baseAsset('1MBABYDOGEUSDT')).toBe('BABYDOGE');
    expect(baseAsset('1INCHUSDT')).toBe('1INCH');
  });

  it('entrada inválida (vazia, sem letra, não texto): null', () => {
    expect(baseAsset('')).toBeNull();
    expect(baseAsset('  ')).toBeNull();
    expect(baseAsset('/-')).toBeNull();
    expect(baseAsset(null)).toBeNull();
    expect(baseAsset(undefined)).toBeNull();
    expect(baseAsset(42)).toBeNull();
  });
});

describe('monogramColor — cor estável por token (para quem não tem logo)', () => {
  it('o mesmo token sempre dá a mesma cor, tokens diferentes costumam dar cores diferentes', () => {
    expect(monogramColor('ENA')).toBe(monogramColor('ENA'));
    const cores = new Set(['ENA', 'ZRO', 'ETHFI', 'ONDO', 'INJ', 'EIGEN'].map(monogramColor));
    expect(cores.size).toBeGreaterThanOrEqual(4);
  });

  it('é um hsl com luminosidade baixa (letra branca por cima mantém contraste ≥ 4,5:1)', () => {
    for (const t of ['ENA', 'ZRO', 'ETHFI', 'ONDO', 'INJ', 'EIGEN', 'A', '1INCH']) {
      const m = monogramColor(t).match(/^hsl\((\d+) (\d+)% (\d+)%\)$/);
      expect(m, t).not.toBeNull();
      expect(Number(m[1])).toBeGreaterThanOrEqual(0);
      expect(Number(m[1])).toBeLessThan(360);
      expect(Number(m[3])).toBeLessThanOrEqual(38);
    }
  });
});
