#!/usr/bin/env node
// Replay de recuperação depois de queda longa do banco (docs/known-risks.md item 288).
// Uso (no GitHub Actions, workflow .github/workflows/recovery.yml):
//   node scripts/dist/run-recovery.mjs --mode=dry-run --out recovery-dry-run.json
//
// Modo `dry-run` (TESTE A SECO): lê o banco (DATABASE_URL_READONLY se existir), roda o
// replay numa loja em memória e escreve o relatório no Job Summary + um JSON. NUNCA grava
// no banco e NUNCA manda Telegram (o bundle redireciona o Telegram do scanner para no-op e
// este arquivo não importa o remetente real). O modo de aplicar vem no PR-R3.
import fs from 'node:fs';
import { backend as liveBackend } from './adminEntities.js';
import { getPineConfig, getPineConfigStatus } from './adminPineConfig.js';
import { backend as entitiesTarget } from './recoveryEntities.js';
import { runDryRun, formatDryRunMarkdown, formatAbortMarkdown } from './recoveryDryRun.mjs';
import { exportSeries } from './recoveryMarketDataProvider.js';
import { isDatabaseQuotaExhausted } from './failureClassification.mjs';
import { withTimeout, forceExit } from './scanTimeout.mjs';

const DRY_RUN_TIMEOUT_MS = 25 * 60 * 1000;

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode !== 'dry-run') {
    writeSummary(formatAbortMarkdown(new Error(`modo "${args.mode}" não existe ainda — só "dry-run" (teste a seco)`)));
    return 1;
  }
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
    if (typeof args.out === 'string') {
      const { journal, ...rest } = result;
      fs.writeFileSync(args.out, JSON.stringify({ version: 1, ...rest, journal, candles: exportSeries() }));
    }
    return 0;
  } catch (err) {
    const message = String(err?.message ?? err);
    const friendly = isDatabaseQuotaExhausted(message)
      ? Object.assign(new Error('o banco (Neon) ainda está sem cota de computação — rode de novo depois da renovação do mês'), { code: 'db_quota' })
      : err;
    writeSummary(formatAbortMarkdown(friendly));
    return 1;
  }
}

main().then((code) => forceExit(code), (err) => { console.error(err); forceExit(1); });
