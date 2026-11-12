/**
 * Auto-scan hook
 * - Price check (lightweight) every 2 min when active trades exist
 * - Full scan every 60 min
 * - Aba ESCONDIDA: não faz nada (item 301)
 * - Sem operação ativa: só confere se surgiu alguma a cada 30 min (item 301)
 * Both acquire a transactional Firestore lock in scanner.js
 * (acquireScanLock/releaseScanLock) before running, so they never overlap
 * with each other or with the GitHub Actions cron scan.
 */

import { useEffect, useRef } from 'react';
import { scanAllAssets, priceCheckActiveOps, hasActiveTradeOps } from '@/lib/scanner';
import { isTabHidden } from '@/lib/tabVisibility';
import { VISIBLE_REFRESH_MS } from '@/lib/pollingIntervals';

const PRICE_CHECK_INTERVAL = 2 * 60 * 1000; // 2 min
const FULL_SCAN_INTERVAL = 60 * 60 * 1000;  // 60 min
// Sem operação ativa, o tick de 2 min NÃO pergunta ao banco se surgiu uma (essa pergunta, a cada 2 min, mantinha o Neon grátis acordado o dia todo com a
// aba aberta — item 300): pergunta a cada 30 min, junto com a atualização das telas (`VISIBLE_REFRESH_MS`), e ao voltar para a aba. Com operação ativa
// nada muda: a cada 2 min confere stop/alvo. Uma operação que o cron abrir no meio fica sem o acompanhamento de 2 min do navegador por até 30 min (o cron
// do GitHub, a cada ~15 min, cobre — como com a aba fechada).
const ACTIVE_RECHECK_INTERVAL = VISIBLE_REFRESH_MS;

/** @param {{ queryClient?: import('@tanstack/react-query').QueryClient, onActivity?: (kind: string) => void }} [options] */
export function useAutoScan({ queryClient, onActivity } = {}) {
  const lastFullScan = useRef(0);
  const timerRef = useRef(null);
  // `has`: a última pergunta ao banco achou operação ativa; `checkedAt`: quando foi a última pergunta (0 = nunca, pergunta no 1º tick).
  const activeRef = useRef({ has: false, checkedAt: 0 });

  useEffect(() => {
    const tick = async () => {
      // Aba ESCONDIDA (docs/known-risks.md item 301): o tick não toca o banco (o Neon grátis só dorme depois de 5 min parado e uma aba em segundo plano o
      // mantinha acordado). O ciclo de agendamento continua vivo: ao voltar, o próximo tick (≤ 2 min) roda normalmente, inclusive o full scan atrasado
      // (`lastFullScan` não avançou). Enquanto isso o cron do GitHub cobre stop/TP a cada ~15 min. Mudança consciente do item 257, que mantinha o
      // price-check com a aba escondida: o navegador já congela timers de aba em segundo plano, então a cobertura real era frágil de qualquer jeito.
      if (isTabHidden()) {
        scheduleNext();
        return;
      }
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
      // próximo tick (≤2min) roda o scan atrasado. Desde o item 301 a aba
      // escondida sai do tick lá em cima (nem o price-check roda).
      if (now - lastFullScan.current >= FULL_SCAN_INTERVAL) {
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

      // Price check if active trades exist. Com operação ativa pergunta ao banco a cada tick (como sempre); sem nenhuma, só a cada 30 min (ver
      // ACTIVE_RECHECK_INTERVAL) ou depois de a aba voltar a ficar visível.
      try {
        const due = activeRef.current.has || now - activeRef.current.checkedAt >= ACTIVE_RECHECK_INTERVAL;
        const hasActive = due ? await hasActiveTradeOps() : false;
        if (due) activeRef.current = { has: hasActive, checkedAt: now };
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

    // Ao esconder ou voltar para a aba, a próxima passagem pergunta de novo se há operação ativa (pode ter surgido uma enquanto a aba estava escondida;
    // com a aba escondida o tick nem roda, então marcar nas duas direções dá no mesmo).
    const onVisibilityChange = () => {
      activeRef.current = { ...activeRef.current, checkedAt: 0 };
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, []); // intentionally no deps — stable function refs
}