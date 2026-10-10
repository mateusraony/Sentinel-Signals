// docs/known-risks.md item 267 — pergunta secundária pré-registrada: as
// saídas por Fibonacci são melhores que as atuais? Compara DOIS resumos de
// scripts/random-baseline-summary.mjs da mesma janela e do mesmo commit — um
// com as saídas atuais, outro com a Fibonacci ligada — seed por seed: a mesma
// seed sorteia os mesmos sinais nos dois, então a diferença de cada par é só
// a mecânica de entrada/saída. Teste do sinal (exato, bicaudal) sobre os
// pares; o controle (RF) fica de fora, é uma comparação só, sem distribuição.

// P(X ≤ k) para X ~ Binomial(n, 1/2), somado com cuidado numérico.
function binomCdfHalf(k, n) {
  let term = 0.5 ** n; // C(n,0)/2^n
  let sum = term;
  for (let i = 1; i <= k; i += 1) {
    term = (term * (n - i + 1)) / i;
    sum += term;
  }
  return Math.min(1, sum);
}

/** p bicaudal exato do teste do sinal: `pos` diferenças positivas em `m` não nulas. */
export function signTestP(pos, m) {
  if (m === 0) return 1;
  const k = Math.min(pos, m - pos);
  return Math.min(1, 2 * binomCdfHalf(k, m));
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

function pairedOn(current, fib, field) {
  const bySeed = new Map(current.seeds.map((x) => [x.seed, x[field]]));
  const diffs = [];
  for (const x of fib.seeds) {
    const a = bySeed.get(x.seed);
    if (Number.isFinite(a) && Number.isFinite(x[field])) diffs.push(x[field] - a);
  }
  const nonZero = diffs.filter((d) => d !== 0);
  const pos = nonZero.filter((d) => d > 0).length;
  return {
    pairs: diffs.length,
    fibBetter: pos,
    fibWorse: nonZero.length - pos,
    ties: diffs.length - nonZero.length,
    medianDiff: median(diffs),
    meanDiff: diffs.length ? diffs.reduce((a, b) => a + b, 0) / diffs.length : null,
    p: signTestP(pos, nonZero.length),
  };
}

/**
 * @param {object} current resumo com as saídas atuais (fibEntry false)
 * @param {object} fib resumo com a Fibonacci ligada (fibEntry true)
 */
export function compareRandomBaselines(current, fib, { alpha = 0.05 } = {}) {
  const errors = [];
  if (!current?.comparable) errors.push('o resumo com as saídas atuais foi recusado — rode de novo antes de comparar');
  if (!fib?.comparable) errors.push('o resumo com a Fibonacci foi recusado — rode de novo antes de comparar');
  if (errors.length) return { comparable: false, errors };
  if (current.fibEntry === true) errors.push('o primeiro resumo deveria ser SEM a Fibonacci (fibEntry false)');
  if (fib.fibEntry !== true) errors.push('o segundo resumo deveria ser COM a Fibonacci (fibEntry true)');
  if (current.window?.from !== fib.window?.from || current.window?.to !== fib.window?.to) {
    errors.push(`janelas diferentes: ${current.window?.from}→${current.window?.to} × ${fib.window?.from}→${fib.window?.to}`);
  }
  if (!current.commitSha || current.commitSha !== fib.commitSha) {
    errors.push(`commits diferentes ou ausentes (${current.commitSha ?? '?'} × ${fib.commitSha ?? '?'}) — rode os dois no mesmo commit`);
  }
  // As mesmas seeds só sorteiam os mesmos sinais com as mesmas entradas da
  // rodada (review do Codex, PR #486). Campo ausente = resumo antigo, recusa.
  const same = (a, b) => a != null && b != null && JSON.stringify(a) === JSON.stringify(b);
  const symbolsOf = (x) => (Array.isArray(x.symbols) ? [...x.symbols].sort() : null);
  if (!same(symbolsOf(current), symbolsOf(fib))) errors.push(`moedas diferentes ou ausentes: ${current.symbols ?? '?'} × ${fib.symbols ?? '?'}`);
  if (!same(current.randomEntryProb, fib.randomEntryProb)) errors.push(`probabilidade de sorteio diferente ou ausente: ${current.randomEntryProb ?? '?'} × ${fib.randomEntryProb ?? '?'}`);
  if (!same(current.costModel, fib.costModel)) errors.push('modelo de custo diferente ou ausente nos dois resumos');
  const seedsA = current.seeds.map((x) => x.seed).sort((a, b) => a - b).join(',');
  const seedsB = fib.seeds.map((x) => x.seed).sort((a, b) => a - b).join(',');
  if (seedsA !== seedsB) errors.push('os dois resumos não têm as mesmas seeds');
  if (errors.length) return { comparable: false, errors };

  const net = pairedOn(current, fib, 'expectancyR');
  const gross = pairedOn(current, fib, 'grossExpectancyR');
  let verdict = 'sem_diferenca';
  if (net.p < alpha) verdict = net.fibBetter > net.fibWorse ? 'fib_melhor' : 'fib_pior';
  return {
    comparable: true,
    errors: [],
    alpha,
    window: current.window,
    commitSha: current.commitSha,
    net,
    gross,
    trades: {
      currentMedian: median(current.seeds.map((x) => x.n).filter(Number.isFinite)),
      fibMedian: median(fib.seeds.map((x) => x.n).filter(Number.isFinite)),
    },
    verdict,
  };
}

const VERDICT_TEXT = {
  fib_melhor: '**as saídas por Fibonacci foram melhores** que as atuais com as MESMAS entradas sorteadas',
  fib_pior: '**as saídas por Fibonacci foram PIORES** que as atuais com as MESMAS entradas sorteadas',
  sem_diferenca: 'sem diferença detectável entre as saídas por Fibonacci e as atuais',
};

export function formatComparisonMarkdown(r) {
  const f = (v, d = 4) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
  const lines = ['', '## Saídas por Fibonacci × saídas atuais (mesmas seeds)', ''];
  if (!r.comparable) {
    lines.push('**Comparação recusada:**', '', ...r.errors.map((e) => `- ${e}`), '');
    return lines.join('\n');
  }
  lines.push(
    `Janela ${r.window?.from ?? '?'} → ${r.window?.to ?? '?'} · commit ${String(r.commitSha).slice(0, 7)} · teste do sinal bicaudal, limiar ${r.alpha}`,
    '',
    '| | Pares | Fib melhor | Fib pior | Empates | Diferença mediana (R) | Diferença média (R) | p |',
    '|---|---|---|---|---|---|---|---|',
    `| Líquido (com custo) | ${r.net.pairs} | ${r.net.fibBetter} | ${r.net.fibWorse} | ${r.net.ties} | ${f(r.net.medianDiff)} | ${f(r.net.meanDiff)} | ${f(r.net.p)} |`,
    `| Bruto (sem custo) | ${r.gross.pairs} | ${r.gross.fibBetter} | ${r.gross.fibWorse} | ${r.gross.ties} | ${f(r.gross.medianDiff)} | ${f(r.gross.meanDiff)} | ${f(r.gross.p)} |`,
    '',
    `Operações por seed (mediana): saídas atuais ${r.trades.currentMedian ?? '—'} · Fibonacci ${r.trades.fibMedian ?? '—'}`,
    `Veredito (líquido): ${VERDICT_TEXT[r.verdict]}`,
    '',
  );
  return lines.join('\n');
}
