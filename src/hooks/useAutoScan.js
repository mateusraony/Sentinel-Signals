/**
 * Auto-scan hook
 * - Price check (lightweight) every 2 min when active trades exist
 * - Full scan every 60 min
 * Both acquire a transactional Firestore lock in scanner.js
 * (acquireScanLock/releaseScanLock) before running, so they never overlap
 * with each other or with the GitHub Actions cron scan.
 */

import { useEffect, useRef } from 'react';
import { scanAllAssets, priceCheckActiveOps } from '@/lib/scanner';
import { backend } from '@/api/entities';

const PRICE_CHECK_INTERVAL = 2 * 60 * 1000; // 2 min
const FULL_SCAN_INTERVAL = 60 * 60 * 1000;  // 60 min

export function useAutoScan({ queryClient, onActivity } = {}) {
  const lastFullScan = useRef(0);
  const timerRef = useRef(null);

  useEffect(() => {
    const tick = async () => {
      const now = Date.now();

      // Full scan every 60 min
      if (now - lastFullScan.current >= FULL_SCAN_INTERVAL) {
        lastFullScan.current = now;
        try {
          await scanAllAssets();
          if (queryClient) queryClient.invalidateQueries();
          if (onActivity) onActivity('full_scan');
        } catch (e) {
          console.warn('[AutoScan] full scan error:', e.message);
        }
        scheduleNext();
        return;
      }

      // Price check if active trades exist
      try {
        const ops = await backend.entities.TradeOperation.list('-created_date', 50);
        const hasActive = ops.some(op => ['SIGNAL_CONFIRMED', 'RUNNER_ACTIVE'].includes(op.status));
        if (hasActive) {
          await priceCheckActiveOps();
          if (queryClient) {
            queryClient.invalidateQueries({ queryKey: ['trade-operations'] });
            queryClient.invalidateQueries({ queryKey: ['trade-operations-dashboard'] });
          }
          if (onActivity) onActivity('price_check');
        }
      } catch (e) {
        console.warn('[AutoScan] price check error:', e.message);
      }

      scheduleNext();
    };

    const scheduleNext = () => {
      timerRef.current = setTimeout(tick, PRICE_CHECK_INTERVAL);
    };

    // First run after 90 seconds
    timerRef.current = setTimeout(tick, 90 * 1000);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []); // intentionally no deps — stable function refs
}