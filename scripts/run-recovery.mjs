#!/usr/bin/env node
// Replay de recuperação depois de queda longa do banco (docs/known-risks.md item 288).
// Uso (no GitHub Actions, workflow .github/workflows/recovery.yml):
//   node scripts/dist/run-recovery.mjs --mode=dry-run --out recovery-dry-run.json
//   NUMERO_TESTE=<id> node scripts/dist/run-recovery.mjs --mode=apply --approved <arquivo> --out recovery-apply.json
//
// `dry-run` (TESTE A SECO): lê o banco (DATABASE_URL_READONLY se existir), roda o replay numa
// loja em memória e escreve o relatório. NUNCA grava e NUNCA manda Telegram.
// `apply` (APLICAR): só com o número do teste a seco aprovado pelo usuário (NUMERO_TESTE) e o
// artefato dele. Confere que nada mudou, grava pelo mesmo motor e manda UMA mensagem no
// Telegram (sucesso ou falha). O scanner fica mudo nos dois modos (pacote com backtestTelegram).
import fs from 'node:fs';
import { backend as liveBackend } from './adminEntities.js';
import { getPineConfig, getPineConfigStatus } from './adminPineConfig.js';
import { notifyRecoverySummary } from './adminTelegram.js';
import { backend as entitiesTarget } from './recoveryEntities.js';
import { runDryRun, formatDryRunMarkdown, formatAbortMarkdown } from './recoveryDryRun.mjs';
import { runApply, formatApplyMarkdown } from './recoveryApply.mjs';
import { exportSeries } from './recoveryMarketDataProvider.js';
import { isDatabaseQuotaExhausted } from './failureClassification.mjs';
import { withTimeout, forceExit } from './scanTimeout.mjs';

const DRY_RUN_TIMEOUT_MS = 25 * 60 * 1000;
const APPLY_TIMEOUT_MS = 170 * 60 * 1000;
// Parada limpa: depois disto NÃO se começa outro ativo (sobram ~15 min para terminar o atual, conferir e avisar).
const APPLY_STOP_NEW_ASSET_MS = 150 * 60 * 1000;
// Último recurso: folga para o envio do Telegram e a escrita do relatório depois do prazo da aplicação.
const APPLY_LAST_RESORT_MS = 5 * 60 * 1000;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const [k, v] = a.slice(2).split('=');
    out[k] = v ?? (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[(i += 1)] : true);
  }
  return out;
}

async function fetchWorkflowStates() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) throw Object.assign(new Error('sem GITHUB_REPOSITORY/GITHUB_TOKEN para conferir se o scan está desativado'), { code: 'no_github_api' });
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows?per_page=100`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'sentinel-recovery' },
  });
  if (!res.ok) throw Object.assign(new Error(`API do GitHub respondeu ${res.status} ao listar workflows`), { code: 'no_github_api' });
  const body = await res.json();
  return (body.workflows || []).map((w) => ({ path: w.path, state: w.state }));
}

function writeSummary(markdown) {
  console.log(markdown);
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

const friendly = (err) => (isDatabaseQuotaExhausted(String(err?.message ?? err))
  ? Object.assign(new Error('o banco (Neon) ainda está sem cota de computação — rode de novo depois da renovação do mês'), { code: 'db_quota' })
  : err);

async function dryRun(args) {
  // Contrato só-leitura (mesmo mecanismo de health-audit.mjs, item 179): getPool() lê
  // process.env.DATABASE_URL na 1ª consulta, então a troca vale para tudo daqui em diante.
  const readonly = Boolean(process.env.DATABASE_URL_READONLY);
  if (readonly) process.env.DATABASE_URL = process.env.DATABASE_URL_READONLY;
  try {
    const workflows = await fetchWorkflowStates();
    const result = await withTimeout(runDryRun({
      liveBackend, workflows, entitiesTarget, getPineConfig, getPineConfigStatus,
      nowMs: Date.now(), runId: String(process.env.GITHUB_RUN_ID || `local-${Date.now()}`),
    }), DRY_RUN_TIMEOUT_MS, 'teste a seco da recuperação');
    let md = formatDryRunMarkdown(result);
    if (!readonly) md += '\n\n> Aviso: rodou sem a credencial só-leitura (DATABASE_URL_READONLY). Mesmo assim nada foi gravado: o retrato foi lido por um proxy que recusa escrita.';
    writeSummary(md);
    if (typeof args.out === 'string') fs.writeFileSync(args.out, JSON.stringify({ ...result, candles: exportSeries() }));
    return 0;
  } catch (err) {
    writeSummary(formatAbortMarkdown(friendly(err)));
    return 1;
  }
}

async function apply(args) {
  const approvedRunId = String(process.env.NUMERO_TESTE ?? '').trim();
  let approved = null;
  try {
    if (typeof args.approved === 'string') approved = JSON.parse(fs.readFileSync(args.approved, 'utf8'));
  } catch { approved = null; }
  let workflows = [];
  let workflowsError = null;
  try {
    workflows = await fetchWorkflowStates();
  } catch (err) {
    // Falha da API do GitHub NÃO é "o scan está ligado": a causa certa segue para a mensagem única.
    workflowsError = String(err?.message ?? err);
    console.error(workflowsError);
  }
  const startedMs = Date.now();
  let outcome;
  try {
    // O prazo duro (timeoutMs) e a parada limpa entre ativos (deadlineMs) vivem DENTRO de runApply,
    // que sempre devolve o resultado e manda a única mensagem do Telegram. O withTimeout de fora é
    // só o último recurso (algo travou até no envio) e também gera relatório.
    outcome = await withTimeout(runApply({
      liveBackend, workflows, workflowsError, entitiesTarget, getPineConfig, getPineConfigStatus,
      nowMs: startedMs, runId: String(process.env.GITHUB_RUN_ID || `local-${Date.now()}`),
      approved, approvedRunId,
      timeoutMs: APPLY_TIMEOUT_MS, deadlineMs: startedMs + APPLY_STOP_NEW_ASSET_MS,
      sendSummary: notifyRecoverySummary,
    }), APPLY_TIMEOUT_MS + APPLY_LAST_RESORT_MS, 'aplicação da recuperação');
  } catch (error) {
    outcome = {
      ok: false, mode: 'apply', error, code: error?.code ?? 'apply_unexpected', wrote: true, telegramSent: false,
      summary: 'ATENÇÃO: a aplicação terminou de forma inesperada (travou até no fim) — pode ter gravado parte.\nNÃO rode de novo e NÃO religue o scan. Chame o Claude. O backup feito logo antes está no repositório privado de backups.',
    };
  }
  writeSummary(formatApplyMarkdown(outcome));
  if (typeof args.out === 'string') {
    const { error, ...rest } = outcome;
    fs.writeFileSync(args.out, JSON.stringify({ ...rest, error: error ? { code: error.code ?? null, message: String(error.message ?? error) } : null }));
  }
  return outcome.ok && !outcome.partial ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'dry-run') return dryRun(args);
  if (args.mode === 'apply') return apply(args);
  writeSummary(formatAbortMarkdown(new Error(`modo "${args.mode}" não existe — use "dry-run" (teste a seco) ou "apply" (aplicar)`)));
  return 1;
}

main().then((code) => forceExit(code), (err) => { console.error(err); forceExit(1); });
