import React from 'react';
import { Target, ShieldCheck, Eye, History } from 'lucide-react';
import { MetricSummaryCard } from '@/components/MetricSummaryCard';
import { describeActiveSummary } from '@/lib/tradesOverview';
import { formatSignedR } from '@/lib/stopGuarantee';

/**
 * Resumo do topo da aba Trades (docs/known-risks.md item 304): o que está acontecendo AGORA, em quatro números.
 *
 * Antes o topo era uma linha de 10px ("3 em análise · 1 ativas · 20 histórico") e um contador "Atualizado há 1543s"; o que a
 * pessoa quer saber primeiro — quantas operações estão abertas e se estão protegidas — só aparecia rolando a página.
 *
 * Só apresentação: os números chegam prontos de `src/lib/tradesOverview.js` e `summarizeOps`.
 *
 * @param {{
 *   active: { total: number, protectedCount: number, zeroCount: number, riskCount: number, unknownCount: number, stopSumR: number|null },
 *   analysisCount: number,
 *   closed: { total: number, wins: number, be: number, losses: number },
 *   filtered?: boolean,
 * }} props
 */
export default function TradesNowSummary({ active, analysisCount, closed, filtered = false }) {
  const sumR = active.stopSumR;
  const sumColor = sumR === null ? 'rgba(255,255,255,0.55)' : sumR > 0 ? '#5db586' : sumR < 0 ? '#e06a5b' : '#e3b45a';
  const sumNote = active.total === 0
    ? 'sem operação aberta'
    : sumR === null
      ? 'falta o stop inicial de alguma operação'
      : 'soma dos resultados no stop, em R (bruto)';
  const suffix = filtered ? ' (com os filtros)' : '';

  return (
    <div className="grid grid-cols-2 lg:grid-cols-12 gap-3" role="group" aria-label="Resumo de agora">
      <MetricSummaryCard
        flat
        className="col-span-2 lg:col-span-4"
        icon={Target}
        label={`Operações ativas${suffix}`}
        value={String(active.total)}
        sublabel={describeActiveSummary(active) || 'nenhuma aberta agora'}
        color={active.total > 0 ? '#5db586' : 'rgba(255,255,255,0.55)'}
        glowColor="rgba(93,181,134,0.4)"
        valueClassName="text-2xl"
      />
      <MetricSummaryCard
        flat
        className="col-span-2 lg:col-span-3"
        icon={ShieldCheck}
        label="Se todas baterem no stop"
        value={formatSignedR(sumR) ?? '—'}
        sublabel={sumNote}
        color={sumColor}
        glowColor={sumR !== null && sumR < 0 ? 'rgba(224,106,91,0.4)' : 'rgba(93,181,134,0.4)'}
        valueClassName="text-2xl"
        tooltip="Soma, em R, do resultado de cada operação ativa se o preço voltasse e batesse no stop agora. R = quantas vezes o risco inicial da operação (a distância da entrada ao stop inicial). A soma supõe o mesmo risco em todas as operações (o painel não guarda o tamanho de cada posição), é bruta (sem taxas) e supõe saída exatamente no preço do stop."
      />
      <MetricSummaryCard
        flat
        className="lg:col-span-2"
        icon={Eye}
        label={`Avisos em análise${suffix}`}
        value={String(analysisCount)}
        sublabel={analysisCount > 0 ? 'viram operação sozinhos, se confirmarem' : 'nenhum agora'}
        color={analysisCount > 0 ? '#e3b45a' : 'rgba(255,255,255,0.55)'}
        glowColor="rgba(227,180,90,0.4)"
        valueClassName="text-2xl"
      />
      <MetricSummaryCard
        flat
        className="col-span-2 lg:col-span-3"
        icon={History}
        label={`Fechadas${suffix}`}
        value={String(closed.total)}
        sublabel={closed.total > 0 ? `${closed.wins} ganhos · ${closed.be} empates · ${closed.losses} perdas` : 'nenhuma no período'}
        color="rgba(255,255,255,0.85)"
        glowColor="rgba(255,255,255,0.55)"
        valueClassName="text-2xl"
      />
    </div>
  );
}
