import React from 'react';
import { Moon, Radio } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useIdleRest } from '@/hooks/useIdleRest';
import { useLastDataUpdate } from '@/hooks/useLastDataUpdate';
import { useNow } from '@/hooks/useNow';
import { keepLive, REST_REFRESH_MS, LIVE_MS } from '@/lib/idleRest';
import { describeMode, formatLastUpdate } from '@/lib/liveStatusFormat';

/**
 * Barra "Atualizado às HH:MM:SS · ao vivo" (docs/known-risks.md item 301). SEMPRE visível, logo abaixo do TopBar: diz quando a tela atualizou pela última
 * vez e em que modo o painel está.
 *  - ao vivo (normal): atualiza a cada ~60 s;
 *  - em repouso (20 min sem mexer): NÃO congela, atualiza a cada 30 min e o banco dorme entre uma atualização e outra;
 *  - "Manter ao vivo": durante 60 min o painel não entra em repouso mesmo sem ninguém mexendo; depois volta à regra normal.
 *
 * Também é quem LIGA o repouso (`useIdleRest`): fica montada no `AppLayout` o tempo todo.
 *
 * ALTURA FIXA (h-8, sem quebra de linha): trocar de modo só troca o texto. Uma faixa que aparece/some acima do conteúdo rolado faz o navegador reajustar a
 * rolagem (scroll anchoring) — foi o que acordava o painel sozinho na 1ª versão. Não é região viva (`role="status"` anunciaria o horário a cada atualização).
 */
export default function LiveStatusBar() {
  const estado = useIdleRest();
  const ultima = useLastDataUpdate();
  const agora = useNow(30_000); // só para "hoje" × outro dia no texto
  const modo = describeMode(estado, Math.round(REST_REFRESH_MS / 60_000));
  const emRepouso = modo.kind === 'rest';
  const Icone = emRepouso ? Moon : Radio;

  return (
    <div
      data-live-status
      data-mode={modo.kind}
      className="sticky top-14 z-20 flex h-8 items-center justify-between gap-3 overflow-hidden whitespace-nowrap px-4 text-10px font-mono sm:text-11px lg:px-6"
      style={{ background: 'rgba(8,10,18,0.7)', backdropFilter: 'blur(20px)', borderBottom: '1px solid rgba(255,255,255,0.05)' }}
    >
      <span className="flex min-w-0 items-center gap-2 text-muted-foreground">
        <Icone className={`h-3 w-3 shrink-0 ${emRepouso ? 'text-amber-400' : modo.kind === 'live' ? 'text-cyan-400' : 'text-emerald-400'}`} aria-hidden="true" />
        <span className="truncate">
          <span data-last-update className="text-foreground">{formatLastUpdate(ultima, agora)}</span>
          <span> · </span>
          <span className="hidden sm:inline">{modo.full}</span>
          <span className="sm:hidden">{modo.short}</span>
        </span>
      </span>
      {modo.kind !== 'live' && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-6 shrink-0 px-2 text-11px font-mono"
          aria-label="Manter ao vivo"
          title={`Mantém a tela atualizando a cada ~60 s por ${LIVE_MS / 60_000} min, mesmo sem você mexer`}
          onClick={() => keepLive()}
        >
          <span className="sm:hidden" aria-hidden="true">Ao vivo</span>
          <span className="hidden sm:inline" aria-hidden="true">Manter ao vivo</span>
        </Button>
      )}
    </div>
  );
}
