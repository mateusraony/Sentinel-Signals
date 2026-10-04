import React from 'react';
import moment from 'moment';
import { useFundingRate } from '@/hooks/useFundingRate';
import { formatSignedPct } from '@/lib/priceProximity';

// Funding rate (Futures) — SÓ informativo, nenhuma decisão depende dele. Vive
// em arquivo próprio para o `AssetDrawer.jsx` seguir sem buscar dado nenhum
// (travado por teste); só é montado quando "Dados técnicos" está aberto.
// Usa o mesmo hook/queryKey do AssetCard (['funding-rate', símbolo]) — se o card
// do ativo já buscou, o cache é reaproveitado.
export default function FundingLine({ symbol }) {
  const { fundingRate, nextFundingTime } = useFundingRate(symbol);

  if (fundingRate === null) {
    return (
      <p className="text-9px font-mono text-muted-foreground leading-snug">
        Funding: indisponível agora (só existe no navegador, em Futures). Informativo — não influencia o sinal.
      </p>
    );
  }
  return (
    <p className="text-9px font-mono text-foreground/80 leading-snug">
      Funding: {formatSignedPct(fundingRate * 100, 4)}
      {nextFundingTime ? ` · próximo ${moment(nextFundingTime).utcOffset(-3).format('DD/MM HH:mm')} BRT` : ''}
      <span className="text-muted-foreground"> — Informativo, não influencia o sinal.</span>
    </p>
  );
}
