/**
 * Auto-scan hook
 * - Price check (lightweight) every 2 min when active trades exist
 * - Full scan every 60 min
 * Both acquire a transactional Firestore lock in scanner.js
 * (acquireScanLock/releaseScanLock) before running, so they never overlap
 * with each other or with the GitHub Actions cron scan.
 */

import { useEffect, useRef } from 'react';
import { scanAllAssets, priceCheckActiveOps, hasActiveTradeOps } from '@/lib/scanner';

const PRICE_CHECK_INTERVAL = 2 * 60 * 1000; // 2 min
const FULL_SCAN_INTERVAL = 60 * 60 * 1000;  // 60 min

/** @param {{ queryClient?: import('@tanstack/react-query').QueryClient, onActivity?: (kind: string) => void }} [options] */
export function useAutoScan({ queryClient, onActivity } = {}) {
  const lastFullScan = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => {
    const tick = async () => {
      const now = Date.now();

      // Full scan every 60 min. Achado do sentinel-security-review (P1,
      // 2026-09-14): `lastFullScan.current` era setado ANTES da chamada —
      // uma falha (rede, lock, etc.) marcava a tentativa como se fosse
      // sucesso, e a próxima passagem completa só acontecia depois da janela
      // de 60min INTEIRA. Movido pra depois do `await` resolver com sucesso.
      //
      // Achado da auditoria externa (2026-09-15, nunca portado até agora):
      // isso só cobria a chamada INTEIRA lançando exceção. `scanAllAssets()`
      // (src/lib/scanner.js) captura erro POR ATIVO e devolve
      // `results: [{success:false, error}, ...]` sem nunca lançar — mesma
      // classe de bug que já tinha sido corrigida no cron (`run-scan.mjs`) e
      // no modo sombra (`run-scan-shadow.mjs`, PR #366), nunca replicada
      // aqui. Uma passada com TODOS os ativos falhando resolvia normalmente
      // e marcava `lastFullScan.current` como se a passada tivesse sido
      // completa — só tentava de novo depois da janela de 60min inteira.
      // Achado do Codex (review do PR #370, P1): o `return` que havia aqui
      // combinado com a correção acima (deixar `lastFullScan.current`
      // intocado numa falha) fazia um ativo com erro PERSISTENTE prender o
      // tick pra sempre neste bloco — toda passada de 2min voltava a cair
      // aqui (a janela de 60min nunca fechava) e retornava ANTES de chegar
      // no price-check abaixo. Um único ativo problemático suspendia a
      // checagem de stop/TP por preço de TODAS as operações ativas
      // indefinidamente (o cron do GitHub Actions continua cobrindo em
      // paralelo, mas o auto-scan do navegador ficava mudo enquanto a aba
      // ficasse aberta). Removido o `return`: o full scan (quando devido)
      // sempre cai no price-check logo abaixo, na mesma passada — os dois
      // deixam de ser mutuamente exclusivos por tick.
      //
      // Aba ESCONDIDA não faz full scan (item 257): na auditoria de 06/10/2026
      // todos os "Failed to fetch" recentes do navegador vieram com
      // `visibility: 'hidden'` (7 de 7 com dado, 0 offline) — o navegador
      // throttla/congela a aba em segundo plano e o scan sequencial falha em
      // rajada, marcando ativos como "erro" e segurando o lock de 10min. O cron
      // cobre o scan; ao voltar a ficar visível, `lastFullScan` não avançou e o
      // próximo tick (≤2min) roda o scan atrasado. O price-check abaixo
      // (stop/TP por preço) NÃO é pulado — é o caminho de segurança.
      const tabHidden = typeof document !== 'undefined' && document.visibilityState === 'hidden';
      if (!tabHidden && now - lastFullScan.current >= FULL_SCAN_INTERVAL) {
        try {
          const { results } = await scanAllAssets();
          const failed = (results || []).filter((r) => !r.success);
          if (failed.length > 0) {
            console.warn(`[AutoScan] full scan: ${failed.length}/${results.length} ativo(s) falharam — tentando de novo no próximo tick (2min), sem esperar a janela de 60min.`);
          } else {
            lastFullScan.current = now;
          }
          if (queryClient) queryClient.invalidateQueries();
          if (onActivity) onActivity('full_scan');
        } catch (e) {
          console.warn('[AutoScan] full scan error:', e.message);
        }
      }

      // Price check if active trades exist
      try {
        const hasActive = await hasActiveTradeOps();
        if (hasActive) {
          await priceCheckActiveOps();
          if (queryClient) {
            queryClient.invalidateQueries({ queryKey: ['trade-operations'] });
            queryClient.invalidateQueries({ queryKey: ['trade-operations-dashboard'] });
          }
          if (onActivity) onActivity('price_check');
        }
      } catch (e) {
        console.warn('[AutoScan] price check error:', e.message);
      }

      scheduleNext();
    };

    const scheduleNext = () => {
      timerRef.current = setTimeout(tick, PRICE_CHECK_INTERVAL);
    };

    // First run after 90 seconds
    timerRef.current = setTimeout(tick, 90 * 1000);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []); // intentionally no deps — stable function refs
}