import { useEffect, useRef } from 'react';
import { logWarn } from '@/lib/logger';

/**
 * Solicita permissão de notificação do navegador e dispara alertas
 * quando novos sinais de compra/venda são detectados.
 */
export function useBrowserNotifications(signals = []) {
  const seenIds = useRef(new Set());
  const permissionRequested = useRef(false);

  // Solicita permissão na primeira chamada
  useEffect(() => {
    if (!permissionRequested.current && 'Notification' in window && Notification.permission === 'default') {
      permissionRequested.current = true;
      Notification.requestPermission();
    }
  }, []);

  useEffect(() => {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    if (!signals.length) return;

    // Janela de novidade: sinais dos últimos 5 minutos
    const cutoff = Date.now() - 5 * 60 * 1000;

    signals.forEach(sig => {
      if (seenIds.current.has(sig.id)) return;
      seenIds.current.add(sig.id);

      const createdAt = new Date(sig.created_date).getTime();
      if (createdAt < cutoff) return; // Sinal antigo, não notificar

      if (sig.source !== 'range_filter') return;

      const isBuy = sig.signal_type === 'BUY';
      const symbol = sig.symbol?.replace('USDT', '/USDT') || sig.symbol;
      const score = sig.context?.score || 0;

      try {
        const n = new Notification(
          `${isBuy ? '🟢 COMPRA' : '🔴 VENDA'} — ${symbol}`,
          {
            body: `${sig.timeframe?.toUpperCase()} · Score ${score}/100\n${sig.reason || ''}`,
            icon: '/favicon.ico',
            tag: sig.id, // Evita duplicatas no OS
            silent: false,
          }
        );
        // Auto-fecha após 6s
        setTimeout(() => n.close(), 6000);
      } catch (e) {
        logWarn('notifications', 'Falha ao exibir notificação do navegador', { error: e.message, symbol });
      }
    });
  }, [signals]);
}