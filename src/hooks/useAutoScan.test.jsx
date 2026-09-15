/**
 * @vitest-environment jsdom
 *
 * Achado do sentinel-security-review (P1, 2026-09-14): `lastFullScan.current`
 * era setado ANTES do `await scanAllAssets()` — uma falha marcava a
 * tentativa como se fosse sucesso, e a próxima passagem completa só
 * acontecia depois da janela de 60min inteira. Este teste reproduz o bug
 * (falharia contra o código antigo) e prova a correção: uma falha na
 * primeira passada faz o PRÓXIMO tick (2min depois) tentar de novo, em vez
 * de esperar os 60min inteiros.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAutoScan } from './useAutoScan';

const { scanAllAssetsMock, priceCheckActiveOpsMock, hasActiveTradeOpsMock } = vi.hoisted(() => ({
  scanAllAssetsMock: vi.fn(),
  priceCheckActiveOpsMock: vi.fn(),
  hasActiveTradeOpsMock: vi.fn(),
}));

vi.mock('@/lib/scanner', () => ({
  scanAllAssets: scanAllAssetsMock,
  priceCheckActiveOps: priceCheckActiveOpsMock,
  hasActiveTradeOps: hasActiveTradeOpsMock,
}));

describe('useAutoScan — full scan não distingue tentativa de sucesso', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    scanAllAssetsMock.mockReset();
    priceCheckActiveOpsMock.mockReset().mockResolvedValue(undefined);
    hasActiveTradeOpsMock.mockReset().mockResolvedValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tenta o full scan de novo no PRÓXIMO tick (2min) depois de uma falha, sem esperar os 60min inteiros', async () => {
    scanAllAssetsMock
      .mockRejectedValueOnce(new Error('falha transitória de rede'))
      .mockResolvedValueOnce({ total: 0, results: [] });

    renderHook(() => useAutoScan());

    // 1ª passada, após o delay inicial de 90s — lastFullScan.current começa
    // em 0, então "agora - 0 >= 60min" é verdadeiro e ela tenta o full scan.
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(1);

    // 2ª passada, só 2min depois (PRICE_CHECK_INTERVAL) — SOB O BUG, isso não
    // tentaria de novo (lastFullScan.current teria sido marcado como "feito"
    // mesmo a 1ª chamada tendo falhado, e só tentaria de novo depois de
    // 60min). Com a correção, a falha não marcou lastFullScan.current, então
    // tenta de novo aqui.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(2);
  });

  it('sucesso na 1ª passada NÃO dispara um full scan de novo no tick seguinte (2min depois)', async () => {
    scanAllAssetsMock.mockResolvedValue({ total: 2, results: [{ success: true }, { success: true }] });

    renderHook(() => useAutoScan());

    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(1);

    // lastFullScan.current foi atualizado no sucesso — o próximo tick (2min
    // depois, bem dentro da janela de 60min) faz price-check, não full scan.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(1);
    expect(hasActiveTradeOpsMock).toHaveBeenCalled();
  });

  // Achado da auditoria externa (2026-09-15): scanAllAssets() (src/lib/
  // scanner.js) captura erro POR ATIVO e resolve normalmente com
  // `results: [{success:false}, ...]`, nunca lança pra esse caso — os 2
  // testes acima só cobriam a chamada INTEIRA rejeitando. Mesma classe de
  // bug já corrigida no cron (run-scan.mjs) e no modo sombra
  // (run-scan-shadow.mjs, PR #366), nunca portada pro auto-scan do painel.
  it('falha PARCIAL (resolve, mas com ativo com success:false) também não marca a passada como completa', async () => {
    scanAllAssetsMock
      .mockResolvedValueOnce({ total: 2, results: [{ success: true }, { success: false, symbol: 'BTCUSDT', error: 'boom' }] })
      .mockResolvedValueOnce({ total: 2, results: [{ success: true }, { success: true }] });

    renderHook(() => useAutoScan());

    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(1);

    // Sob o bug, a promise resolvida (sem lançar) já marcava lastFullScan —
    // só tentaria de novo depois dos 60min inteiros. Com a correção, a
    // falha parcial também deixa lastFullScan intocado.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(2);
  });

  // Achado do Codex (review do PR #370, P1): a correção acima (deixar
  // lastFullScan.current intocado numa falha) tinha um `return` logo depois
  // que impedia o price-check de rodar NESSA MESMA passada — inofensivo
  // numa falha isolada, mas com um ativo com erro PERSISTENTE (ex.: símbolo
  // deslistado), toda passada de 2min reentrava no bloco de full scan e
  // retornava antes de chegar no price-check, suspendendo a checagem de
  // stop/TP por preço de TODAS as operações ativas indefinidamente.
  it('falha PERSISTENTE no full scan não trava o price-check — ele continua rodando a cada tick', async () => {
    scanAllAssetsMock.mockResolvedValue({ total: 1, results: [{ success: false, symbol: 'BTCUSDT', error: 'falha persistente' }] });
    hasActiveTradeOpsMock.mockResolvedValue(true);

    renderHook(() => useAutoScan());

    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(1);
    expect(priceCheckActiveOpsMock).toHaveBeenCalledTimes(1);

    // full scan segue "devido" em CADA tick (lastFullScan nunca avança com
    // a falha persistente) — sob o bug, isso significava price-check NUNCA
    // MAIS rodando. Com a correção, os dois rodam em toda passada.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(2);
    expect(priceCheckActiveOpsMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(3);
    expect(priceCheckActiveOpsMock).toHaveBeenCalledTimes(3);
  });
});
