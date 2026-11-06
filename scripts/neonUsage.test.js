// Item 294 — o CLI do medidor do Neon: lê o histórico de execuções do GitHub (simulado), imprime o relatório e avisa no Telegram
// (simulado). O que se prova: só os workflows que usam o banco entram; execução pulada/na fila fica de fora; paginação e corte;
// erro do GitHub/Telegram vira um CÓDIGO (nunca o token, nunca a URL); simulação não envia; a política manhã/noite; e nenhum
// segredo aparece em nenhum texto impresso.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main, fetchWorkflowRuns, listDatabaseWorkflows, usesNeonDatabase, formatReport, API_RESULT_CAP, SPLIT_AT } from './neon-usage.mjs';
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

/**
 * fetch falso: GitHub responde `porWorkflow[nome]` filtrando pelo intervalo `created=AAAA-MM-DD..AAAA-MM-DD` (dias UTC, inclusivo) e
 * paginando de 100 em 100; `cap` imita o teto do GitHub (no máximo `cap` resultados por consulta com `created`); `totalMode` diz o que
 * vai em `total_count`: 'real' (a contagem verdadeira), 'capped' (já cortada no teto) ou 'ausente' (sem o campo). Telegram responde `telegram`.
 */
function fakeFetch({ porWorkflow = {}, ghStatus = 200, telegram = 200, cap = Infinity, totalMode = 'real' } = {}) {
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
    const params = new URL(u).searchParams;
    const page = Number(params.get('page'));
    const [de, ate] = String(params.get('created') ?? '0000-01-01..9999-12-31').split('..');
    const dentro = (porWorkflow[nome] ?? []).filter((r) => {
      const dia = String(r.created_at).slice(0, 10);
      return dia >= de && dia <= ate;
    });
    const devolvidas = dentro.slice(0, cap);
    const body = { workflow_runs: devolvidas.slice((page - 1) * 100, page * 100) };
    if (totalMode === 'real') body.total_count = dentro.length;
    if (totalMode === 'capped') body.total_count = devolvidas.length;
    return new Response(JSON.stringify(body), { status: 200 });
  };
  return { fn, calls };
}

async function rodar({ env = {}, fetchEnv, now = Date.UTC(2026, 10, 5, 11, 17), files, porWorkflow, ghStatus, telegram, cap, totalMode } = {}) {
  const { fn, calls } = fakeFetch({ porWorkflow: porWorkflow ?? { 'scan.yml': scan(10), 'backup-postgres.yaml': [] }, ghStatus, telegram, cap, totalMode });
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
  const pedir = (fetchImpl, extra = {}) => fetchWorkflowRuns({ repo: REPO, workflow: 'scan.yml', sinceMs: T0, untilMs: T0 + 5 * 86400000, token: GH_TOKEN, fetchImpl, ...extra });

  it('pagina até a página incompleta; pula execução pulada e na fila; em andamento entra sem fim', async () => {
    const pagina1 = Array.from({ length: 100 }, (_, i) => run(T0 + i * MIN));
    const pagina2 = [run(T0 + 200 * MIN, 1, { conclusion: 'skipped' }), run(T0 + 201 * MIN, 1, { status: 'queued', conclusion: null }),
      run(T0 + 202 * MIN, 1, { status: 'in_progress', conclusion: null }), run(T0 + 203 * MIN)];
    const { fn, calls } = fakeFetch({ porWorkflow: { 'scan.yml': [...pagina1, ...pagina2] } });
    const r = await pedir(fn);
    expect(calls.github.length).toBe(2);
    expect(r.truncated).toBe(false);
    expect(r.runs.length).toBe(102); // 100 + andamento + completa; pulada e na fila ficaram de fora
    expect(r.runs.find((x) => x.startMs === T0 + 202 * MIN).endMs).toBeNull();
    expect(r.runs.every((x) => x.workflow === 'scan.yml')).toBe(true);
  });

  it('pede o período como intervalo de datas (created=de..até), 100 por página, o nome do arquivo codificado; o token vai só no cabeçalho', async () => {
    const { fn, calls } = fakeFetch({ porWorkflow: { 'a b.yml': [] } });
    await fetchWorkflowRuns({ repo: REPO, workflow: 'a b.yml', sinceMs: Date.UTC(2026, 10, 1, 13), untilMs: Date.UTC(2026, 10, 5, 11), token: GH_TOKEN, fetchImpl: fn });
    const { url, headers } = calls.github[0];
    expect(url).toContain(`/repos/${REPO}/actions/workflows/a%20b.yml/runs?`);
    expect(url).toContain('per_page=100');
    expect(url).toContain('created=2026-11-01..2026-11-05');
    expect(url).not.toContain(GH_TOKEN);
    expect(headers.Authorization).toBe(`Bearer ${GH_TOKEN}`);
  });

  it('constantes do teto da API', () => {
    expect([API_RESULT_CAP, SPLIT_AT]).toEqual([1000, 900]);
  });

  for (const totalMode of ['real', 'capped', 'ausente']) {
    it(`REGRESSÃO (Codex, PR #548): com o teto de 1.000 do GitHub, 20 dias a cada 15 min (1.920 execuções) vêm COMPLETOS dividindo o período — total_count ${totalMode}`, async () => {
      const todas = Array.from({ length: 1920 }, (_, i) => run(T0 + i * 15 * MIN));
      const { fn, calls } = fakeFetch({ porWorkflow: { 'scan.yml': todas }, cap: API_RESULT_CAP, totalMode });
      const r = await pedir(fn, { untilMs: T0 + 19 * 86400000 + 23 * 3600000 });
      expect(r.runs.length).toBe(1920);
      expect(new Set(r.runs.map((x) => x.startMs)).size).toBe(1920); // nenhuma execução repetida
      expect(r.truncated).toBe(false);
      expect(calls.github.length).toBeLessThan(80); // dividir custa poucas consultas
    });
  }

  it('o mês inteiro do scan a cada 15 min (2.880 execuções) também vem completo', async () => {
    const todas = Array.from({ length: 2880 }, (_, i) => run(T0 + i * 15 * MIN));
    const { fn } = fakeFetch({ porWorkflow: { 'scan.yml': todas }, cap: API_RESULT_CAP });
    const r = await pedir(fn, { untilMs: T0 + 29 * 86400000 + 23 * 3600000 });
    expect(r.runs.length).toBe(2880);
    expect(r.truncated).toBe(false);
  });

  it('um ÚNICO dia com mais execuções que o teto não dá para dividir: avisa (truncated) em vez de fingir que está completo', async () => {
    const todas = Array.from({ length: 1200 }, (_, i) => run(T0 + i * 20000)); // 1.200 execuções no mesmo dia
    const { fn } = fakeFetch({ porWorkflow: { 'scan.yml': todas }, cap: API_RESULT_CAP, totalMode: 'capped' });
    const r = await pedir(fn, { untilMs: T0 + 3600000 });
    expect(r.truncated).toBe(true);
    expect(r.runs.length).toBeLessThanOrEqual(API_RESULT_CAP);
  });

  it('um dia com 950 execuções (perto do teto, mas abaixo dele): vem TODO e NÃO é marcado como cortado', async () => {
    const dia = Array.from({ length: 950 }, (_, i) => run(T0 + i * 60000));
    for (const totalMode of ['real', 'capped', 'ausente']) {
      const { fn } = fakeFetch({ porWorkflow: { 'scan.yml': dia }, cap: API_RESULT_CAP, totalMode });
      const r = await pedir(fn, { untilMs: T0 + 3600000 });
      expect(r.runs.length, totalMode).toBe(950);
      expect(r.truncated, totalMode).toBe(false);
    }
  });

  it('poucas execuções (abaixo do limite de divisão): UMA consulta só para o período todo', async () => {
    const { fn, calls } = fakeFetch({ porWorkflow: { 'scan.yml': scan(50) } });
    const r = await pedir(fn);
    expect(calls.github.length).toBe(1);
    expect(r.runs.length).toBe(50);
  });

  it('erro do GitHub, rede e resposta ruim viram só um CÓDIGO (sem corpo, sem URL, sem token)', async () => {
    for (const [fetchImpl, codigo] of [
      [async () => new Response('{"message":"com ghs_TOKENsecreto"}', { status: 403 }), 'github_http_403'],
      [async () => { throw new Error(`falha em https://api.github.com com ${GH_TOKEN}`); }, 'github_rede'],
      [async () => new Response('<html>', { status: 200 }), 'github_resposta'],
    ]) {
      let erro;
      try { await pedir(fetchImpl); } catch (e) { erro = e; }
      expect(erro?.message).toBe(codigo);
      expect(erro.message).not.toContain(GH_TOKEN);
    }
  });

  it('corpo sem a lista e data inválida não quebram: simplesmente não contam', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ workflow_runs: [{ status: 'completed', run_started_at: 'ontem' }, null, {}] }), { status: 200 });
    expect((await pedir(fetchImpl)).runs).toEqual([]);
    expect((await pedir(async () => new Response('{}', { status: 200 }))).runs).toEqual([]);
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
    expect(r.calls.github[0].url).toContain('created=2026-10-10..2026-11-05');
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

describe('main — histórico cortado pelo GitHub', () => {
  it('um dia com mais execuções que o teto: o relatório E o aviso do Telegram dizem que o número real é MAIOR', async () => {
    const dia = Array.from({ length: 1200 }, (_, i) => run(Date.UTC(2026, 10, 5, 0, 0, 0) + i * 20000));
    const r = await rodar({
      now: Date.UTC(2026, 10, 5, 11, 17), cap: API_RESULT_CAP, totalMode: 'capped', porWorkflow: { 'scan.yml': dia },
      env: { ENVIAR: 'true', NEON_TRIGGER: 'schedule', TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: TG_CHAT },
    });
    expect(r.out).toContain('o número real é MAIOR');
    expect(r.calls.telegram[0].body.text).toContain('o histórico do GitHub veio incompleto; o consumo real é MAIOR');
  });

  it('histórico completo: nenhum aviso de corte', async () => {
    const r = await rodar({ env: { ENVIAR: 'true', NEON_TRIGGER: 'schedule', TELEGRAM_BOT_TOKEN: TG_TOKEN, TELEGRAM_CHAT_ID: TG_CHAT } });
    expect(r.out).not.toContain('MAIOR');
    expect(r.calls.telegram[0].body.text).not.toContain('incompleto');
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
