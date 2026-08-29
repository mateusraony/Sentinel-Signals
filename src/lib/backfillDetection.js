// Checagem retroativa (backfill) ao adicionar/reativar um ativo — pedido
// explícito do usuário (docs/known-risks.md item 137): "já tem alguma
// operação em aberto quando eu coloco um token?" — o motivo real é a
// divergência Spot(painel)×Futures(TradingView) do usuário fazer um sinal já
// ter cruzado no TV antes do Sentinel sequer conhecer o ativo.
//
// A ORQUESTRAÇÃO (buscar candles históricos, rodar backtestEngine.js:
// runBacktest contra o backend REAL de produção, marcar o MonitoredAsset como
// concluído) vive em scripts/run-backfill-check.mjs — Node-only, roda no
// mesmo runner do scan.yml. Este módulo só tem a lógica PURA (sem I/O), para
// poder ser testada sem Firestore/Binance, seguindo a mesma separação que o
// resto do motor já usa (opTransition.js, opExitRules.js).
//
// IMPORTANTE: rodar a cascata REAL via runBacktest contra o backend real
// significa que uma operação retroativa é criada pelo MESMO caminho
// (createTradeOpIfNoneActive dentro de persistScanResults) que uma operação
// ao vivo — não é um terceiro caminho de mutação (.claude/rules/
// trading-engine.md). Este módulo só rotula o resultado depois de criado
// (campos aditivos, nunca status/current_stop — CAS/clampMonotonicStop
// continuam os únicos donos desses campos).
import { getEntryReferenceTime } from './opExitRules.js';

// Janela de replay: precisa cobrir o Time Stop MÁXIMO em produção (T3 = 96
// barras de 4h = 384h = 16 dias, src/lib/indicators/tier.js) mais aquecimento
// de indicador suficiente (RF/ADX/Choppiness convergem com precisão só após
// ~6x o período — .claude/rules/pine-parity.md; RF period 20 em 4h => 120
// barras de 4h => 20 dias). 60 dias dá ~40 dias de aquecimento antes da
// janela onde uma operação "ainda aberta hoje" precisaria ter entrado —
// margem generosa sem inflar o custo de rede (60d de 15m = 5760 candles = 6
// chamadas paginadas à API pública da Binance, ver
// scripts/backfillMarketDataProvider.js).
export const BACKFILL_LOOKBACK_DAYS = 60;

export function backfillLookbackWindow(nowMs = Date.now()) {
  const toMs = nowMs;
  const fromMs = toMs - BACKFILL_LOOKBACK_DAYS * 24 * 60 * 60 * 1000;
  return { fromMs, toMs };
}

// Compara o snapshot de TradeOperation do ativo ANTES do replay contra a
// lista DEPOIS — qualquer id novo só pode ter vindo do replay (o scan ao
// vivo não roda durante a checagem: scripts/run-backfill-check.mjs é um
// processo Node separado do scan.yml, nunca concorrente com ele). Devolve o
// patch pronto para backend.entities.TradeOperation.update(id, patch) —
// deliberadamente NUNCA transitionTradeOp: isto rotula metadado aditivo
// (source/backfill_*), nunca status/current_stop, então não precisa (e não
// deve) passar pelo CAS transacional daquele caminho.
export function buildBackfillTags(opsBefore, opsAfter, { nowMs = Date.now() } = {}) {
  const beforeIds = new Set(opsBefore.map((op) => op.id));
  const detectedAtIso = new Date(nowMs).toISOString();
  return opsAfter
    .filter((op) => !beforeIds.has(op.id))
    .map((op) => {
      // Mesma prioridade de referência de entrada que o motor real usa para
      // o guard temporal P0-c/P0-g (opExitRules.js) — reaproveitada aqui de
      // propósito, não rederivada (.claude/rules/trading-engine.md, "padrões
      // de bug já redescobertos": nunca duplicar uma regra de prioridade de
      // campo em dois lugares).
      const entryIso = getEntryReferenceTime(op);
      const entryMs = entryIso ? new Date(entryIso).getTime() : null;
      const lagMs = entryMs != null && Number.isFinite(entryMs) ? Math.max(0, nowMs - entryMs) : null;
      return {
        id: op.id,
        patch: {
          source: 'backfill',
          backfill_detected_at: detectedAtIso,
          backfill_entry_lag_ms: lagMs,
        },
      };
    });
}

// Formata um intervalo em ms como "3d 14h" (ou "14h", ou "35min" abaixo de
// 1h) — usado pela UI (TradeCard/TradeHistory) e pela notificação Telegram
// para deixar explícito, na cara, que a entrada real aconteceu no passado —
// pedido literal do usuário: "deixar explícito que foi adicionado depois e
// não o sistema".
export function formatBackfillLag(ms) {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return null;
  const totalMinutes = Math.floor(ms / 60000);
  if (totalMinutes < 60) return `${totalMinutes}min`;
  const totalHours = Math.floor(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days === 0) return `${hours}h`;
  return `${days}d ${hours}h`;
}
