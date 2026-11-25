// Decide se manda o aviso "servidor da API FORA DO AR / VOLTOU" (docs/known-risks.md item 309). Roda em `api-health-alert.yml`, depois de cada execução do
// `keep-warm.yml`. SÓ LÊ a API do GitHub (execuções e jobs do próprio repositório) e escreve a decisão em $GITHUB_OUTPUT; quem manda o Telegram é o passo seguinte do workflow.
// Sem banco, sem Firebase, sem escrita. O log mostra só contagens e a decisão (o repositório é público); o token nunca é impresso.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { decideApiAlert, pingStepResult, alertText, DEFAULT_THRESHOLD } from './apiHealthStreak.mjs';

const WORKFLOW_FILE = 'keep-warm.yml';
const RUNS_TO_READ = 12;

async function gh(path, token) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`http_${res.status}`);
  return res.json();
}

/** Lê as últimas execuções do keep-warm (mais nova primeiro) e devolve o resultado do passo de ping de cada uma. */
export async function recentPingResults({ repo, token, triggerRunId }) {
  const list = await gh(`/repos/${repo}/actions/workflows/${WORKFLOW_FILE}/runs?status=completed&per_page=${RUNS_TO_READ}`, token);
  const ids = (list.workflow_runs || []).map((r) => r.id);
  // A API pode atrasar alguns segundos: a execução que acabou de disparar este aviso tem que estar na lista, na frente.
  if (triggerRunId && !ids.includes(Number(triggerRunId))) ids.unshift(Number(triggerRunId));
  const results = [];
  for (const id of ids) {
    const jobs = await gh(`/repos/${repo}/actions/runs/${id}/jobs`, token);
    results.push(pingStepResult(jobs.jobs));
  }
  return results;
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPOSITORY;
  const out = process.env.GITHUB_OUTPUT;
  const write = (obj) => { if (out) fs.appendFileSync(out, Object.entries(obj).map(([k, v]) => `${k}=${String(v).replace(/\r?\n/g, ' ')}\n`).join('')); };
  if (!token || !repo) {
    console.log('[api-health] sem GITHUB_TOKEN/GITHUB_REPOSITORY: nada a decidir.');
    write({ action: 'none' });
    return;
  }
  try {
    const results = await recentPingResults({ repo, token, triggerRunId: process.env.TRIGGER_RUN_ID });
    const d = decideApiAlert(results, DEFAULT_THRESHOLD);
    console.log(`[api-health] pings lidos: ${results.length} (válidos: ${results.filter((x) => x === 'success' || x === 'failure').length}) · decisão: ${d.action} · falhas seguidas: ${d.streak} · antes: ${d.previousStreak}`);
    if (d.action === 'none') { write({ action: 'none' }); return; }
    const t = alertText(d.action, d.streak);
    write({ action: d.action, icon: t.icon, title: t.title, hint: t.hint });
  } catch (err) {
    // Só um código: o log é público e a mensagem crua pode trazer detalhes da requisição.
    console.log(`[api-health] não consegui ler o GitHub (${/^http_\d+$/.test(String(err?.message)) ? err.message : 'erro'}): sem aviso nesta passada.`);
    write({ action: 'none' });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
