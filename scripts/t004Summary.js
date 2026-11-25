// T-2026-004 (docs/experiments/pine-vs-producao-prereg.json): resumo das 4 rodadas (2 janelas x 2 braços) e aplicação da REGRA DE DECISÃO congelada no pré-registro.
// Funções PURAS (sem rede, sem disco): quem lê os relatórios é `scripts/t004-summary.mjs`. Nada aqui escreve em banco nem envia ordem.
//
// Métrica primária (pré-registrada): diferença de expectância líquida em R por operação, braço A (modo Pine) menos braço B (produção), por janela, com erro-padrão
// robusto por CLUSTER (mês de entrada). A variância da diferença soma as dos dois braços (ignora a covariância entre eles: CONSERVADOR, o intervalo sai um pouco mais largo).
// Secundária: pares com a MESMA entrada nos dois braços (moeda + vela de entrada + lado).
const Z95 = 1.96;

/** Operações com R calculável de um relatório do backtest. @returns {Array<{ key: string, month: string, r: number }>} */
export function opsFromReport(report) {
  const curve = report?.overall?.curve ?? [];
  return curve
    .filter((c) => Number.isFinite(c?.r))
    .map((c) => ({ key: `${c.op.symbol}|${String(c.op.candle_open_time).slice(0, 16)}|${c.op.side}`, month: String(c.op.candle_open_time).slice(0, 7), r: c.r }));
}

/** Média de R e erro-padrão robusto por cluster (CR0): var(média) = soma por mês de (soma dos desvios)^2 / n^2. */
export function clusterMean(ops) {
  const n = ops.length;
  if (n === 0) return { n: 0, mean: NaN, se: NaN, clusters: 0 };
  const mean = ops.reduce((s, o) => s + o.r, 0) / n;
  const byMonth = new Map();
  for (const o of ops) byMonth.set(o.month, (byMonth.get(o.month) ?? 0) + (o.r - mean));
  const ss = [...byMonth.values()].reduce((s, v) => s + v * v, 0);
  return { n, mean, se: Math.sqrt(ss) / n, clusters: byMonth.size };
}

/** A - B, com IC95 (normal) a partir dos erros-padrão por cluster de cada braço. */
export function diffArms(opsA, opsB) {
  const a = clusterMean(opsA);
  const b = clusterMean(opsB);
  const diff = a.mean - b.mean;
  const se = Math.sqrt(a.se ** 2 + b.se ** 2);
  return { a, b, diff, se, ci95: [diff - Z95 * se, diff + Z95 * se] };
}

/** Pares com a mesma entrada nos dois braços: média de (R_A - R_B). */
export function pairedDiff(opsA, opsB) {
  const mapB = new Map(opsB.map((o) => [o.key, o.r]));
  const d = opsA.filter((o) => mapB.has(o.key)).map((o) => o.r - mapB.get(o.key));
  return { pairs: d.length, mean: d.length ? d.reduce((s, v) => s + v, 0) / d.length : NaN };
}

/**
 * Regra do pré-registro:
 *  - 'adotar_modo_pine'   : A - B > minEffect nas DUAS janelas E o IC95 da diferença exclui zero (limite inferior > 0) em ambas;
 *  - 'manter_producao'    : A - B <= 0 em QUALQUER janela;
 *  - 'inconclusivo'       : qualquer outro caso (a escolha passa a ser de PRODUTO, do usuário).
 * @param {Array<{ label: string, diff: number, ci95: [number, number] }>} windows
 */
export function decide(windows, minEffect = 0.05) {
  if (windows.length === 0 || windows.some((w) => !Number.isFinite(w.diff))) return 'inconclusivo';
  if (windows.some((w) => w.diff <= 0)) return 'manter_producao';
  if (windows.every((w) => w.diff > minEffect && w.ci95[0] > 0)) return 'adotar_modo_pine';
  return 'inconclusivo';
}

const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const sgn = (v, d = 3) => (Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}` : '—');

const VERDICT_TEXT = {
  adotar_modo_pine: 'ADOTAR O MODO PINE é o que a regra pré-registrada recomenda (A−B > +0,05 R/op nas duas janelas e o IC95 exclui zero em ambas). A mudança continua sendo SUA decisão.',
  manter_producao: 'MANTER A PRODUÇÃO é o que a regra pré-registrada recomenda (A−B ≤ 0 em pelo menos uma janela).',
  inconclusivo: 'INCONCLUSIVO pela regra pré-registrada: a estatística não decidiu. A escolha passa a ser de PRODUTO (fidelidade ao que você vê no TradingView × controle de risco do item 132), e é sua.',
};

/**
 * @param {Record<string, { A: any, B: any }>} reports por janela (W1, W2): relatórios do backtest de cada braço
 * @returns {{ windows: any[], verdict: string, markdown: string }}
 */
export function summarize(reports, minEffect = 0.05) {
  const windows = Object.entries(reports).map(([label, { A, B }]) => {
    const opsA = opsFromReport(A);
    const opsB = opsFromReport(B);
    const d = diffArms(opsA, opsB);
    const p = pairedDiff(opsA, opsB);
    return { label, ...d, paired: p };
  });
  const verdict = decide(windows, minEffect);
  const lines = ['## T-2026-004 — modo Pine (A) × produção (B), 7 ativos', ''];
  lines.push('| Janela | N (A) | R/op (A) | N (B) | R/op (B) | **A − B** | IC95 da diferença (por mês) | Pares iguais | Δ R nos pares |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const w of windows) {
    lines.push(`| ${w.label} | ${w.a.n} | ${sgn(w.a.mean)} | ${w.b.n} | ${sgn(w.b.mean)} | **${sgn(w.diff)}** | [${sgn(w.ci95[0])}; ${sgn(w.ci95[1])}] | ${w.paired.pairs} | ${sgn(w.paired.mean)} |`);
  }
  lines.push('', `**Veredito pela regra pré-registrada:** ${VERDICT_TEXT[verdict]}`, '');
  lines.push('Como ler: R/op é a expectância líquida por operação (custos já descontados). O IC leva em conta que operações do mesmo mês não são independentes (cluster por mês de entrada) e é conservador. "Pares iguais" são entradas idênticas nos dois braços (moeda + vela + lado).');
  return { windows, verdict, markdown: lines.join('\n') };
}

/**
 * Lê o pré-registro e devolve o que UMA rodada precisa (moedas, datas, timeframes e as chaves do braço). Fonte única: o arquivo do pré-registro.
 * @param {any} prereg conteúdo de docs/experiments/pine-vs-producao-prereg.json
 * @param {string} janela 'W1' | 'W2'
 * @param {string} braco 'A_modo_pine' | 'B_producao'
 */
export function prepareArm(prereg, janela, braco) {
  const w = (prereg.windows || []).find((x) => x.label === janela);
  if (!w) throw new Error(`janela desconhecida no pré-registro: ${janela}`);
  const arm = prereg.arms?.[braco];
  if (!arm?.pine_config) throw new Error(`braço desconhecido no pré-registro: ${braco}`);
  return { symbols: (prereg.symbols || []).join(','), from: w.from, to: w.to, timeframes: prereg.timeframes, pineConfig: arm.pine_config };
}
