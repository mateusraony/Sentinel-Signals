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

// Item 257 (desdobramento) — auditoria de saúde de 06/10: todos os erros
// recentes de "Failed to fetch" do navegador vieram com a aba ESCONDIDA
// (`details.visibility: 'hidden'`, 7 de 7 com dado, 0 offline). O full scan de
// uma aba em segundo plano falha em rajada e ainda segura o lock de 10 min. O
// price-check (stop/TP por preço, caminho de segurança) NÃO é pulado.
describe('useAutoScan — aba escondida não faz full scan (item 257)', () => {
  const setVisibility = (state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    scanAllAssetsMock.mockReset().mockResolvedValue({ total: 1, results: [{ success: true }] });
    priceCheckActiveOpsMock.mockReset().mockResolvedValue(undefined);
    hasActiveTradeOpsMock.mockReset().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    delete document.visibilityState; // volta ao getter do jsdom
  });

  it('com a aba escondida o tick NÃO toca o banco: nem full scan, nem pergunta de operação ativa, nem price-check (item 301 trocou o do item 257)', async () => {
    setVisibility('hidden');
    renderHook(() => useAutoScan());

    await vi.advanceTimersByTimeAsync(90 * 1000);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);

    expect(scanAllAssetsMock).not.toHaveBeenCalled();
    expect(hasActiveTradeOpsMock).not.toHaveBeenCalled();
    expect(priceCheckActiveOpsMock).not.toHaveBeenCalled();
  });

  it('ao voltar a ficar visível, o full scan atrasado roda no tick seguinte (não espera 60 min)', async () => {
    setVisibility('hidden');
    renderHook(() => useAutoScan());

    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(scanAllAssetsMock).not.toHaveBeenCalled();

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(2 * 60 * 1000);
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(1);
  });
});

// Aba em segundo plano e custo no Neon (docs/known-risks.md item 301): o tick de 2 min perguntava ao banco se há operação ativa (`hasActiveTradeOps`) com a
// aba aberta OU escondida, e o Neon grátis só dorme depois de 5 min parado. Agora: aba escondida = nada; aba visível sem operação ativa = pergunta só a cada
// 30 min (e ao voltar para a aba); com operação ativa = a cada tick, como sempre (acompanhamento de stop/alvo a cada 2 min).
describe('useAutoScan — consulta ao banco só quando precisa (item 301)', () => {
  const setVisibility = (state) => {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  };
  const MIN = 60 * 1000;

  beforeEach(() => {
    vi.useFakeTimers();
    scanAllAssetsMock.mockReset().mockResolvedValue({ total: 0, results: [] });
    priceCheckActiveOpsMock.mockReset().mockResolvedValue(undefined);
    hasActiveTradeOpsMock.mockReset().mockResolvedValue(true);
  });
  afterEach(() => {
    vi.useRealTimers();
    delete document.visibilityState;
  });

  it('com operação ativa: a cada tick (2 min) pergunta ao banco e confere stop/alvo (comportamento de sempre)', async () => {
    renderHook(() => useAutoScan());
    await vi.advanceTimersByTimeAsync(90 * 1000); // 1º tick
    await vi.advanceTimersByTimeAsync(2 * MIN); // 2º
    await vi.advanceTimersByTimeAsync(2 * MIN); // 3º
    expect(hasActiveTradeOpsMock).toHaveBeenCalledTimes(3);
    expect(priceCheckActiveOpsMock).toHaveBeenCalledTimes(3);
  });

  it('SEM operação ativa: pergunta uma vez e só volta a perguntar daqui a 30 min (não a cada 2 min)', async () => {
    hasActiveTradeOpsMock.mockResolvedValue(false);
    renderHook(() => useAutoScan());
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(hasActiveTradeOpsMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(27 * MIN); // t ≈ 28,5 min
    expect(hasActiveTradeOpsMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(4 * MIN); // t ≈ 32,5 min: passou dos 30
    expect(hasActiveTradeOpsMock).toHaveBeenCalledTimes(2);
    expect(priceCheckActiveOpsMock).not.toHaveBeenCalled();
  });

  it('sem operação ativa o ciclo segue vivo: uma operação que surgir é pega na conferência de 30 min e passa a ser acompanhada a cada 2 min', async () => {
    hasActiveTradeOpsMock.mockResolvedValue(false);
    renderHook(() => useAutoScan());
    await vi.advanceTimersByTimeAsync(90 * 1000);
    hasActiveTradeOpsMock.mockResolvedValue(true); // o cron abriu uma operação
    await vi.advanceTimersByTimeAsync(31 * MIN);
    expect(priceCheckActiveOpsMock).toHaveBeenCalledTimes(1);
    const antes = hasActiveTradeOpsMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2 * MIN + 100);
    await vi.advanceTimersByTimeAsync(2 * MIN);
    expect(hasActiveTradeOpsMock.mock.calls.length).toBe(antes + 2); // de novo a cada tick
    expect(priceCheckActiveOpsMock).toHaveBeenCalledTimes(3);
  });

  it('a última operação fecha: volta a perguntar só a cada 30 min', async () => {
    hasActiveTradeOpsMock.mockResolvedValue(true);
    renderHook(() => useAutoScan());
    await vi.advanceTimersByTimeAsync(90 * 1000);
    hasActiveTradeOpsMock.mockResolvedValue(false); // fechou
    await vi.advanceTimersByTimeAsync(2 * MIN); // este tick descobre que não há mais
    const depois = hasActiveTradeOpsMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(hasActiveTradeOpsMock.mock.calls.length).toBe(depois);
  });

  it('aba escondida: nenhum acesso ao banco por mais que o tempo passe', async () => {
    setVisibility('hidden');
    renderHook(() => useAutoScan());
    await vi.advanceTimersByTimeAsync(90 * MIN);
    expect(hasActiveTradeOpsMock).not.toHaveBeenCalled();
    expect(priceCheckActiveOpsMock).not.toHaveBeenCalled();
    expect(scanAllAssetsMock).not.toHaveBeenCalled();
  });

  it('o ciclo continua vivo com a aba escondida: ao voltar, o próximo tick (≤ 2 min) já pergunta e roda o full scan atrasado', async () => {
    setVisibility('hidden');
    renderHook(() => useAutoScan());
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(hasActiveTradeOpsMock).not.toHaveBeenCalled();
    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(2 * MIN + 100);
    expect(hasActiveTradeOpsMock).toHaveBeenCalled();
    expect(scanAllAssetsMock).toHaveBeenCalledTimes(1);
  });

  it('ao VOLTAR para a aba pergunta de novo no próximo tick, sem esperar os 30 min (pode ter surgido uma operação enquanto estava escondida)', async () => {
    hasActiveTradeOpsMock.mockResolvedValue(false);
    renderHook(() => useAutoScan());
    await vi.advanceTimersByTimeAsync(90 * 1000);
    expect(hasActiveTradeOpsMock).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(4 * MIN);
    setVisibility('visible'); // t ≈ 5,5 min: muito antes dos 30 min
    await vi.advanceTimersByTimeAsync(2 * MIN + 100);
    expect(hasActiveTradeOpsMock).toHaveBeenCalledTimes(2);
  });

  it('desmontar remove o ouvinte de visibilidade e o temporizador', async () => {
    const adiciona = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const tela = renderHook(() => useAutoScan());
    const ouvinte = adiciona.mock.calls.find((c) => c[0] === 'visibilitychange')?.[1];
    expect(typeof ouvinte).toBe('function');
    tela.unmount();
    expect(remove).toHaveBeenCalledWith('visibilitychange', ouvinte); // o MESMO ouvinte que foi registrado
    adiciona.mockRestore();
    remove.mockRestore();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(hasActiveTradeOpsMock).not.toHaveBeenCalled();
    setVisibility('hidden');
    setVisibility('visible');
    expect(hasActiveTradeOpsMock).not.toHaveBeenCalled();
  });
});
