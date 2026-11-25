// T-2026-006 (docs/experiments/t006-trailing-prereg.json): isola SÓ a proteção do stop antes do TP1 (o trailing de produção). Funções PURAS (sem rede, sem disco);
// quem lê os relatórios é `scripts/t006-summary.mjs`. Reaproveita a conta e a regra de decisão do T-2026-004 (`t004Summary.js`).
//
// Quatro braços por janela:  B_producao (contexto produção, proteção LIGADA) e B_sem_protecao (o mesmo, DESLIGADA);
//                            A_com_protecao (contexto modo Pine, proteção LIGADA) e A_modo_pine (o mesmo, DESLIGADA).
// PRIMÁRIO = B_sem_protecao − B_producao (é exatamente a mudança de uma chave na produção). ESPELHO = A_modo_pine − A_com_protecao.
import { opsFromReport, clusterMean, diffArms, pairedDiff, decide } from './t004Summary.js';

const sd = (ops) => {
  const n = ops.length;
  if (n < 2) return NaN;
  const m = ops.reduce((s, o) => s + o.r, 0) / n;
  return Math.sqrt(ops.reduce((s, o) => s + (o.r - m) ** 2, 0) / (n - 1));
};

/** Reprodução do T-2026-004: os braços A_modo_pine e B_producao devem dar exatamente o mesmo N e (arredondado) o mesmo R/op. */
export function checkReproduction(window, opsByArm, expected) {
  const out = [];
  for (const [arm, exp] of Object.entries(expected?.[window] ?? {})) {
    const c = clusterMean(opsByArm[arm] ?? []);
    out.push({ janela: window, braco: arm, esperado: exp, n: c.n, expectancia: c.mean, ok: c.n === exp.n && Math.abs(c.mean - exp.expectancia_R) < 0.001 });
  }
  return out;
}

const VEREDITO = {
  adotar_modo_pine: 'desligar_a_protecao',
  manter_producao: 'manter_a_protecao',
  inconclusivo: 'inconclusivo',
};

const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const sgn = (v, d = 3) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}` : '—');

const TEXTO = {
  desligar_a_protecao: 'DESLIGAR A PROTEÇÃO ANTES DO TP1 é o que a regra pré-registrada recomenda (PRIMÁRIO > +0,05 R/op nas duas janelas e o IC95 exclui zero em ambas). Mudar é decisão SUA.',
  manter_a_protecao: 'MANTER A PROTEÇÃO (o trailing) é o que a regra pré-registrada recomenda (PRIMÁRIO ≤ 0 em pelo menos uma janela).',
  inconclusivo: 'INCONCLUSIVO pela regra pré-registrada: a estatística não decidiu. A escolha passa a ser de PRODUTO (fidelidade ao TradingView × menos oscilação do item 132), e é sua.',
};

/**
 * @param {Record<string, Record<string, any>>} reports por janela: { W1: { B_producao, B_sem_protecao, A_modo_pine, A_com_protecao }, W2: {...} } (relatórios do backtest)
 * @param {any} [expected] prereg.reproducao_esperada_do_t004 (sem ele, não confere a reprodução)
 */
export function summarizeT006(reports, expected) {
  const windows = [];
  const repro = [];
  for (const [label, arms] of Object.entries(reports)) {
    const ops = Object.fromEntries(Object.entries(arms).map(([k, r]) => [k, opsFromReport(r)]));
    const primario = diffArms(ops.B_sem_protecao ?? [], ops.B_producao ?? []);
    const espelho = diffArms(ops.A_modo_pine ?? [], ops.A_com_protecao ?? []);
    windows.push({
      label, primario, espelho,
      pares: pairedDiff(ops.B_sem_protecao ?? [], ops.B_producao ?? []),
      sd: { B_producao: sd(ops.B_producao ?? []), B_sem_protecao: sd(ops.B_sem_protecao ?? []), A_com_protecao: sd(ops.A_com_protecao ?? []), A_modo_pine: sd(ops.A_modo_pine ?? []) },
    });
    if (expected) repro.push(...checkReproduction(label, ops, expected));
  }
  const verdict = VEREDITO[decide(windows.map((w) => ({ label: w.label, diff: w.primario.diff, ci95: w.primario.ci95 })))];
  const L = ['## T-2026-006 — só o trailing (proteção do stop antes do TP1), 7 ativos', ''];
  L.push('**PRIMÁRIO (a mudança de uma chave na produção): proteção DESLIGADA − LIGADA, no contexto da produção**', '');
  L.push('| Janela | N desl. | R/op desl. | N lig. | R/op lig. | **desl. − lig.** | IC95 (por mês) | Pares iguais | Oscilação de R (desl. × lig.) |', '|---|---|---|---|---|---|---|---|---|');
  for (const w of windows) L.push(`| ${w.label} | ${w.primario.a.n} | ${sgn(w.primario.a.mean)} | ${w.primario.b.n} | ${sgn(w.primario.b.mean)} | **${sgn(w.primario.diff)}** | [${sgn(w.primario.ci95[0])}; ${sgn(w.primario.ci95[1])}] | ${w.pares.pairs} | ${f(w.sd.B_sem_protecao, 2)} × ${f(w.sd.B_producao, 2)} |`);
  L.push('', '**ESPELHO (o mesmo, no contexto do modo Pine): desligada − ligada**', '');
  L.push('| Janela | N desl. | R/op desl. | N lig. | R/op lig. | **desl. − lig.** | IC95 (por mês) | Oscilação de R (desl. × lig.) |', '|---|---|---|---|---|---|---|---|');
  for (const w of windows) L.push(`| ${w.label} | ${w.espelho.a.n} | ${sgn(w.espelho.a.mean)} | ${w.espelho.b.n} | ${sgn(w.espelho.b.mean)} | **${sgn(w.espelho.diff)}** | [${sgn(w.espelho.ci95[0])}; ${sgn(w.espelho.ci95[1])}] | ${f(w.sd.A_modo_pine, 2)} × ${f(w.sd.A_com_protecao, 2)} |`);
  L.push('', `**Veredito pela regra pré-registrada (usa só o PRIMÁRIO):** ${TEXTO[verdict]}`, '');
  if (repro.length) {
    const ok = repro.every((r) => r.ok);
    L.push(`**Reprodução do T-2026-004** (os braços A_modo_pine e B_producao são os mesmos): ${ok ? 'REPRODUZIU exatamente (mesmo N e mesmo R/op) — o motor e os dados não mudaram.' : 'NÃO reproduziu: ' + repro.filter((r) => !r.ok).map((r) => `${r.janela}/${r.braco} (esperado N=${r.esperado.n}, R/op=${r.esperado.expectancia_R}; veio N=${r.n}, R/op=${f(r.expectancia)})`).join('; ') + '. Algo mudou no motor ou nos dados: leia o resultado com cuidado.'}`, '');
  }
  L.push('Como ler: R/op é a expectância líquida por operação (custos já descontados). O IC leva em conta que operações do mesmo mês não são independentes (cluster por mês de entrada) e é conservador. "Oscilação" é o desvio-padrão de R por operação (o risco que o item 132 dizia que o trailing reduz).');
  return { windows, verdict, reproduction: repro, markdown: L.join('\n') };
}
