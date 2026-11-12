import { useEffect, useSyncExternalStore } from 'react';
import { focusManager, useQueryClient } from '@tanstack/react-query';
import {
  REST_REFRESH_MS, getRestState, startIdleRest, stopIdleRest, subscribeResting, subscribeRestState,
} from '@/lib/idleRest';

const ESTADO_SERVIDOR = Object.freeze({ resting: false, liveUntil: null });

/**
 * Liga o repouso do painel por inatividade (docs/known-risks.md item 301) e devolve `{ resting, liveUntil }` (repouso agora? / "ao vivo" até quando?).
 *
 * Monte UMA vez, no layout do painel (`LiveStatusBar`). O que ele faz:
 *  - inicia/para a detecção de atividade (`src/lib/idleRest.js`);
 *  - em repouso diz ao React Query que a aba está "sem foco" (`focusManager.setFocused(false)`): é assim que o `refetchInterval` de TODAS as telas pausa sem
 *    mexer em cada uma (o React Query só dispara o intervalo com a aba focada, e `refetchIntervalInBackground` não é usado em lugar nenhum — travado por teste);
 *  - em repouso a tela NÃO congela: a cada REST_REFRESH_MS (30 min) refaz as consultas das telas abertas (o dado só muda a cada ~15 min, o scan). Aba
 *    escondida não atualiza (ninguém olha; ao voltar, o foco refaz na hora);
 *  - ao acordar devolve o foco ao padrão do navegador (`setFocused(undefined)`): o `refetchOnWindowFocus` do `query-client.js` refaz na hora as consultas
 *    velhas, então a tela volta atualizada em vez de esperar o próximo intervalo.
 * O `useAutoScan` e o monitor do logger leem `isResting()` direto, sem passar por aqui.
 */
export function useIdleRest() {
  const queryClient = useQueryClient();

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

  const estado = useSyncExternalStore(subscribeRestState, getRestState, () => ESTADO_SERVIDOR);

  useEffect(() => {
    if (!estado.resting) return undefined;
    const id = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      void queryClient.refetchQueries({ type: 'active' }); // refetchQueries não depende do foco; erros ficam no estado de cada consulta
    }, REST_REFRESH_MS);
    return () => clearInterval(id);
  }, [estado.resting, queryClient]);

  return estado;
}
