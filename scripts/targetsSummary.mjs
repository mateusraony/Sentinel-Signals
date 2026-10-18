// Resumo do teste dos alvos — docs/known-risks.md item 281.
// Lógica pura (testável sem rodar main no carregamento — item 166); o CLI é
// scripts/targets-summary.mjs, chamado pelo workflow targets-test.yml.
//
// Aplica o pré-registro (docs/experiments/targets-prereg.json) ao pé da letra:
// 1. controle de cada janela presente, válido e da janela/moedas
//    pré-registradas; nas janelas com `controlReproduction`, o controle
//    precisa reproduzir o item 270 na precisão registrada — senão PARADO.
//    Relatório ausente/inválido é FALHA_DE_EXECUCAO (refazer), não PARADO.
//    O workflow roda os braços só DEPOIS desta checagem (checkControls);
// 2. cada par controle × braço passa pelo compareReports com a família de 6 e
//    a checagem de procedência (`targetArm`) — par recusado não tem número;
// 3. braço com mais de 50% das operações no alvo de hoje numa janela =
//    inconclusivo ali;
// 4. veredito por braço: APROVADO / PIOR só com diferença significativa no
//    mesmo sentido em todas as janelas que decidem e o mesmo sinal na janela
//    de replicação.

import { compareReports } from './compareBacktestReports.mjs';

// Compara na precisão em que o número foi registrado (W1 −0,0483 tem 4 casas;
// W2 +0,054 só 3): exigir 4 casas de um valor registrado com 3 pararia uma
// reprodução correta (review).
const decimalsOf = (x) => (String(x).split('.')[1] ?? '').length;
const matchesRecorded = (value, recorded) => Number.isFinite(value)
  && Math.abs(value - recorded) <= 0.5 * 10 ** -decimalsOf(recorded) + 1e-12;

function controlMetrics(report) {
  return { n: report?.costs?.countedTrades ?? null, expectancyR: report?.costs?.netExpectancyR ?? null };
}

const dayMs = (iso) => Date.parse(`${iso}T00:00:00Z`);
const symbolsOf = (report) => {
  const m = String(report?.trialArgs ?? '').match(/(?:^|\s)--symbols\s+(\S+)/);
  return m ? m[1].split(',').filter(Boolean).sort().join(',') : null;
};

/** O relatório é da janela e das moedas pré-registradas? */
function windowProblem(report, w) {
  if (report?.range?.fromMs !== dayMs(w.from) || report?.range?.toMs !== dayMs(w.to)) return `janela do relatório difere da pré-registrada (${w.from}→${w.to})`;
  if (symbolsOf(report) !== [...w.symbols].sort().join(',')) return 'moedas do relatório diferem das pré-registradas';
  return null;
}

/**
 * Etapa 1 (o workflow só roda os braços se passar): controles presentes,
 * válidos, da janela certa e reproduzindo o item 270.
 * @returns {{ status: 'OK'|'PARADO'|'FALHA_DE_EXECUCAO', reasons: string[], controls: object[] }}
 */
export function checkControls({ prereg, controls: byWindow }) {
  const controls = prereg.windows.map((w) => {
    const control = byWindow[w.label];
    const metrics = controlMetrics(control);
    const expected = prereg.controlReproduction?.[w.label] ?? null;
    let problem = null;
    let kind = null;
    if (!control) { problem = 'relatório do controle ausente'; kind = 'execucao'; }
    else if (control.dataIntegrity?.valid !== true) { problem = 'relatório do controle inválido (dataIntegrity)'; kind = 'execucao'; }
    else if (windowProblem(control, w)) { problem = windowProblem(control, w); kind = 'execucao'; }
    else if (expected && (metrics.n !== expected.ops || !matchesRecorded(metrics.expectancyR, expected.expectancyR))) {
      problem = `controle não reproduziu o item 270 (esperado ${expected.ops} ops / ${expected.expectancyR}R, veio ${metrics.n} ops / ${Number.isFinite(metrics.expectancyR) ? metrics.expectancyR.toFixed(4) : 'n/d'}R)`;
      kind = 'reproducao';
    }
    return { window: w.label, role: w.role, ...metrics, expected, problem, kind };
  });
  const reasons = controls.filter((c) => c.problem).map((c) => `${c.window}: ${c.problem}`);
  if (controls.some((c) => c.kind === 'reproducao')) return { status: 'PARADO', reasons, controls };
  if (controls.some((c) => c.kind === 'execucao')) return { status: 'FALHA_DE_EXECUCAO', reasons, controls };
  return { status: 'OK', reasons: [], controls };
}

/**
 * @param {{ prereg: any, reports: Record<string, { control?: any, arms: Record<string, any> }>,
 *   rand: () => number, iterations?: number }} p
 */
export function summarizeTargetsExperiment({ prereg, reports, rand, iterations = 5000 }) {
  const familySize = prereg.analysis.familySize;
  const windows = prereg.windows;
  const armLabels = prereg.arms.map((a) => a.label);

  // 1. Controles (mesma checagem da etapa que libera os braços no workflow).
  const check = checkControls({ prereg, controls: Object.fromEntries(windows.map((w) => [w.label, reports[w.label]?.control])) });
  const { controls } = check;
  if (check.status !== 'OK') return { status: check.status, reasons: check.reasons, controls, arms: null };

  // 2–3. Cada par controle × braço.
  const cellFor = (w, label) => {
    const control = reports[w.label]?.control;
    const arm = reports[w.label]?.arms?.[label];
    if (!arm) return { outcome: 'faltando' };
    if (arm.dataIntegrity?.valid !== true) return { outcome: 'invalido' };
    // O arquivo tem que conter o braço que o nome diz (review: um relatório
    // trocado passaria pela procedência genérica e iria para o braço errado).
    const spec = prereg.arms.find((a) => a.label === label);
    const cfg = arm.reproducibility?.pineConfig ?? {};
    if (cfg.targetMode !== spec.targetMode || cfg.targetNearPolicy !== spec.targetNearPolicy) {
      return { outcome: 'recusado', errors: [`relatório não é do braço ${label} (${cfg.targetMode}/${cfg.targetNearPolicy})`] };
    }
    const wp = windowProblem(arm, w);
    if (wp) return { outcome: 'recusado', errors: [wp] };
    const cmp = compareReports(control, arm, { familySize, targetArm: true, iterations, rand });
    if (!cmp.comparable) return { outcome: 'recusado', errors: cmp.errors };
    const u = cmp.unpaired;
    const t = arm.targets ?? {};
    const base = {
      deltaR: u.deltaR ?? null, ci: u.ci ?? null, verdict: u.verdict ?? 'nao_calculavel', gJoint: u.gJoint ?? null,
      nControl: u.control?.n ?? null, nArm: u.variant?.n ?? null,
      fallbackRate: t.fallbackRate ?? null, medianTp1R: t.medianTp1R ?? null, tp1Rate: t.tp1Rate ?? null,
    };
    if (!(t.ops > 0)) return { ...base, outcome: 'nao_calculavel' }; // sem operação do braço: não é fallback
    if (t.inconclusiveByFallback !== false) return { ...base, outcome: 'inconclusivo_fallback' };
    if (u.insufficientData || base.verdict === 'nao_calculavel') return { ...base, outcome: 'nao_calculavel' };
    if (base.verdict === 'inconclusivo_poucos_clusters') return { ...base, outcome: 'inconclusivo_clusters' };
    if (base.verdict === 'diferenca_significativa') return { ...base, outcome: base.deltaR > 0 ? 'melhor' : 'pior' };
    return { ...base, outcome: 'ruido' };
  };

  // 4. Veredito por braço.
  const decide = windows.filter((w) => w.role === 'decide');
  const replicate = windows.filter((w) => w.role === 'replicate');
  const unusable = new Set(['faltando', 'invalido', 'recusado', 'inconclusivo_fallback', 'inconclusivo_clusters', 'nao_calculavel']);
  // Na replicação vale só o sinal do ponto (pré-registro: "Δ > 0 em W0") —
  // poucos clusters, esperado com 4 moedas, não impede de ler o sinal.
  const repUnusable = new Set([...unusable].filter((o) => o !== 'inconclusivo_clusters'));
  const arms = armLabels.map((label) => {
    const cells = Object.fromEntries(windows.map((w) => [w.label, cellFor(w, label)]));
    const dec = decide.map((w) => cells[w.label]);
    const rep = replicate.map((w) => cells[w.label]);
    // W0 sem dado utilizável é INCONCLUSIVO, não "não replicou" (review).
    const repState = (sign) => {
      if (rep.length === 0 || rep.some((c) => repUnusable.has(c.outcome))) return 'sem_dado';
      return rep.every((c) => Math.sign(c.deltaR) === sign) ? 'replicou' : 'nao_replicou';
    };
    let verdict;
    if (dec.some((c) => unusable.has(c.outcome))) verdict = 'INCONCLUSIVO';
    else if (dec.every((c) => c.outcome === 'melhor')) verdict = { replicou: 'APROVADO', nao_replicou: 'NAO_REPLICOU', sem_dado: 'INCONCLUSIVO' }[repState(1)];
    else if (dec.every((c) => c.outcome === 'pior')) verdict = { replicou: 'PIOR', nao_replicou: 'PIOR_NAO_REPLICOU', sem_dado: 'INCONCLUSIVO' }[repState(-1)];
    else verdict = 'SEM_DIFERENCA';
    return { label, verdict, cells };
  });
  return { status: 'OK', reasons: [], controls, arms };
}

const f = (x, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : 'n/d');
const pct = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : 'n/d');

const VERDICT_TEXT = {
  APROVADO: '✅ aprovado pelo critério pré-registrado',
  PIOR: '❌ pior que o alvo de hoje',
  NAO_REPLICOU: 'melhor em W1 e W2, mas não replicou em W0 — não aprovado',
  PIOR_NAO_REPLICOU: 'pior em W1 e W2, sem replicar em W0',
  SEM_DIFERENCA: 'sem diferença (ruído)',
  INCONCLUSIVO: 'inconclusivo',
};

export function formatControlsMarkdown(check) {
  const lines = ['## Teste dos alvos (item 281) — controle', ''];
  if (check.status === 'PARADO') lines.push('### ⛔ PARADO: o controle não reproduziu o item 270 (regra do pré-registro). Os braços NÃO rodam.', '');
  else if (check.status === 'FALHA_DE_EXECUCAO') lines.push('### ⚠️ Falha de execução: relatório do controle ausente, inválido ou de outra janela. Os braços NÃO rodam — refazer o workflow.', '');
  else lines.push('### ✅ Controle reproduziu o item 270 — os braços podem rodar.', '');
  for (const c of check.controls) lines.push(`- ${c.window} (${c.role}): ${c.n ?? 'n/d'} ops, ${Number.isFinite(c.expectancyR) ? c.expectancyR.toFixed(4) : 'n/d'}R${c.problem ? ` — ${c.problem}` : ''}`);
  return lines.join('\n');
}

export function formatTargetsMarkdown(summary, prereg) {
  const lines = ['## Teste dos alvos (item 281)', ''];
  if (summary.status !== 'OK') {
    lines.push(summary.status === 'PARADO'
      ? '### ⛔ PARADO antes de ler qualquer braço (regra do pré-registro)'
      : '### ⚠️ Falha de execução no controle — refazer; nenhum braço lido', '');
    for (const r of summary.reasons) lines.push(`- ${r}`);
    return lines.join('\n');
  }
  lines.push('Controle (alvo de hoje):', '');
  for (const c of summary.controls) lines.push(`- ${c.window} (${c.role}): ${c.n} ops, expectância líquida ${f(c.expectancyR, 4)}R${c.expected ? ' — reproduziu o item 270' : ''}`);
  lines.push('', `Família de ${prereg.analysis.familySize} comparações (Bonferroni, alpha por comparação ${f(0.05 / prereg.analysis.familySize, 4)}). Leitura não pareada, controle × braço.`, '');
  lines.push('| Braço | Janela | Δ expectância (R) | IC | Veredito da janela | ops (controle → braço) | fallback | TP1 mediano (R) |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const a of summary.arms) {
    for (const [w, c] of Object.entries(a.cells)) {
      lines.push(`| ${a.label} | ${w} | ${f(c.deltaR)} | ${c.ci ? `[${f(c.ci[0])}; ${f(c.ci[1])}]` : 'n/d'} | ${c.outcome}${c.errors ? ` (${c.errors.join('; ')})` : ''} | ${c.nControl ?? 'n/d'} → ${c.nArm ?? 'n/d'} | ${pct(c.fallbackRate)} | ${f(c.medianTp1R, 2)} |`);
    }
  }
  lines.push('', '### Veredito por braço', '');
  for (const a of summary.arms) lines.push(`- **${a.label}**: ${VERDICT_TEXT[a.verdict]}`);
  return lines.join('\n');
}
