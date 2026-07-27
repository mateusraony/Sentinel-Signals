// CLI entry point for the historical backtest (see
// docs/claude/backtest-usage.md for the full local-only flow). Bundled with
// esbuild (scripts/build-backtest.mjs) before running — see that file for
// why a plain `node scripts/run-backtest.mjs` won't work directly (same
// reason as scripts/run-scan.mjs).
//
// Usage:
//   node scripts/dist/run-backtest.mjs \
//     --symbols BTCUSDT,ETHUSDT \
//     --from 2026-01-01T00:00:00Z --to 2026-06-01T00:00:00Z \
//     [--data-dir scripts/__fixtures__/backtest] \
//     [--smc BTCUSDT] [--smc-confirm BTCUSDT] \
//     [--pine-config ./my-pine-overrides.json] \
//     [--step-ms 900000] [--out ./backtest-report.json] \
//     [--no-costs] [--fee-bps 5] [--slippage-bps 1] [--funding-bps 1] \
//     [--min-trades 30] [--trial-label "ob-weight-7"]
//
// Custos (Fase 5, docs/known-risks.md item 44): taxa, slippage e funding
// são descontados POR PADRÃO. --no-costs roda a custo zero e serve para o
// A/B "quanto o custo comeu" — é também o modo que reproduz exatamente os
// números de antes da Fase 5. --trial-label só é gravado no JSON: serve
// para você contar quantas configurações já testou, que é o número que
// torna qualquer conclusão futura interpretável (overfitting).
//
// --smc and --smc-confirm are INDEPENDENT (mirrors asset.smc_enabled vs.
// asset.smc_confirm_4h15m in scanner.js — see MonitoredAsset.jsonc): --smc
// turns on the parallel 1h→5m SMC cascade (its own trades show up under
// report.byCascade['1h_5m'], next to the 4h/15m one, so a single run already
// compares plain RF vs. SMC side by side); --smc-confirm makes the EXISTING
// 4h/15m RF cascade stricter (requires 4h SMC structure/zone agreement) —
// it does not require --smc, and --smc does not imply it.
import fs from 'node:fs';
import { runBacktest } from '../src/lib/backtestEngine.js';
import { ZERO_COST } from '../src/lib/tradeMetrics.js';
import { backend } from '@/api/entities';
import { setPineConfigOverrides } from './backtestPineConfig.js';

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) continue;
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { args[key] = true; continue; }
    args[key] = next;
    i++;
  }
  return args;
}

function makeAsset(symbol, { smcSymbols, smcConfirmSymbols, rfPeriod, rfMultiplier }) {
  return {
    id: symbol,
    symbol,
    display_name: symbol,
    is_active: true,
    timeframes_enabled: { '1h': true, '4h': true, '1d': true },
    rf_period: rfPeriod,
    rf_multiplier: rfMultiplier,
    // Off by default here (unlike AddAssetForm.jsx's live default for NEW
    // real assets) — a backtest asset list is explicit CLI input, not a
    // panel action, so each stays opt-in via its own flag rather than
    // silently inheriting the live-panel default or each other.
    smc_enabled: smcSymbols.has(symbol),
    smc_confirm_4h15m: smcConfirmSymbols.has(symbol),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.symbols || !args.from || !args.to) {
    console.error('Uso: run-backtest.mjs --symbols SYM1,SYM2 --from ISO --to ISO [--data-dir DIR] [--smc SYM1,SYM2] [--smc-confirm SYM1,SYM2] [--pine-config FILE] [--step-ms N] [--out FILE] [--no-costs] [--fee-bps N] [--slippage-bps N] [--funding-bps N] [--min-trades N] [--trial-label TXT]');
    process.exitCode = 1;
    return;
  }

  if (args['data-dir']) process.env.BACKTEST_DATA_DIR = args['data-dir'];

  if (args['pine-config']) {
    const overrides = JSON.parse(fs.readFileSync(args['pine-config'], 'utf-8'));
    setPineConfigOverrides(overrides);
  }

  const symbols = String(args.symbols).split(',').map((s) => s.trim()).filter(Boolean);
  const smcSymbols = new Set(String(args.smc || '').split(',').map((s) => s.trim()).filter(Boolean));
  const smcConfirmSymbols = new Set(String(args['smc-confirm'] || '').split(',').map((s) => s.trim()).filter(Boolean));
  const rfPeriod = args['rf-period'] ? Number(args['rf-period']) : 20;
  const rfMultiplier = args['rf-multiplier'] ? Number(args['rf-multiplier']) : 3.5;
  const assets = symbols.map((symbol) => makeAsset(symbol, { smcSymbols, smcConfirmSymbols, rfPeriod, rfMultiplier }));

  const fromMs = new Date(args.from).getTime();
  const toMs = new Date(args.to).getTime();
  const stepMs = args['step-ms'] ? Number(args['step-ms']) : undefined;

  // Modelo de custo. Sem flag nenhuma => DEFAULT_COST_MODEL (taxa real).
  // --no-costs => ZERO_COST, que reproduz os números pré-Fase-5.
  const costModel = args['no-costs']
    ? ZERO_COST
    : {
        ...(args['fee-bps'] !== undefined
          ? { feeBpsEntry: Number(args['fee-bps']), feeBpsExit: Number(args['fee-bps']) }
          : {}),
        ...(args['slippage-bps'] !== undefined ? { slippageBpsPerSide: Number(args['slippage-bps']) } : {}),
        ...(args['funding-bps'] !== undefined ? { fundingBpsPer8h: Number(args['funding-bps']) } : {}),
      };
  const minTrades = args['min-trades'] ? Number(args['min-trades']) : undefined;

  console.log(`[backtest] ${symbols.join(', ')} de ${new Date(fromMs).toISOString()} a ${new Date(toMs).toISOString()}`);

  // performance.now(), NÃO Date.now(): runBacktest instala um relógio simulado
  // (installSimClock troca o `Date` global) antes de chamar onStep, então
  // `Date.now()` DENTRO do callback devolve o cursor do replay, não a hora de
  // parede — e numa janela histórica a subtração dá NEGATIVO. Achado por
  // revisão externa (Codex, PR #93) depois de eu cair exatamente nisso.
  // `performance.now()` é monotônico e independente do `Date` global.
  // Regressão em backtestEngine.test.js ("onStep roda com o relógio simulado
  // ativo"), que documenta a armadilha para o próximo callback.
  const started = performance.now();
  let lastLoggedPct = -1;
  const report = await runBacktest({
    assets, backend, fromMs, toMs, stepMs, costModel, minTrades,
    onStep(t, err) {
      if (err) {
        console.warn(`[backtest] ${err.asset} falhou em ${new Date(t).toISOString()}: ${err.error}`);
        return;
      }
      const pct = Math.floor(((t - fromMs) / (toMs - fromMs)) * 100);
      if (pct >= lastLoggedPct + 10) {
        lastLoggedPct = pct;
        // Decorrido + projeção, não só a porcentagem. O run de 4 anos rodou
        // 5h25min e só se revelou impossível quando o job foi cortado no
        // timeout — o log mostrava percentuais avançando e nada dizia se ia
        // terminar. Com isto, o marco de 10% já permite decidir entre deixar
        // rodar e cancelar.
        //
        // A projeção é LINEAR e por isso OTIMISTA: o replay tem termo
        // superlinear conhecido (fakeBackend.filter fica mais caro conforme o
        // store de SignalEvent cresce — docs/roadmap.md, Bloco 0), então o
        // total real tende a passar do projetado. O rótulo "mínimo" existe
        // para a projeção não ser lida como promessa.
        const decorridoMin = (performance.now() - started) / 60000;
        const projecao = pct > 0 ? (decorridoMin / pct) * 100 : null;
        const sufixo = projecao === null
          ? ''
          : ` — ${decorridoMin.toFixed(1)}min decorridos, projeção ≥${projecao.toFixed(0)}min`;
        console.log(`[backtest] ${pct}% (${new Date(t).toISOString()})${sufixo}`);
      }
    },
  });

  console.log(`[backtest] concluído em ${((performance.now() - started) / 1000).toFixed(1)}s`);
  console.log(`[backtest] total de operações: ${report.totalOps} (ainda abertas no corte: ${report.stillOpenAtCutoff})`);
  console.log('[backtest] geral:', report.overall);
  for (const [cascade, summary] of Object.entries(report.byCascade)) {
    console.log(`[backtest] cascata ${cascade}:`, summary);
  }
  // Was previously only printed by backtest.yml's separate "Publicar resumo"
  // step (which writes to $GITHUB_STEP_SUMMARY, not stdout) — invisible to
  // anything reading the job's console log directly (e.g. get_job_logs).
  // Same data, now visible from both the CLI and CI without needing GitHub
  // Summary UI access.
  console.log('[backtest] smcDiagnostics:', report.smcDiagnostics);
  console.log('[backtest] custos:', report.costs);

  // O veredito de amostra fica DEPOIS de tudo e em destaque de propósito: um
  // relatório com poucas operações produz win rate e profit factor de aparência
  // perfeitamente normal, e é exatamente aí que uma decisão errada nasce.
  if (!report.costs.conclusive) {
    const { countedTrades, minTrades: min, inconclusiveReason, expectancyRCI95 } = report.costs;
    const motivo = inconclusiveReason === 'sample_too_small'
      ? `amostra pequena demais (${countedTrades} operações fechadas, mínimo ${min})`
      : inconclusiveReason === 'ci_straddles_zero'
        ? `o intervalo de confiança da expectância cruza zero [${expectancyRCI95.map((v) => v.toFixed(3)).join(', ')}]`
        : 'não há operações com R calculável';
    console.log('');
    console.log('  ⚠️  RESULTADO INCONCLUSIVO — não tire conclusão deste relatório.');
    console.log(`      Motivo: ${motivo}.`);
    console.log('      Win rate e profit factor acima são ruído nesta amostra.');
    console.log('');
  } else {
    console.log(`[backtest] amostra suficiente: ${report.costs.countedTrades} operações, expectância líquida ${report.costs.netExpectancyR?.toFixed(3)}R`);
  }

  const outPath = args.out || 'backtest-report.json';
  // trialLabel/trialArgs: o "conte suas tentativas" da literatura de
  // overfitting reduzido ao mínimo — sem isso, comparar N relatórios meses
  // depois vira arqueologia.
  const enriched = { ...report, trialLabel: args['trial-label'] || null, trialArgs: process.argv.slice(2).join(' ') };
  fs.writeFileSync(outPath, JSON.stringify(enriched, null, 2));
  console.log(`[backtest] relatório completo salvo em ${outPath}`);
}

main().catch((err) => {
  console.error('[backtest] FALHOU:', err);
  process.exitCode = 1;
});
