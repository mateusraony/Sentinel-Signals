import { useEffect, useSyncExternalStore } from 'react';
import { focusManager } from '@tanstack/react-query';
import { isResting, startIdleRest, stopIdleRest, subscribeResting } from '@/lib/idleRest';

/**
 * Liga o repouso do painel por inatividade (docs/known-risks.md item 301) e devolve se ele está em repouso agora.
 *
 * Monte UMA vez, no layout do painel (`IdleRestBanner`). O que ele faz:
 *  - inicia/para a detecção de atividade (`src/lib/idleRest.js`);
 *  - em repouso diz ao React Query que a aba está "sem foco" (`focusManager.setFocused(false)`): é assim que o `refetchInterval` de TODAS as telas pausa sem
 *    mexer em cada uma (o React Query só dispara o intervalo com a aba focada, e `refetchIntervalInBackground` não é usado em lugar nenhum — travado por teste);
 *  - ao acordar devolve o foco ao padrão do navegador (`setFocused(undefined)`): o `refetchOnWindowFocus` do `query-client.js` refaz na hora as consultas
 *    velhas, então a tela volta atualizada em vez de esperar o próximo intervalo.
 * O `useAutoScan` e o monitor do logger leem `isResting()` direto, sem passar por aqui.
 */
export function useIdleRest() {
  useEffect(() => {
    const aplicar = (resting) => focusManager.setFocused(resting ? false : undefined);
    const cancelar = subscribeResting(aplicar);
    startIdleRest();
    return () => {
      cancelar();
      stopIdleRest();
      focusManager.setFocused(undefined);
    };
  }, []);

  return useSyncExternalStore(subscribeResting, isResting, () => false);
}
