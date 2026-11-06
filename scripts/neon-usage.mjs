#!/usr/bin/env node
// CLI do medidor de uso de computação do Neon (docs/known-risks.md item 294). A conta mora em scripts/neonUsageMeter.mjs (pura);
// aqui só se lê o histórico de execuções no GitHub, imprime o relatório (markdown) e, se for o caso, manda UM aviso no Telegram.
//
// SEM BANCO, de propósito: ler o consumo não pode acordar o Neon (a cota de computação é justamente o problema). Só fala com a API
// do GitHub (token do próprio workflow, `actions: read`) e com o Telegram. O token e o do Telegram nunca vão para o texto de erro.
//
// Variáveis de ambiente lidas: GITHUB_TOKEN, GITHUB_REPOSITORY (dono/nome), NEON_TRIGGER ("schedule" = agendado; qualquer outra
// coisa = manual), ENVIAR ("true" liga o envio), TELEGRAM_BOT_TOKEN/TELEGRAM_CHAT_ID (só quando há envio) e, opcionais,
// NEON_BILLING_DAY (dia 1..28 em que o período de cobrança recomeça; padrão 1) e NEON_BASELINE_CU_HOURS + NEON_BASELINE_AT
// (calibração com o valor do console do Neon).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { billingPeriod, summarize, parseBaseline, shouldSend, buildMessage } from './neonUsageMeter.mjs';
import { sendTelegram, describeSendFailure } from './contextTelegram.mjs';

const GITHUB_API = 'https://api.github.com';
const PER_PAGE = 100;
/** O scan a cada 15 min gera ~2.900 execuções por mês = 29 páginas; 40 dá folga e ainda corta uma busca descontrolada. */
export const MAX_PAGES = 40;
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;

/**
 * O workflow conecta no Neon de produção? Cita `DATABASE_URL` (ou `DATABASE_URL_READONLY`) fora de comentário e SEM prefixo:
 * `TEST_DATABASE_URL` (o Postgres local do CI, que não é o Neon) e `RESTORE_DATABASE_URL` (um banco NOVO, de outro provedor) não contam.
 * (O `workflowTouchesDatabase` do orçamento aceita qualquer sufixo, o que contaria o `ci.yml` — várias execuções por dia — como Neon.)
 */
export function usesNeonDatabase(yamlText) {
  const code = String(yamlText).split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  return /(?<![A-Za-z0-9_])DATABASE_URL(?:_READONLY)?(?![A-Za-z0-9_])/.test(code);
}

/** Arquivos de `.github/workflows` que usam o Neon de produção (ver `usesNeonDatabase`). */
export function listDatabaseWorkflows(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => /\.ya?ml$/.test(n))
    .filter((n) => usesNeonDatabase(fs.readFileSync(path.join(dir, n), 'utf8')))
    .sort();
}

/**
 * Execuções de UM workflow desde `sinceMs`, da API do GitHub (paginada). Execução pulada ou que ainda nem começou não usou o banco e
 * fica de fora; em andamento entra sem `endMs`. Qualquer falha vira `Error('github_http_<código>')`/`github_rede` — SEM o corpo da
 * resposta nem a URL (o cabeçalho tem o token).
 * @returns {Promise<{ runs: { workflow: string, startMs: number, endMs: number|null }[], truncated: boolean }>}
 */
export async function fetchWorkflowRuns({ repo, workflow, sinceMs, token, fetchImpl = fetch, maxPages = MAX_PAGES }) {
  const since = new Date(sinceMs).toISOString().slice(0, 10);
  const runs = [];
  let truncated = false;
  for (let page = 1; page <= maxPages; page += 1) {
    const url = `${GITHUB_API}/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/runs?per_page=${PER_PAGE}&page=${page}&created=${encodeURIComponent(`>=${since}`)}`;
    let res;
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'sentinel-signals-neon-usage' } });
    } catch {
      throw new Error('github_rede'); // sem error.message: pode citar a URL
    }
    if (!res.ok) throw new Error(`github_http_${res.status}`);
    let body;
    try { body = await res.json(); } catch { throw new Error('github_resposta'); }
    const list = Array.isArray(body?.workflow_runs) ? body.workflow_runs : [];
    for (const r of list) {
      if (r?.conclusion === 'skipped') continue;
      if (r?.status !== 'completed' && r?.status !== 'in_progress') continue;
      const startMs = Date.parse(r.run_started_at ?? r.created_at ?? '');
      if (!Number.isFinite(startMs)) continue;
      const endMs = r.status === 'completed' ? Date.parse(r.updated_at ?? '') : NaN;
      runs.push({ workflow, startMs, endMs: Number.isFinite(endMs) ? endMs : null });
    }
    if (list.length < PER_PAGE) return { runs, truncated };
    if (page === maxPages) truncated = true;
  }
  return { runs, truncated };
}

const fmt1 = (x) => (Math.round(x * 10) / 10).toFixed(1).replace('.', ',');
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Relatório em markdown (Job Summary). Só números e nomes de arquivo; nada vindo de fora além das contagens. */
export function formatReport({ summary, workflows, runsByWorkflow, truncated, message, sentNote }) {
  const lines = ['## Medidor do Neon: uso estimado de computação', ''];
  lines.push(`Período: ${isoDay(summary.periodStartMs)} a ${isoDay(summary.periodEndMs)} (UTC). Estimativa pelo histórico do GitHub: **${fmt1(summary.usedCu)} de ${fmt1(summary.limit)} CU-h** (${Math.round(summary.ratio * 100)}%).`);
  lines.push('É um MÍNIMO: não inclui o painel aberto, o servidor do Render nem consultas feitas à mão.');
  if (truncated) lines.push('ATENÇÃO: o histórico passou do limite de páginas e foi cortado; o número real é MAIOR.');
  lines.push('', '| Workflow que usa o banco | Execuções no período | Tempo de execução (min) |', '|---|---:|---:|');
  for (const w of workflows) {
    const r = runsByWorkflow[w] ?? { count: 0, minutes: 0 };
    lines.push(`| ${w} | ${r.count} | ${Math.round(r.minutes)} |`);
  }
  lines.push('', 'Mensagem do aviso:', '', '```', message, '```', '', sentNote);
  return lines.join('\n');
}

export async function main({
  env = process.env, fetchImpl = fetch, now = Date.now, workflowsDir = '.github/workflows', log = console.log, error = console.error,
} = {}) {
  const token = String(env.GITHUB_TOKEN ?? '').trim();
  const repo = String(env.GITHUB_REPOSITORY ?? '').trim();
  if (!token || !REPO_RE.test(repo)) {
    error('[neon-usage] faltam GITHUB_TOKEN e/ou GITHUB_REPOSITORY (o workflow os fornece).');
    return 1;
  }
  const nowMs = now();
  const day = Number(env.NEON_BILLING_DAY);
  const billingDay = Number.isInteger(day) && day >= 1 && day <= 28 ? day : 1;
  const { startMs } = billingPeriod(nowMs, billingDay);

  const workflows = listDatabaseWorkflows(workflowsDir);
  const runs = [];
  const runsByWorkflow = {};
  let truncated = false;
  try {
    for (const workflow of workflows) {
      const r = await fetchWorkflowRuns({ repo, workflow, sinceMs: startMs, token, fetchImpl });
      truncated = truncated || r.truncated;
      runs.push(...r.runs);
      runsByWorkflow[workflow] = {
        count: r.runs.length,
        minutes: r.runs.reduce((s, x) => s + ((x.endMs ?? nowMs) - x.startMs) / 60000, 0),
      };
    }
  } catch (err) {
    error(`[neon-usage] não consegui ler o histórico de execuções do GitHub (${String(err?.message ?? 'erro').slice(0, 40)}). Nada foi enviado.`);
    return 1;
  }

  const summary = summarize({ runs, nowMs, billingDay, baseline: parseBaseline(env) });
  const message = buildMessage(summary);
  const trigger = env.NEON_TRIGGER === 'schedule' ? 'schedule' : 'manual';
  const wantsSend = env.ENVIAR === 'true';

  let sentNote = 'Simulação: nada foi enviado (para enviar, marque "Enviar de verdade?").';
  let code = 0;
  if (wantsSend) {
    if (!shouldSend({ level: summary.level, nowMs, trigger })) {
      sentNote = 'Nível OK na execução da noite: nada enviado (o resumo diário sai na execução da manhã).';
    } else {
      const sent = await sendTelegram({ text: message, env, fetchImpl });
      if (sent.ok) sentNote = 'Aviso enviado ao Telegram.';
      else {
        sentNote = `NÃO enviei o aviso: ${describeSendFailure(sent.reason)}.`;
        code = 1;
      }
    }
  }
  log(formatReport({ summary, workflows, runsByWorkflow, truncated, message, sentNote }));
  return code;
}

// Só roda quando executado direto (node scripts/neon-usage.mjs), nunca ao ser importado.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then((code) => { process.exitCode = code; });
}
