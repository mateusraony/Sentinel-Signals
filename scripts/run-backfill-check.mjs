// Checagem retroativa (backfill) — docs/known-risks.md item 137. Entry point
// bundled by scripts/build-backfill.mjs (see that file for the 4 redirects).
// Roda depois de `npm run scan` no mesmo job do scan.yml, como um processo
// Node SEPARADO (nunca no mesmo processo do scan ao vivo — installSimClock
// substitui o `Date` global inteiro, e mantê-lo isolado por processo evita
// qualquer risco de contaminar timestamps do scan real).
//
// Para cada MonitoredAsset com backfill_check_status:'pending' (escrito por
// AddAssetForm.jsx ao criar, ou por Assets.jsx ao reativar — is_active
// false→true): roda o motor REAL (scanAsset/persistScanResults, via
// backtestEngine.js:runBacktest) sobre uma janela histórica recente
// (src/lib/backfillDetection.js:BACKFILL_LOOKBACK_DAYS) contra o backend de
// PRODUÇÃO — qualquer TradeOperation que a cascata RF 4h→15m teria aberto se
// o Sentinel já estivesse monitorando o ativo nasce pelo MESMO caminho
// (createTradeOpIfNoneActive) que uma operação ao vivo. Depois, rotula as ops
// novas com source:'backfill' + o atraso real entrada→detecção (campos
// aditivos — nunca status/current_stop, nunca transitionTradeOp).
//
// Escopo v1 (decisão explícita do usuário, 2026-08-29): só a cascata RF
// nativa (4h→15m) — SMC mede ~0 operações reais em produção (known-risks item
// 125) e dobraria a superfície de mudança pra um ganho prático baixo. Por
// isso o asset é clonado com smc_enabled:false abaixo, independente do valor
// real salvo no Firestore.
import { runBacktest } from '../src/lib/backtestEngine.js';
import { backend } from '@/api/entities';
import { getPineConfig } from './adminPineConfig.js';
import { setBackfillWindow } from './backfillMarketDataProvider.js';
import { notifyTradeCreated } from './adminTelegram.js';
import { backfillLookbackWindow, buildBackfillTags, formatBackfillLag } from '../src/lib/backfillDetection.js';

// Limite por execução — checar um ativo novo é raro (o usuário adiciona
// símbolos ocasionalmente, não a cada scan). Custo dominante não é a
// Binance (~6-8 chamadas paginadas, 4h+15m+1h+1d, 60 dias, uma vez, com
// cache) — é o REPLAY em si: até ~5760 ticks de 15min contra o Firestore
// real (não o fake em memória que backtest.yml usa), cada um potencialmente
// lendo/escrevendo AssetState/TradeOperation/SignalEvent. 1 por execução
// mantém o tempo de job previsível dentro do timeout do scan.yml; o próximo
// ciclo (a cada ~5-30min em produção) pega o resto — nunca fica pendente
// por muito tempo.
const MAX_ASSETS_PER_RUN = 1;

async function checkOneAsset(asset, pineConfig) {
  const { fromMs, toMs } = backfillLookbackWindow();
  console.log(`[backfill] ${asset.symbol}: checando janela ${new Date(fromMs).toISOString()} → ${new Date(toMs).toISOString()}`);

  const opsBefore = await backend.entities.TradeOperation.filter({ asset_id: asset.id });

  setBackfillWindow(fromMs, toMs);
  // Clone, não mutação do doc real: smc_enabled:false só vale PARA ESTE
  // REPLAY (escopo v1, ver cabeçalho) — não altera a preferência salva do
  // usuário para o scan ao vivo normal.
  const replayAsset = { ...asset, smc_enabled: false };
  const report = await runBacktest({ assets: [replayAsset], backend, fromMs, toMs, pineConfig });

  const opsAfter = await backend.entities.TradeOperation.filter({ asset_id: asset.id });
  const tags = buildBackfillTags(opsBefore, opsAfter);

  for (const { id, patch } of tags) {
    await backend.entities.TradeOperation.update(id, patch);
    const op = opsAfter.find((o) => o.id === id);
    const lagLabel = formatBackfillLag(patch.backfill_entry_lag_ms);
    console.log(`[backfill] ${asset.symbol}: operação retroativa marcada (${id}), entrada real foi há ${lagLabel ?? 'desconhecido'}`);
    if (op) {
      await notifyTradeCreated({ ...op, ...patch }).catch((err) => {
        console.warn(`[backfill] ${asset.symbol}: falha ao notificar Telegram (não-fatal): ${err.message}`);
      });
    }
  }

  await backend.entities.MonitoredAsset.update(asset.id, {
    backfill_check_status: 'done',
    backfill_checked_at: new Date().toISOString(),
    backfill_ops_found: tags.length,
  });
  console.log(`[backfill] ${asset.symbol}: concluído — ${tags.length} operação(ões) retroativa(s), ${report.totalOps} avaliada(s) na janela`);
}

async function main() {
  const pending = await backend.entities.MonitoredAsset.filter({ backfill_check_status: 'pending' });
  if (pending.length === 0) {
    console.log('[backfill] nada pendente');
    return;
  }

  const batch = pending.slice(0, MAX_ASSETS_PER_RUN);
  console.log(`[backfill] ${pending.length} ativo(s) pendente(s), processando ${batch.length} nesta execução`);
  const pineConfig = await getPineConfig();

  for (const asset of batch) {
    try {
      await checkOneAsset(asset, pineConfig);
    } catch (err) {
      console.error(`[backfill] ${asset.symbol} FALHOU: ${err.message}`);
      await backend.entities.MonitoredAsset.update(asset.id, {
        backfill_check_status: 'error',
        backfill_check_error: String(err.message || err).slice(0, 500),
      }).catch(() => {});
    }
  }
}

main().catch((err) => {
  console.error('[backfill] FAILED:', err);
  process.exitCode = 1;
});
