import React from 'react';
import { Moon } from 'lucide-react';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { useIdleRest } from '@/hooks/useIdleRest';
import { wakeFromRest, IDLE_REST_MS } from '@/lib/idleRest';

/**
 * Faixa "Painel em repouso" (docs/known-risks.md item 301). Também é quem LIGA o repouso (`useIdleRest`): fica montada no `AppLayout` o tempo todo.
 *
 * Depois de 20 min sem atividade o painel para de consultar o banco (o Neon grátis só dorme depois de 5 min parado, e uma aba esquecida o mantinha acordado
 * o dia inteiro). A faixa existe para ninguém achar que uma tela parada num segundo monitor continua ao vivo: diz o que pausou, o que continua cobrindo e
 * como voltar. Some na primeira atividade (mouse, tecla, toque) ou no botão.
 *
 * É uma sobreposição FIXA no topo (não entra no fluxo da página): aparece mesmo com a tela rolada e NÃO empurra o conteúdo. Isso é obrigatório: uma faixa
 * que ocupa espaço acima do conteúdo rolado faz o navegador reajustar a rolagem (scroll anchoring), o que dispara `scroll` = "atividade" e acordaria o
 * painel sozinho no mesmo instante em que ele dormiu (medido no Chromium: a faixa piscava e sumia; com a sobreposição fixa, nenhum evento).
 */
export default function IdleRestBanner() {
  const resting = useIdleRest();
  if (!resting) return null;

  const minutos = Math.round(IDLE_REST_MS / 60_000);

  return (
    <div data-idle-rest-overlay className="pointer-events-none fixed inset-x-2 top-2 z-30 md:left-16 md:right-4">
      <Alert role="status" aria-live="polite" className="pointer-events-auto mx-auto max-w-4xl border-primary/30 bg-card shadow-lg">
        <Moon className="h-4 w-4" aria-hidden="true" />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold">Painel em repouso</p>
            <p className="text-muted-foreground">
              Sem atividade há {minutos} min, as atualizações da tela e o acompanhamento de stop e alvo pelo navegador pausaram para poupar o banco de dados.
              O scan do GitHub segue a cada ~15 min. Mexa o mouse ou aperte uma tecla para retomar.
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={wakeFromRest}>
            Retomar agora
          </Button>
        </div>
      </Alert>
    </div>
  );
}
