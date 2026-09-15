// Achado da auditoria externa (2026-09-15): scanAllAssets()/
// priceCheckActiveOps() capturam erro por-ativo e devolvem {success:false}
// em vez de lançar — main() terminava normal mesmo com TODOS os ativos
// falhando, então o job do GitHub Actions ficava verde. Mesma classe de bug
// que run-scan.test.mjs já cobre pro scan principal (P1), nunca portada pro
// modo sombra. `hasPartialFailures` extraída pra ser testável sem rodar o
// scan de verdade (mesmo raciocínio de run-scan.mjs's computeHasPartialFailures).
import { describe, it, expect, vi } from 'vitest';

// run-scan-shadow.mjs importa src/lib/scanner.js, que por sua vez importa
// @/api/entities — em produção, scripts/build-scan-shadow.mjs redireciona
// isso pra scripts/adminEntitiesShadow.js via esbuild, mas um import direto
// do Vitest resolve pro módulo real (src/api/entities.js), que inicializa o
// Firebase Auth no carregamento e quebra sem as env vars VITE_FIREBASE_*.
// Mesmo mock de run-scan.test.mjs — só a função pura deste arquivo importa
// aqui embaixo, nenhuma toca `backend`.
vi.mock('@/api/entities', () => ({ backend: {} }));

import { hasPartialFailures } from './run-scan-shadow.mjs';

describe('hasPartialFailures (modo sombra)', () => {
  it('false quando as duas listas estão vazias (passada 100% limpa)', () => {
    expect(hasPartialFailures([], [])).toBe(false);
  });

  it('true quando algum ativo falhou em scanAllAssets', () => {
    expect(hasPartialFailures([{ symbol: 'BTCUSDT', error: 'boom' }], [])).toBe(true);
  });

  it('true quando alguma op falhou em priceCheckActiveOps', () => {
    expect(hasPartialFailures([], [{ error: 'boom' }])).toBe(true);
  });

  it('true quando as duas listas têm falha', () => {
    expect(hasPartialFailures([{ symbol: 'BTCUSDT' }], [{ error: 'boom' }])).toBe(true);
  });
});
