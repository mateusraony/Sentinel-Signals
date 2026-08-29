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
import { isTerminalStatus } from '../src/lib/opTransition.js';
import { backend } from '@/api/entities';
import { getPineConfig } from './adminPineConfig.js';
import { setBackfillWindow, hasFetchFailure } from './backfillMarketDataProvider.js';
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

  // docs/known-risks.md item 137 (Codex review, PR #268) — se JÁ existe uma
  // operação NÃO-terminal para este ativo (ex.: o `npm run scan` que roda
  // ANTES deste script no mesmo job acabou de criar uma ao vivo, ou uma
  // rodada anterior de backfill já achou algo), o replay NUNCA deve rodar.
  // O motivo não é só "não tem nada pra completar" — é seguro: o replay
  // reavalia `persistScanResults` (invalidação/chop-exit, que não são
  // gateados pelo horário de entrada como stop/TP1/TP2 são via
  // isCandleUsableForExits/P0-c/P0-g) sobre candles de semanas atrás, ANTES
  // da operação real existir. Se a operação ao vivo fosse exposta a isso,
  // um candle histórico não relacionado poderia invalidar/fechar uma
  // posição real que acabou de nascer. Mais simples e mais seguro: pular o
  // replay inteiro sempre que já houver algo ativo.
  const hasActiveOp = opsBefore.some((op) => !isTerminalStatus(op.status));
  if (hasActiveOp) {
    console.log(`[backfill] ${asset.symbol}: já existe operação ativa — nada para backfillar, pulando replay`);
    await backend.entities.MonitoredAsset.update(asset.id, {
      backfill_check_status: 'done',
      backfill_checked_at: new Date().toISOString(),
      backfill_ops_found: 0,
    });
    return;
  }

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

  // docs/known-risks.md item 137 (Codex review, PR #268) — se alguma busca
  // de candle falhou mesmo após o retry (hasFetchFailure), o replay pode ter
  // rodado com dado incompleto e "0 encontrado" seria um falso negativo, não
  // uma checagem real. Marca 'error' em vez de 'done' para o próximo ciclo
  // do scan.yml tentar de novo, em vez de desistir silenciosamente.
  const degraded = hasFetchFailure();
  await backend.entities.MonitoredAsset.update(asset.id, {
    backfill_check_status: degraded ? 'error' : 'done',
    backfill_checked_at: new Date().toISOString(),
    backfill_ops_found: tags.length,
    ...(degraded ? { backfill_check_error: 'Falha ao buscar candles históricos (ver logs do job) — checagem incompleta, tentando de novo no próximo ciclo.' } : {}),
  });
  console.log(`[backfill] ${asset.symbol}: ${degraded ? 'INCOMPLETO (erro de busca de candle)' : 'concluído'} — ${tags.length} operação(ões) retroativa(s), ${report.totalOps} avaliada(s) na janela`);
}

async function main() {
  const pending = await backend.entities.MonitoredAsset.filter({ backfill_check_status: 'pending' });
  if (pending.length === 0) {
    console.log('[backfill] nada pendente');
    return;
  }

  // docs/known-risks.md item 137 (Codex review, PR #268) — desativar um
  // ativo NÃO limpa backfill_check_status:'pending' sozinho, e este query
  // não filtra por is_active. Sem isto, um ativo que o usuário desligou
  // antes do próximo ciclo do cron ainda seria checado e poderia criar/
  // notificar uma TradeOperation de produção para algo que ele parou de
  // monitorar de propósito. Resolvido direto para 'done' (reativar de novo
  // marca 'pending' fresco via Assets.jsx) — sem gastar o orçamento do
  // MAX_ASSETS_PER_RUN nele.
  const inactivePending = pending.filter((a) => !a.is_active);
  for (const asset of inactivePending) {
    console.log(`[backfill] ${asset.symbol}: desativado antes da checagem — marcado done sem rodar replay`);
    await backend.entities.MonitoredAsset.update(asset.id, { backfill_check_status: 'done' }).catch(() => {});
  }

  const activePending = pending.filter((a) => a.is_active);
  if (activePending.length === 0) {
    console.log(`[backfill] ${inactivePending.length} ativo(s) pendente(s), todos desativados — nada a processar`);
    return;
  }

  const batch = activePending.slice(0, MAX_ASSETS_PER_RUN);
  console.log(`[backfill] ${activePending.length} ativo(s) pendente(s) e ativo(s), processando ${batch.length} nesta execução`);
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
