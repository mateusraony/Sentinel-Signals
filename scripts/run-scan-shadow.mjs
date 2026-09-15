// Entry point for the Fase 1 shadow-mode workflow (see
// .github/workflows/scan-shadow.yml and docs/known-risks.md item 56 "Modo
// sombra"). Bundled with esbuild (scripts/build-scan-shadow.mjs) before
// running — same reason as scripts/run-scan.mjs (Vite '@/' alias + Node's
// native ESM loader can't resolve it directly).
//
// Deliberately simpler than run-scan.mjs: no per-asset healthcheck alerting
// and no external watchdog ping — those exist to protect REAL trading
// signals from going unnoticed, which doesn't apply here (nothing here ever
// opens a real TradeOperation; the whole point is prospective, log-only
// observation). scanAllAssets/priceCheckActiveOps are imported from
// src/lib/scanner.js WITHOUT modification — see scripts/build-scan-shadow.mjs
// for the 4 import redirections that route every write to isolated,
// 'experimentalRf1hShadow'-prefixed Firestore collections instead of the
// real production ones.
import { pathToFileURL } from 'node:url';
import { scanAllAssets, priceCheckActiveOps } from '../src/lib/scanner.js';

// Same pure check as run-scan.mjs's computeHasPartialFailures, deliberately
// NOT imported from there: run-scan.mjs also imports './adminTelegram.js'
// (the REAL one, with real bot token usage) and other production-only
// modules that scripts/build-scan-shadow.mjs never redirects (only 3 of the
// 4 imports scanner.js itself makes are redirected — see this file's header
// comment) — importing run-scan.mjs here would pull real Telegram code into
// the isolated shadow bundle. Same "never share code with the real path"
// precedent already used by scripts/adminEntitiesShadow.js's own header
// comment, applied to this 2-line function instead of a whole adapter.
export function hasPartialFailures(scanFailed, priceCheckErrors) {
  return scanFailed.length > 0 || priceCheckErrors.length > 0;
}

async function main() {
  const started = Date.now();

  const { total, results } = await scanAllAssets();
  const failed = results.filter((r) => !r.success);
  console.log(`[scan-shadow] scanAllAssets: ${total} ativo(s), ${failed.length} falha(s)`);
  failed.forEach((r) => console.error(`[scan-shadow]   ${r.symbol}: ${r.error}`));

  const { errors: priceCheckErrors } = await priceCheckActiveOps();
  console.log(`[scan-shadow] priceCheckActiveOps done, ${priceCheckErrors?.length ?? 0} erro(s)`);

  console.log(`[scan-shadow] finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);

  // Achado real (auditoria externa, 2026-09-15): scanAllAssets captura erro
  // por-ativo e devolve {success:false} em vez de lançar — main() terminava
  // normal mesmo com TODOS os ativos falhando, e o job ficava verde. Mesma
  // classe de bug que o P1 já tinha corrigido no run-scan.mjs principal,
  // nunca portada pra cá.
  return { failedPartially: hasPartialFailures(failed, priceCheckErrors ?? []) };
}

// Corpo só roda quando o arquivo é EXECUTADO, nunca quando é importado —
// mesmo padrão de run-scan.mjs/health-audit.mjs (item 166: "módulo que faz
// trabalho no carregamento é intestável"). Sem isto, um teste importando
// hasPartialFailures acima disparava o scan de verdade contra produção.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(({ failedPartially }) => {
    process.exitCode = failedPartially ? 1 : 0;
  }).catch((err) => {
    console.error('[scan-shadow] FAILED:', err);
    process.exitCode = 1;
  });
}
