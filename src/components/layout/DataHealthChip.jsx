import React from 'react';
import { summarizeDataHealth, healthChip } from '@/lib/assetDataQuality';
import { useNow } from '@/hooks/useNow';

/**
 * Chip de saúde global (item 277): "📡 Último scan há N min · K ativos com
 * problema", no lugar do "Dados em tempo real" fixo do Dashboard e do ponto
 * verde pulsando sempre na Sidebar. Carregando/erro nunca dizem "tudo em dia".
 *
 * `variant="dot"` (Sidebar estreita): só o ponto colorido, com o texto como
 * nome acessível. `role="img"`, não `status`: o texto muda a cada minuto e uma
 * região viva faria o leitor de tela anunciar o tempo todo.
 */
export default function DataHealthChip({ assets = [], isLoading = false, isError = false, variant = 'full' }) {
  // O texto depende do relógio: sem o tick, "há 1 min" ficaria parado.
  const now = useNow();

  const { label, color } = healthChip(summarizeDataHealth(assets, now), { loading: isLoading, error: isError });
  const dot = <span className="block rounded-full shrink-0" style={{ width: 6, height: 6, background: color }} />;

  if (variant === 'dot') {
    return <span role="img" aria-label={label} className="flex items-center justify-center">{dot}</span>;
  }
  return (
    <span className="flex items-center gap-2">
      {dot}
      <span>{label}</span>
    </span>
  );
}
