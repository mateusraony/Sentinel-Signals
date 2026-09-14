// Achado do sentinel-security-review (P1, 2026-09-14): falha por-ativo dentro
// de scanAllAssets()/priceCheckActiveOps() era só logada, nunca propagada —
// o job do GitHub Actions ficava verde mesmo com ativos falhando toda
// passada. `computeHasPartialFailures`/`exitCodeForScanResult` extraídas de
// run-scan.mjs's main() especificamente pra serem testáveis sem rodar o scan
// de verdade (mesmo raciocínio de scanTimeout.mjs's avaliarExecucao).
import { describe, it, expect, vi } from 'vitest';

// run-scan.mjs importa `@/api/entities` (via si mesmo e via src/lib/scanner.js)
// — em produção, scripts/build-scan.mjs redireciona isso pra
// scripts/adminEntities.js via esbuild, mas um import direto do Vitest
// resolve pro módulo real (src/api/entities.js), que inicializa o Firebase
// Auth no carregamento e quebra sem as env vars VITE_FIREBASE_*. Só as
// funções puras deste arquivo importam aqui embaixo — nenhuma toca `backend`.
vi.mock('@/api/entities', () => ({ backend: {} }));

import { computeHasPartialFailures, exitCodeForScanResult } from './run-scan.mjs';

describe('computeHasPartialFailures', () => {
  it('false quando as duas listas estão vazias (passada 100% limpa)', () => {
    expect(computeHasPartialFailures([], [])).toBe(false);
  });

  it('true quando algum ativo falhou em scanAllAssets', () => {
    expect(computeHasPartialFailures([{ symbol: 'BTCUSDT', error: 'boom' }], [])).toBe(true);
  });

  it('true quando alguma op falhou em priceCheckActiveOps', () => {
    expect(computeHasPartialFailures([], [{ error: 'boom' }])).toBe(true);
  });

  it('true quando as duas listas têm falha', () => {
    expect(computeHasPartialFailures([{ symbol: 'BTCUSDT' }], [{ error: 'boom' }])).toBe(true);
  });
});

describe('exitCodeForScanResult', () => {
  it('0 quando não há falha parcial — reproduz o caminho de sucesso existente', () => {
    expect(exitCodeForScanResult({ hasPartialFailures: false })).toBe(0);
  });

  // Reprodução do bug: antes desta correção, o processo sempre saía com 0
  // aqui, mesmo com ativos falhando — é exatamente o que este caso prova
  // que não acontece mais.
  it('1 quando há falha parcial — o job do GitHub Actions deve ficar vermelho', () => {
    expect(exitCodeForScanResult({ hasPartialFailures: true })).toBe(1);
  });
});
