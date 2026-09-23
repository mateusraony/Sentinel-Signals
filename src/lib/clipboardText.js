import { useState } from 'react';

// Mesmo padrão ad-hoc de Logs.jsx (handleCopy: navigator.clipboard.writeText
// puro, sem lib nova, feedback copied/Check/2s), extraído porque agora tem
// 3+ usos (TradeHistory.jsx, LiveConfidenceCard.jsx, MonthlyReport.jsx) —
// "reuse antes de criar". Só o comportamento de clipboard/feedback é
// compartilhado; o TEXTO copiado continua formatado por cada tela, que sabe
// o que faz sentido mostrar.
export function useCopyToClipboard(timeoutMs = 2000) {
  const [copied, setCopied] = useState(false);
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), timeoutMs);
    } catch {
      // Clipboard API pode falhar (permissão negada, contexto não-seguro) —
      // sem fallback silencioso, o botão só reage se realmente copiou
      // (mesma decisão de Logs.jsx).
    }
  };
  return { copied, copy };
}

// Uma linha por operação — formato comum reaproveitado por TradeHistory.jsx
// e MonthlyReport.jsx (as duas telas que listam operações fechadas linha a
// linha). LiveConfidenceCard.jsx não usa isto — ali não há lista de
// operações individuais, só agregados por cohort.
export function formatTradeOpLine(op, { getExitPrice, calcRealizedPnlPct, classifyOutcome, formatPrice, moment }) {
  const pnl = calcRealizedPnlPct(op);
  const exitPrice = getExitPrice(op);
  const outcome = classifyOutcome(op);
  const date = moment(op.created_date).format('YYYY-MM-DD HH:mm');
  const pnlStr = pnl !== null && pnl !== undefined ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%` : '—';
  return `[${date}] ${op.symbol} ${op.side} ${op.status}(${outcome}) entrada=$${formatPrice(op.entry_price)} saida=${exitPrice ? `$${formatPrice(exitPrice)}` : '—'} pnl=${pnlStr}`;
}
