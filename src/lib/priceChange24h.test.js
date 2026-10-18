import { describe, it, expect } from 'vitest';
import { describeChange24h, resolvePriceDisplay } from './priceChange24h.js';
import { parse24hStats } from './ticker24h.js';

// Item 279 (PR-D): o cartão mostrava o preço do fechamento da vela (AssetState)
// ao lado de uma variação de 24h vinda de outra fonte e de outro instante, sem
// dizer o que era. Agora preço e % vêm da MESMA resposta do ticker 24h da
// Futures, com rótulo, e falha nunca vira "NaN%" nem some em silêncio.
const NOW = 1792287608474 + 10_000;

describe('parse24hStats (resposta crua do /fapi/v1/ticker/24hr)', () => {
  const raw = {
    closeTime: 1792287608474, lastPrice: '81722.60', priceChange: '245.30', priceChangePercent: '0.301',
    highPrice: '81733.00', lowPrice: '80751.00', volume: '46717.540', quoteVolume: '3802870989.38',
  };

  it('lê preço, % e horário da mesma resposta', () => {
    const s = parse24hStats(raw);
    expect(s.lastPrice).toBe(81722.6);
    expect(s.priceChangePercent).toBeCloseTo(0.301);
    expect(s.closeTime).toBe(1792287608474);
  });

  it('campo ausente ou inválido vira null, nunca NaN', () => {
    const s = parse24hStats({ priceChangePercent: 'abc' });
    expect(s.lastPrice).toBeNull();
    expect(s.closeTime).toBeNull();
    expect(s.priceChangePercent).toBeNull();
    expect(parse24hStats(null)).toBeNull();
  });
});

describe('describeChange24h', () => {
  const stats = (pct, extra = {}) => ({ priceChangePercent: pct, lastPrice: 100, closeTime: NOW - 10_000, ...extra });

  it('alta: 📈 com sinal e fonte', () => {
    expect(describeChange24h(stats(2.1), NOW)).toMatchObject({ available: true, icon: '📈', text: '📈 +2.10% em 24h · Futures', price: 100 });
  });

  it('queda: 📉 com sinal', () => {
    expect(describeChange24h(stats(-0.45), NOW).text).toBe('📉 -0.45% em 24h · Futures');
  });

  it('zero: sem seta (não é alta nem queda)', () => {
    const d = describeChange24h(stats(0), NOW);
    expect(d.icon).toBe('');
    expect(d.text).toBe('0.00% em 24h · Futures');
  });

  it('sem dado, erro ou objeto vazio: "% 24h indisponível", nunca NaN', () => {
    for (const s of [null, undefined, {}, { priceChangePercent: null }, { priceChangePercent: NaN }]) {
      const d = describeChange24h(s, NOW);
      expect(d.available).toBe(false);
      expect(d.text).toBe('% 24h indisponível');
      expect(d.text).not.toMatch(/NaN/);
    }
  });

  it('dado velho (mais de 3 min) fica marcado como desatualizado', () => {
    expect(describeChange24h(stats(1, { closeTime: NOW - 5 * 60_000 }), NOW).stale).toBe(true);
    expect(describeChange24h(stats(1), NOW).stale).toBe(false);
    // Sem horário não há como afirmar frescor.
    expect(describeChange24h(stats(1, { closeTime: null }), NOW).stale).toBe(true);
  });

  it('REGRESSÃO (review do PR-D): com fetchedAt, o frescor ignora o relógio da Binance (PC adiantado/atrasado)', () => {
    // closeTime 10 min "no passado" pelo relógio local (PC adiantado), mas buscado agora.
    const s = stats(1, { closeTime: NOW - 10 * 60_000 });
    expect(describeChange24h(s, NOW, { fetchedAt: NOW - 5_000 }).stale).toBe(false);
    expect(describeChange24h(s, NOW, { fetchedAt: NOW - 5 * 60_000 }).stale).toBe(true);
  });

  it('tom e sinal prontos para a tela', () => {
    expect(describeChange24h(stats(2), NOW)).toMatchObject({ tone: 'up', signed: '+2.00%' });
    expect(describeChange24h(stats(-1), NOW)).toMatchObject({ tone: 'down', signed: '-1.00%' });
    expect(describeChange24h(stats(0), NOW)).toMatchObject({ tone: 'flat', signed: '0.00%' });
    expect(describeChange24h(null, NOW).tone).toBe('none');
  });

  it('preço inválido ou zero não é usado (contrato encerrado devolve 0)', () => {
    expect(describeChange24h(stats(1, { lastPrice: null }), NOW).price).toBeNull();
    expect(describeChange24h(stats(0, { lastPrice: 0 }), NOW).price).toBeNull();
  });

  it('REGRESSÃO (review do PR-D): busca que falhou conta como desatualizado mesmo dentro dos 3 min', () => {
    expect(describeChange24h(stats(1), NOW, { fetchedAt: NOW - 30_000, isError: true }).stale).toBe(true);
  });

  it('REGRESSÃO (review do PR-D): carregando não diz "indisponível"', () => {
    expect(describeChange24h(undefined, NOW, { isLoading: true }).text).toBe('% 24h carregando…');
    expect(describeChange24h(undefined, NOW, { isLoading: true, isError: true }).text).toBe('% 24h indisponível');
  });

  it('a fonte é parâmetro (padrão Futures)', () => {
    expect(describeChange24h(stats(1), NOW, { source: 'Spot' }).text).toBe('📈 +1.00% em 24h · Spot');
  });
});

// Review do PR-D (3ª rodada): regra única de exibição. Preço e % sempre do
// mesmo instante; quando cai no fechamento da vela, a % antiga não aparece
// como atual e o preço vem marcado como fechamento.
describe('resolvePriceDisplay', () => {
  const fresh = describeChange24h({ priceChangePercent: 2, lastPrice: 102, closeTime: NOW }, NOW, { fetchedAt: NOW });
  const stale = describeChange24h({ priceChangePercent: 2, lastPrice: 102, closeTime: NOW }, NOW, { fetchedAt: NOW, isError: true });
  const none = describeChange24h(null, NOW);

  it('ticker fresco: preço do ticker com a % ao lado', () => {
    expect(resolvePriceDisplay(fresh, 100)).toMatchObject({ price: 102, isCandle: false, pctText: '📈 +2.00% em 24h · Futures', tone: 'up' });
  });

  it('ticker velho: fechamento da vela marcado, e a % antiga vira "desatualizado"', () => {
    expect(resolvePriceDisplay(stale, 100)).toMatchObject({ price: 100, isCandle: true, pctText: '% 24h desatualizado', tone: 'none' });
  });

  it('sem ticker: fechamento da vela e "% 24h indisponível"', () => {
    expect(resolvePriceDisplay(none, 100)).toMatchObject({ price: 100, isCandle: true, pctText: '% 24h indisponível' });
  });

  it('ticker fresco sem preço válido: cai no fechamento, marcado', () => {
    const semPreco = describeChange24h({ priceChangePercent: 1, lastPrice: 0, closeTime: NOW }, NOW, { fetchedAt: NOW });
    expect(resolvePriceDisplay(semPreco, 100)).toMatchObject({ price: 100, isCandle: true });
  });

  // Achado do Codex (P2, PR #505): com % válida e `lastPrice` ausente/zero, o
  // fechamento da vela aparecia ao lado da % do ticker, colorida e "fresca" —
  // preço e variação de instantes diferentes de novo.
  it('ticker sem preço válido: a % não acompanha o fechamento da vela', () => {
    for (const lastPrice of [0, undefined, 'abc']) {
      const semPreco = describeChange24h({ priceChangePercent: 1, lastPrice, closeTime: NOW }, NOW, { fetchedAt: NOW });
      expect(resolvePriceDisplay(semPreco, 100)).toMatchObject({ pctText: '% 24h indisponível', tone: 'none', fresh: false });
    }
  });
});
