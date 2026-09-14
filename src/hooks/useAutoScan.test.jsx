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
      .mockResolvedValueOnce(undefined);

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
    scanAllAssetsMock.mockResolvedValue(undefined);

    renderHook(() => useAutoScan());

    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(1);

    // lastFullScan.current foi atualizado no sucesso — o próximo tick (2min
    // depois, bem dentro da janela de 60min) faz price-check, não full scan.
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(1);
    expect(hasActiveTradeOpsMock).toHaveBeenCalled();
  });
});
