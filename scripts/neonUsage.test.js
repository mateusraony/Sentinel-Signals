// Item 294 — o CLI do medidor do Neon: lê o histórico de execuções do GitHub (simulado), imprime o relatório e avisa no Telegram
// (simulado). O que se prova: só os workflows que usam o banco entram; execução pulada/na fila fica de fora; paginação e corte;
// erro do GitHub/Telegram vira um CÓDIGO (nunca o token, nunca a URL); simulação não envia; a política manhã/noite; e nenhum
// segredo aparece em nenhum texto impresso.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, fetchWorkflowRuns, listDatabaseWorkflows, usesNeonDatabase, formatReport, MAX_PAGES } from './neon-usage.mjs';
import { summarize } from './neonUsageMeter.mjs';

const GH_TOKEN = 'ghs_TOKENsecreto0123456789abcdefghij';
const TG_TOKEN = '123456:ABC-telegram-secreto';
const TG_CHAT = '-1001234567890';
const REPO = 'dono/projeto';
const T0 = Date.UTC(2026, 10, 1);
const MIN = 60000;
const iso = (ms) => new Date(ms).toISOString();

/** Uma execução no formato da API do GitHub. */
const run = (startMs, durMin = 1, extra = {}) => ({
  id: startMs, status: 'completed', conclusion: 'success', created_at: iso(startMs), run_started_at: iso(startMs), updated_at: iso(startMs + durMin * MIN), ...extra,
});
const scan = (count, everyMin = 15) => Array.from({ length: count }, (_, i) => run(T0 + i * everyMin * MIN));

function workflowsDir(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'neon-wf-'));
  const todos = { 'scan.yml': 'env:\n  DATABASE_URL: ${{ secrets.DATABASE_URL }}\n', 'backup-postgres.yaml': 'env:\n  DATABASE_URL: x\n', 'ci.yml': 'env:\n  TEST_DATABASE_URL: x\n', 'comentario.yml': '# DATABASE_URL só num comentário\non: push\n', ...files };
  for (const [n, t] of Object.entries(todos)) fs.writeFileSync(path.join(dir, n), t);
  return dir;
}

/** fetch falso: GitHub responde `porWorkflow[nome]` (lista de execuções, paginada); Telegram responde `telegram`. */
function fakeFetch({ porWorkflow = {}, ghStatus = 200, telegram = 200 } = {}) {
  const calls = { github: [], telegram: [] };
  const fn = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://api.telegram.org/')) {
      calls.telegram.push({ url: u, body: JSON.parse(init.body) });
      return new Response('{}', { status: telegram });
    }
    calls.github.push({ url: u, headers: init.headers });
    if (ghStatus !== 200) return new Response('{"message":"erro com ghs_TOKENsecreto"}', { status: ghStatus });
    const nome = decodeURIComponent(/workflows\/([^/]+)\/runs/.exec(u)[1]);
    const page = Number(new URL(u).searchParams.get('page'));
    const todas = porWorkflow[nome] ?? [];
    return new Response(JSON.stringify({ total_count: todas.length, workflow_runs: todas.slice((page - 1) * 100, page * 100) }), { status: 200 });
  };
  return { fn, calls };
}

async function rodar({ env = {}, fetchEnv, now = Date.UTC(2026, 10, 5, 11, 17), files, porWorkflow, ghStatus, telegram } = {}) {
  const { fn, calls } = fakeFetch({ porWorkflow: porWorkflow ?? { 'scan.yml': scan(10), 'backup-postgres.yaml': [] }, ghStatus, telegram });
  const out = [];
  const err = [];
  const code = await main({
    env: { GITHUB_TOKEN: GH_TOKEN, GITHUB_REPOSITORY: REPO, ...env }, fetchImpl: fn, now: () => now, workflowsDir: workflowsDir(files), log: (t) => out.push(t), error: (t) => err.push(t),
  });
  void fetchEnv;
  return { code, out: out.join('\n'), err: err.join('\n'), calls };
}

describe('usesNeonDatabase — o que conta como "usa o Neon"', () => {
  it('conta DATABASE_URL e DATABASE_URL_READONLY; NÃO conta o Postgres local do CI, o banco novo da restauração nem comentário', () => {
    expect(usesNeonDatabase('env:\n  DATABASE_URL: ${{ secrets.DATABASE_URL }}')).toBe(true);
    expect(usesNeonDatabase('DATABASE_URL_READONLY: ${{ secrets.DATABASE_URL_READONLY }}')).toBe(true);
    expect(usesNeonDatabase('TEST_DATABASE_URL: postgres://localhost/test')).toBe(false); // o CI (REGRESSÃO: o orçamento contaria)
    expect(usesNeonDatabase('RESTORE_DATABASE_URL: ${{ secrets.RESTORE_DATABASE_URL }}')).toBe(false);
    expect(usesNeonDatabase('# DATABASE_URL só num comentário\non: push')).toBe(false);
    expect(usesNeonDatabase('')).toBe(false);
    expect(usesNeonDatabase(null)).toBe(false);
  });

  it('nos workflows REAIS do repositório: o scan, o backup e a auditoria contam; o CI, o Contexto e o próprio medidor NÃO', () => {
    const lista = listDatabaseWorkflows(path.join(process.cwd(), '.github/workflows'));
    for (const nome of ['scan.yml', 'backup-postgres.yml', 'health-audit.yml', 'backfill.yml', 'recovery.yml']) expect(lista, nome).toContain(nome);
    for (const nome of ['ci.yml', 'neon-usage.yml', 'context-collect.yml', 'context-probe.yml', 'context-notify.yml', 'daily-rule-report.yml', 'keep-warm.yml']) expect(lista, nome).not.toContain(nome);
  });
});

describe('listDatabaseWorkflows', () => {
  it('só os arquivos que citam DATABASE_URL fora de comentário, em ordem; pasta ausente = lista vazia', () => {
    expect(listDatabaseWorkflows(workflowsDir())).toEqual(['backup-postgres.yaml', 'scan.yml']);
    expect(listDatabaseWorkflows('/pasta/que/nao/existe')).toEqual([]);
  });
});

describe('fetchWorkflowRuns', () => {
  it('pagina até a página incompleta; pula execução pulada e na fila; em andamento entra sem fim', async () => {
    const pagina1 = Array.from({ length: 100 }, (_, i) => run(T0 + i * MIN));
    const pagina2 = [run(T0 + 200 * MIN, 1, { conclusion: 'skipped' }), run(T0 + 201 * MIN, 1, { status: 'queued', conclusion: null }),
      run(T0 + 202 * MIN, 1, { status: 'in_progress', conclusion: null }), run(T0 + 203 * MIN)];
    const { fn, calls } = fakeFetch({ porWorkflow: { 'scan.yml': [...pagina1, ...pagina2] } });
    const r = await fetchWorkflowRuns({ repo: REPO, workflow: 'scan.yml', sinceMs: T0, token: GH_TOKEN, fetchImpl: fn });
    expect(calls.github.length).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.runs.length).toBe(102); // 100 + andamento + completa; pulada e na fila ficaram de fora
    expect(r.runs.find((x) => x.startMs === T0 + 202 * MIN).endMs).toBeNull();
    expect(r.runs.every((x) => x.workflow === 'scan.yml')).toBe(true);
  });

  it('pede só o período (filtro created), 100 por página, o nome do arquivo codificado; o token vai só no cabeçalho', async () => {
    const { fn, calls } = fakeFetch({ porWorkflow: { 'a b.yml': [] } });
    await fetchWorkflowRuns({ repo: REPO, workflow: 'a b.yml', sinceMs: Date.UTC(2026, 10, 1, 13), token: GH_TOKEN, fetchImpl: fn });
    const { url, headers } = calls.github[0];
    expect(url).toContain(`/repos/${REPO}/actions/workflows/a%20b.yml/runs?`);
    expect(url).toContain('per_page=100');
    expect(url).toContain('created=%3E%3D2026-11-01');
    expect(url).not.toContain(GH_TOKEN);
    expect(headers.Authorization).toBe(`Bearer ${GH_TOKEN}`);
  });

  it('corta no limite de páginas e AVISA (truncated)', async () => {
    const cheia = Array.from({ length: 300 }, (_, i) => run(T0 + i * MIN));
    const { fn, calls } = fakeFetch({ porWorkflow: { 'scan.yml': cheia } });
    const r = await fetchWorkflowRuns({ repo: REPO, workflow: 'scan.yml', sinceMs: T0, token: GH_TOKEN, fetchImpl: fn, maxPages: 2 });
    expect(calls.github.length).toBe(2);
    expect(r.truncated).toBe(true);
    expect(r.runs.length).toBe(200);
    expect(MAX_PAGES).toBe(40);
  });

  it('erro do GitHub, rede e resposta ruim viram só um CÓDIGO (sem corpo, sem URL, sem token)', async () => {
    for (const [fetchImpl, codigo] of [
      [async () => new Response('{"message":"com ghs_TOKENsecreto"}', { status: 403 }), 'github_http_403'],
      [async () => { throw new Error(`falha em https://api.github.com com ${GH_TOKEN}`); }, 'github_rede'],
      [async () => new Response('<html>', { status: 200 }), 'github_resposta'],
    ]) {
      let erro;
      try { await fetchWorkflowRuns({ repo: REPO, workflow: 'scan.yml', sinceMs: T0, token: GH_TOKEN, fetchImpl }); } catch (e) { erro = e; }
      expect(erro?.message).toBe(codigo);
      expect(erro.message).not.toContain(GH_TOKEN);
    }
  });

  it('corpo sem a lista e data inválida não quebram: simplesmente não contam', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ workflow_runs: [{ status: 'completed', run_started_at: 'ontem' }, null, {}] }), { status: 200 });
    const r = await fetchWorkflowRuns({ repo: REPO, workflow: 'scan.yml', sinceMs: T0, token: GH_TOKEN, fetchImpl });
    expect(r.runs).toEqual([]);
    const vazio = await fetchWorkflowRuns({ repo: REPO, workflow: 'x.yml', sinceMs: T0, token: GH_TOKEN, fetchImpl: async () => new Response('{}', { status: 200 }) });
    expect(vazio.runs).toEqual([]);
  });
});

describe('main — simulação, envio e política', () => {
  it('simulação (ENVIAR ≠ true): imprime o relatório com as tabelas e NÃO manda nada ao Telegram', async () => {
    const r = await rodar({ env: { ENVIAR: 'false', NEON_TRIGGER: 'workflow_dispatch' } });
    expect(r.code).toBe(0);
    expect(r.calls.telegram.length).toBe(0);
    expect(r.out).toContain('## Medidor do Neon: uso estimado de computação');
    expect(r.out).toContain('| scan.yml | 10 |'); // 10 execuções lidas
    expect(r.out).toContain('| backup-postgres.yaml | 0 | 0 |');
    expect(r.out).not.toMatch(/ci\.yml|comentario\.yml/); // não usam o banco
    expect(r.out).toMatch(/Simulação: nada foi enviado/);
    expect(r.out).toContain('Neon: uso de computação do mês (estimado)');
    expect(r.out).toContain('É um MÍNIMO');
  });

  it('agendado de manhã com ENVIAR=true: UM aviso ao Telegram, com o texto do medidor e o chat certo', async () => {
    const r = await rodar({ env: { ENVIAR: 'true', NEON_TRIGGER: 'schedule', TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: TG_CHAT } });
    expect(r.code).toBe(0);
    expect(r.calls.telegram.length).toBe(1);
    expect(r.calls.telegram[0].url).toBe(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`);
    expect(r.calls.telegram[0].body.chat_id).toBe(TG_CHAT);
    expect(r.calls.telegram[0].body.text).toContain('Neon: uso de computação do mês (estimado)');
    expect(r.out).toContain('Aviso enviado ao Telegram.');
  });

  it('agendado à noite com nível OK: não manda (o resumo diário é o da manhã)', async () => {
    const r = await rodar({ now: Date.UTC(2026, 10, 5, 23, 17), env: { ENVIAR: 'true', NEON_TRIGGER: 'schedule', TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: TG_CHAT } });
    expect(r.code).toBe(0);
    expect(r.calls.telegram.length).toBe(0);
    expect(r.out).toMatch(/Nível OK na execução da noite: nada enviado/);
  });

  it('agendado à noite com nível ATENÇÃO (calibrado em 70 CU-h): manda', async () => {
    const r = await rodar({
      now: Date.UTC(2026, 10, 5, 23, 17),
      env: { ENVIAR: 'true', NEON_TRIGGER: 'schedule', TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: TG_CHAT, NEON_BASELINE_CU_HOURS: '70', NEON_BASELINE_AT: '2026-11-02T00:00:00Z' },
    });
    expect(r.calls.telegram.length).toBe(1);
    expect(r.calls.telegram[0].body.text).toContain('Situação: <b>ATENÇÃO</b>');
    expect(r.calls.telegram[0].body.text).toContain('Calibrado com o valor do console do Neon de 02/11');
  });

  it('manual com ENVIAR=true: manda mesmo de noite e mesmo no nível OK', async () => {
    const r = await rodar({ now: Date.UTC(2026, 10, 5, 23, 17), env: { ENVIAR: 'true', NEON_TRIGGER: 'workflow_dispatch', TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: TG_CHAT } });
    expect(r.calls.telegram.length).toBe(1);
  });

  it('o dia de cobrança muda o período lido (filtro created da API e texto)', async () => {
    const r = await rodar({ env: { NEON_BILLING_DAY: '10' } });
    expect(r.calls.github[0].url).toContain('created=%3E%3D2026-10-10');
    expect(r.out).toContain('Período: 2026-10-10 a 2026-11-10 (UTC)');
  });

  it('Telegram recusa (401): código de saída 1, motivo em português, e o token NÃO aparece em lugar nenhum', async () => {
    const r = await rodar({ telegram: 401, env: { ENVIAR: 'true', NEON_TRIGGER: 'schedule', TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: TG_CHAT } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NÃO enviei o aviso: o Telegram recusou o token/);
    for (const t of [r.out, r.err]) { expect(t).not.toContain(TG_TOKEN); expect(t).not.toContain(GH_TOKEN); }
  });

  it('enviar sem os segredos do Telegram: falha visível (código 1), não silêncio', async () => {
    const r = await rodar({ env: { ENVIAR: 'true', NEON_TRIGGER: 'schedule' } });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/NÃO enviei o aviso: faltam os segredos/);
    expect(r.calls.telegram.length).toBe(0);
  });

  it('GitHub recusa (403): código 1, mensagem só com o código, nada é enviado e nenhum segredo vaza', async () => {
    const r = await rodar({ ghStatus: 403, env: { ENVIAR: 'true', NEON_TRIGGER: 'schedule', TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: TG_CHAT } });
    expect(r.code).toBe(1);
    expect(r.err).toContain('github_http_403');
    expect(r.err).toMatch(/Nada foi enviado/);
    expect(r.calls.telegram.length).toBe(0);
    for (const t of [r.out, r.err]) { expect(t).not.toContain(GH_TOKEN); expect(t).not.toContain(TG_TOKEN); }
  });

  it('sem GITHUB_TOKEN ou com repositório mal formado: recusa antes de qualquer rede', async () => {
    for (const env of [{ GITHUB_TOKEN: '' }, { GITHUB_REPOSITORY: 'sem-barra' }, { GITHUB_REPOSITORY: 'a/b/c' }, { GITHUB_REPOSITORY: '' }]) {
      const r = await rodar({ env });
      expect(r.code, JSON.stringify(env)).toBe(1);
      expect(r.calls.github.length).toBe(0);
    }
  });

  it('nenhum segredo em NENHUM texto impresso, nem no caminho feliz', async () => {
    const r = await rodar({ env: { ENVIAR: 'true', NEON_TRIGGER: 'schedule', TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: TG_CHAT } });
    for (const t of [r.out, r.err, JSON.stringify(r.calls.telegram[0].body)]) {
      expect(t).not.toContain(GH_TOKEN);
      expect(t).not.toContain(TG_TOKEN);
    }
  });
});

describe('formatReport', () => {
  it('avisa quando o histórico foi cortado (o número real é MAIOR) e mostra o tempo por workflow', () => {
    const summary = summarize({ runs: [], nowMs: T0 + 10 * 3600000 });
    const t = formatReport({ summary, workflows: ['scan.yml'], runsByWorkflow: { 'scan.yml': { count: 3, minutes: 4.6 } }, truncated: true, message: 'm', sentNote: 'n' });
    expect(t).toContain('o número real é MAIOR');
    expect(t).toContain('| scan.yml | 3 | 5 |');
    const sem = formatReport({ summary, workflows: [], runsByWorkflow: {}, truncated: false, message: 'm', sentNote: 'n' });
    expect(sem).not.toContain('MAIOR');
  });
});
