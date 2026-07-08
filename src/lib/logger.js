/**
 * Centralized System Logger
 *
 * Provides consistent logging across the app with automatic anomaly capture:
 * - Global JS errors (window.onerror)
 * - Unhandled promise rejections
 * - Periodic anomaly detection (stale scans, error states)
 *
 * All logs are stored in the SystemLog entity and visible via the Debug Log
 * floating button. Uses a queue + batch create to avoid blocking the UI.
 */

import { base44 } from '@/api/entities';

const QUEUE = [];
let flushing = false;
const DEDUP_SET = new Set();
const DEDUP_MAX = 50;

function dedupKey(level, module, message) {
  return `${level}:${module}:${message?.slice(0, 80)}`;
}

function addToQueue(level, module, message, details = null, extra = {}) {
  // Dedup identical messages within a short window
  const key = dedupKey(level, module, message);
  if (DEDUP_SET.has(key)) return;
  DEDUP_SET.add(key);
  if (DEDUP_SET.size > DEDUP_MAX) {
    // Clear oldest entries
    const arr = [...DEDUP_SET];
    DEDUP_SET.clear();
    arr.slice(-Math.floor(DEDUP_MAX / 2)).forEach(k => DEDUP_SET.add(k));
  }

  const entry = { level, module, message, ...extra };
  if (details) entry.details = details;
  QUEUE.push(entry);

  if (QUEUE.length >= 5) {
    flush();
  } else {
    setTimeout(flush, 3000);
  }
}

async function flush() {
  if (flushing || QUEUE.length === 0) return;
  flushing = true;
  const batch = QUEUE.splice(0, QUEUE.length);
  try {
    await base44.entities.SystemLog.bulkCreate(batch);
  } catch {
    // Logging should never break the app — silently retry later
    QUEUE.unshift(...batch.slice(0, 10)); // requeue up to 10
  } finally {
    flushing = false;
    if (QUEUE.length > 0) setTimeout(flush, 5000);
  }
}

// ─── Public API ───

export function logInfo(module, message, details, extra) {
  addToQueue('info', module, message, details, extra);
}

export function logWarn(module, message, details, extra) {
  addToQueue('warn', module, message, details, extra);
}

export function logError(module, message, details, extra) {
  addToQueue('error', module, message, details, extra);
}

export function logDebug(module, message, details, extra) {
  addToQueue('debug', module, message, details, extra);
}

// ─── Auto-capture initialization ───

let initialized = false;

export function initLogger() {
  if (initialized) return;
  initialized = true;

  // Capture global JS errors
  window.addEventListener('error', (event) => {
    addToQueue('error', 'global', `JS Error: ${event.message}`, {
      filename: event.filename?.split('/').pop(),
      lineno: event.lineno,
      colno: event.colno,
    });
  });

  // Capture unhandled promise rejections
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason?.message || String(event.reason)?.slice(0, 200);
    addToQueue('error', 'global', `Unhandled Promise: ${reason}`, {
      stack: event.reason?.stack?.slice(0, 500),
    });
  });

  // Periodic anomaly detection — every 5 minutes
  setInterval(async () => {
    try {
      const assets = await base44.entities.MonitoredAsset.filter({ is_active: true });
      const now = Date.now();
      let anomalies = 0;

      for (const asset of assets) {
        if (asset.scan_status === 'error') {
          addToQueue('warn', 'monitor',
            `${asset.symbol} em estado de erro`,
            { scan_error: asset.scan_error },
            { symbol: asset.symbol }
          );
          anomalies++;
        }
        if (asset.last_scan_at) {
          const ageMin = (now - new Date(asset.last_scan_at).getTime()) / 60000;
          if (ageMin > 120) {
            addToQueue('warn', 'monitor',
              `${asset.symbol} scan obsoleto (${Math.round(ageMin)}min atrás)`,
              null,
              { symbol: asset.symbol }
            );
            anomalies++;
          }
        }
      }

      // Check for active trade ops with stale data
      const activeOps = await base44.entities.TradeOperation.filter({});
      const TERMINAL = ['STOP_HIT', 'TP2_HIT', 'INVALIDATED', 'CLOSED'];
      const active = activeOps.filter(op => !TERMINAL.includes(op.status));
      for (const op of active) {
        if (op.data_status === 'STALE' || op.data_status === 'OFFLINE' || op.data_status === 'ERROR') {
          addToQueue('warn', 'monitor',
            `Trade ${op.symbol} ${op.side} com dados ${op.data_status}`,
            { status: op.status, entry: op.entry_price },
            { symbol: op.symbol }
          );
          anomalies++;
        }
      }

      if (anomalies === 0 && assets.length > 0) {
        addToQueue('info', 'monitor', `Health check OK — ${assets.length} ativos, ${active.length} operações ativas`);
      }
    } catch {
      // Silently fail — monitoring should never break the app
    }
  }, 5 * 60 * 1000);

  addToQueue('info', 'system', 'Logger iniciado — captura automática de anomalias ativa');
}