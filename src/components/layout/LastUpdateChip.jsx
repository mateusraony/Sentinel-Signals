import React from 'react';
import { useLastDbRead } from '@/hooks/useLastDbRead';
import { useNow } from '@/hooks/useNow';
import { formatLastUpdate } from '@/lib/lastUpdateFormat';
import { VISIBLE_REFRESH_MS } from '@/lib/pollingIntervals';

/**
 * Chip "Atualizado às HH:MM:SS" (docs/known-risks.md item 301): o horário da última vez que a tela leu o banco com sucesso (`dbReadClock`, não a cotação
 * da Binance, que muda a cada 30 s). Fica fixo no canto inferior esquerdo, discreto, sem texto de modo: com a aba visível a tela atualiza a cada 30 min; com
 * a aba escondida ou fechada não consulta nada, e o horário fica parado no último — o chip é justamente isso.
 *
 * Posição: acima da barra de navegação do celular (`bottom-[4.5rem]`) e ao lado da barra lateral no computador (`md:left-16`), longe do botão de Debug
 * (canto inferior direito). Altura e largura não dependem do estado (só o texto muda, sem quebra de linha), então nada empurra a página.
 * Não é região viva (`role="status"` anunciaria o horário a cada atualização).
 */
export default function LastUpdateChip() {
  const ultima = useLastDbRead();
  const agora = useNow(30_000); // só para "hoje" × outro dia no texto
  const minutos = Math.round(VISIBLE_REFRESH_MS / 60_000);

  return (
    <div
      data-last-update-chip
      title={`Última vez que a tela leu o banco. Com a aba aberta atualiza a cada ${minutos} min; com a aba em segundo plano ou fechada não atualiza.`}
      className="fixed bottom-[4.5rem] left-3 z-30 whitespace-nowrap rounded-md px-2 py-1 text-10px font-mono text-muted-foreground md:bottom-3 md:left-16"
      style={{ background: 'rgba(8,10,18,0.7)', backdropFilter: 'blur(12px)', border: '1px solid rgba(255,255,255,0.06)' }}
    >
      {formatLastUpdate(ultima, agora)}
    </div>
  );
}
