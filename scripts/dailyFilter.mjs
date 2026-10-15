// Teste pré-registrado do filtro de tendência diária sobre as entradas do
// Sentinel — docs/known-risks.md item 273 (Etapa 2 dos itens 271/272). Parte
// pura (sem rede, sem Date.now); a CLI é scripts/daily-filter.mjs.
//
// Pergunta: uma operação de 4h a favor da regra diária dos itens 271/272
// (EMA10 > EMA21 e Supertrend(10,3) de alta = "comprado") rende mais R que a
// média? Sobre os MESMOS relatórios do workflow de entradas aleatórias (R0 +
// 40 seeds, item 264), sem rodar nada novo no motor.
//
// Alinhada: BUY com a regra comprada, ou SELL com a regra fora. A regra vem da
// última vela diária FECHADA até o horário da entrada (sem olhar a vela em
// formação). Sem regra conhecida (moeda listada há pouco), a operação passa: o
// filtro não age nela.
//
// Estatística (mesma família do item 269): peso w = 1 se passa no filtro, 0 se
// não, normalizado para média 1 DENTRO de cada braço e lado (BUY/SELL).
//   T = média(w̃·R) − média(R) = Σ_lado (n_lado/n)·[R̄(lado, passa) − R̄(lado)]
// Normalizar por lado tira o efeito da mistura: se o mercado da janela subiu,
// todo BUY rende mais que todo SELL, e um filtro que só mudasse a proporção de
// BUY e SELL pareceria informativo sem ser. Sob a hipótese nula (a regra
// diária não diz nada sobre o R do lado) E[T] = 0.
//
// Inferência: t de Student unicaudal sobre as somas MENSAIS (clusterT do item
// 269, reaproveitado) — as seeds atravessam o mesmo caminho de preço; a unidade
// independente é o tempo, não a operação nem a seed.
import { getOpenedAt } from '../src/lib/tradeMetrics.js';
import { distribution, summarizeRandomBaseline } from './randomBaselineSummary.mjs';
import { parseSymbolsFromTrialArgs } from './compareBacktestReports.mjs';
import { clusterT } from './volSizing.mjs';
import { buildDays, dailySignals } from './dailyTrend.mjs';

const DAY = 24 * 60 * 60 * 1000;
const toMs = (v) => (v == null ? NaN : typeof v === 'number' ? v : new Date(v).getTime());
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Regra diária conhecida em cada instante. Devolve `at(tMs)`:
 *   { state: 1 | 0 | null, reason }  (1 = comprado, 0 = fora, null = sem regra)
 * A vela usada é a última com closeTime ≤ tMs (a entrada de 4h que fecha junto
 * com a vela diária já a vê fechada). `gapDays` = início de cada dia faltando
 * entre a 1ª e a última vela (buraco muda EMA/ATR — o chamador decide recusar).
 */
export function regimeLookup(candles1d, rule) {
  const days = buildDays(candles1d, { endMs: Number.MAX_SAFE_INTEGER });
  const signals = dailySignals(days, rule);
  const gapDays = [];
  for (let i = 1; i < days.length; i += 1) {
    for (let t = days[i - 1].openTime + DAY; t < days[i].openTime; t += DAY) gapDays.push(t);
  }
  const at = (tMs) => {
    let lo = 0; let hi = days.length - 1; let idx = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (days[mid].closeTime <= tMs) { idx = mid; lo = mid + 1; } else hi = mid - 1;
    }
    if (idx < 0) return { state: null, reason: 'sem vela diária antes da entrada' };
    if (days[idx].closeTime < tMs - DAY) return { state: null, reason: 'vela diária velha (buraco)' };
    // Mesmo corte do item 271 (`symbolDailySeries`): o dia de índice
    // `warmupDays` já opera com o sinal do fechamento da vela anterior
    // (review do Codex, PR #497 — antes ficava um dia atrasado).
    if (idx < rule.warmupDays - 1 || signals[idx] === null) return { state: null, reason: 'aquecimento' };
    return { state: signals[idx], reason: null };
  };
  return { at, gapDays, firstOpen: days[0]?.openTime ?? null };
}

/** Operações fechadas de um relatório (overall.curve), com o lado. */
export function sidedOpsFromReport(report) {
  return (report?.overall?.curve || [])
    .filter((c) => c?.op && Number.isFinite(c.r))
    .map((c) => ({ symbol: c.op.symbol, side: c.op.side, openedMs: toMs(getOpenedAt(c.op)), r: c.r }));
}

const passes = (side, state) => (state === null ? true : side === 'BUY' ? state === 1 : state === 0);

/**
 * Contribuição de cada operação para o T do braço (normalizado por lado). Lado
 * em que o filtro tira TODAS as operações (ou com menos de 2) não contribui:
 * não há "passa" para comparar. A soma é exatamente o T do braço.
 */
export function armContributions(ops) {
  const n = ops.length;
  const out = [];
  for (const side of ['BUY', 'SELL']) {
    const g = ops.filter((o) => o.side === side);
    const kept = g.filter((o) => o.pass);
    if (g.length < 2 || !kept.length) continue;
    const mw = kept.length / g.length;
    const mr = mean(g.map((o) => o.r));
    for (const o of g) out.push({ month: new Date(o.openedMs).toISOString().slice(0, 7), c: (((o.pass ? 1 : 0) / mw - 1) * (o.r - mr)) / n });
  }
  return out;
}

function sideSplit(ops) {
  const cell = (side, state) => {
    const xs = ops.filter((o) => o.side === side && o.state === state).map((o) => o.r);
    return { n: xs.length, meanR: mean(xs) };
  };
  return {
    buyWithRule: cell('BUY', 1), buyAgainstRule: cell('BUY', 0),
    sellWithRule: cell('SELL', 0), sellAgainstRule: cell('SELL', 1),
    unknown: ops.filter((o) => o.state === null).length,
  };
}

/**
 * Uma janela: R0 + seeds, velas diárias, pré-registro.
 * @param {{ control: object, randoms: object[], candlesBySymbol: Record<string, object[]>, prereg: object }} input
 */
export function runDailyFilterWindow({ control, randoms, candlesBySymbol, prereg }) {
  const errors = [];
  const fromIso = control?.range?.from ?? null;
  const toIso = control?.range?.to ?? null;
  const window = prereg.windows.find((w) => fromIso?.slice(0, 10) === w.from && toIso?.slice(0, 10) === w.to);
  if (!window) errors.push(`janela ${fromIso?.slice(0, 10)} → ${toIso?.slice(0, 10)} não é nenhuma das pré-registradas (${prereg.windows.map((w) => `${w.label} ${w.from} → ${w.to}`).join('; ')})`);

  // Mesma validação dos itens 264/269: braços comparáveis, seeds 1..N completas.
  const base = summarizeRandomBaseline(control, randoms, { expectedSeeds: prereg.nSeeds, alpha: prereg.alpha });
  if (!base.comparable) errors.push(...base.errors);
  const symbols = parseSymbolsFromTrialArgs(control?.trialArgs) || [];
  if (JSON.stringify(symbols) !== JSON.stringify([...prereg.symbols].sort())) errors.push(`moedas ${symbols.join(',')} diferentes das pré-registradas`);
  const prob = randoms[0]?.reproducibility?.pineConfig?.randomEntryProb;
  if (prob !== prereg.randomProb) errors.push(`randomEntryProb ${prob} diferente do pré-registrado (${prereg.randomProb})`);
  if (control?.reproducibility?.pineConfig?.fibEntryEnabled === true) errors.push('Fibonacci 15m ligada — este teste é sobre a estratégia atual');
  if (errors.length) return { verdict: 'INCOMPLETE', errors: [...new Set(errors)].slice(0, 20), window: window?.label ?? null };

  const fromMs = Date.parse(`${window.from}T00:00:00Z`);
  const toMsWin = Date.parse(`${window.to}T00:00:00Z`);
  const lookups = {};
  for (const s of prereg.symbols) {
    if (!candlesBySymbol[s]?.length) continue;
    lookups[s] = regimeLookup(candlesBySymbol[s], prereg.rule);
  }

  const arms = [{ arm: 'R0', report: control }, ...randoms.map((r) => ({ arm: String(r.reproducibility?.pineConfig?.randomEntrySeed), report: r }))]
    .map(({ arm, report }) => {
      const ops = sidedOpsFromReport(report).map((o) => {
        const lk = lookups[o.symbol];
        if (!lk) { errors.push(`braço ${arm}: operação em ${o.symbol} sem velas diárias`); return null; }
        if (o.side !== 'BUY' && o.side !== 'SELL') { errors.push(`braço ${arm}: operação de ${o.symbol} sem lado BUY/SELL`); return null; }
        // A 1ª passada da janela (00:00) decide com a vela que fechou 1 ms
        // antes — essa operação pertence à janela (achado do item 269).
        if (!(o.openedMs >= fromMs - 1 && o.openedMs < toMsWin)) { errors.push(`braço ${arm}: operação de ${o.symbol} aberta fora da janela`); return null; }
        const { state, reason } = lk.at(o.openedMs);
        if (reason === 'vela diária velha (buraco)' || reason === 'sem vela diária antes da entrada') errors.push(`braço ${arm}: ${o.symbol} ${reason}`);
        return { ...o, state, pass: passes(o.side, state) };
      }).filter(Boolean);
      return { arm, ops };
    });
  // Buraco que ainda pesa na regra: do aquecimento (2× o pré-registrado) antes
  // da janela até o fim dela. Um buraco anos antes não muda mais EMA/ATR.
  const gapFromMs = fromMs - 2 * prereg.rule.warmupDays * DAY;
  for (const s of prereg.symbols) {
    const gaps = (lookups[s]?.gapDays || []).filter((t) => t >= gapFromMs && t < toMsWin);
    if (gaps.length && arms.some((a) => a.ops.some((o) => o.symbol === s))) errors.push(`${s}: ${gaps.length} dia(s) faltando nas velas diárias (1º em ${new Date(gaps[0]).toISOString().slice(0, 10)})`);
  }
  if (errors.length) return { verdict: 'INCOMPLETE', errors: [...new Set(errors)].slice(0, 20), window: window.label };

  // T da janela = média dos T dos braços; cada contribuição entra dividida
  // pelo número de braços com operação.
  const withOps = arms.filter((a) => a.ops.length);
  const byMonth = new Map();
  for (const a of withOps) {
    for (const { month, c } of armContributions(a.ops)) byMonth.set(month, (byMonth.get(month) ?? 0) + c / withOps.length);
  }
  const clusterSums = [...byMonth.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([month, sum]) => ({ month, sum }));
  const inference = clusterT(clusterSums.map((x) => x.sum), prereg.alpha);

  const perArm = arms.map((a) => {
    const kept = a.ops.filter((o) => o.pass);
    return {
      arm: a.arm,
      n: a.ops.length,
      kept: kept.length,
      T: a.ops.length ? armContributions(a.ops).reduce((acc, x) => acc + x.c, 0) : null,
      meanR: mean(a.ops.map((o) => o.r)),
      meanRKept: mean(kept.map((o) => o.r)),
      sumR: a.ops.reduce((acc, o) => acc + o.r, 0),
      sumRKept: kept.reduce((acc, o) => acc + o.r, 0),
    };
  });
  const seedOps = arms.slice(1).flatMap((a) => a.ops);
  const r0 = perArm[0];

  return {
    verdict: 'WINDOW_DONE',
    errors: [],
    warnings: base.warnings,
    window: window.label,
    reportCommitSha: control?.reproducibility?.commitSha ?? null,
    from: window.from,
    to: window.to,
    arms: arms.length,
    observed: inference.total,
    observedR0: r0.T,
    clusterSums,
    windowT: inference,
    descriptive: {
      armsWithPositiveT: perArm.filter((a) => a.T > 0).length,
      keptShare: distribution(perArm.filter((a) => a.n).map((a) => a.kept / a.n)),
      // O que o filtro faria de verdade (inclui a mudança na mistura BUY/SELL,
      // que o T de propósito não mede): R médio e soma de R com e sem filtro.
      seeds: {
        meanR: distribution(perArm.slice(1).map((a) => a.meanR).filter(Number.isFinite)),
        meanRKept: distribution(perArm.slice(1).map((a) => a.meanRKept).filter(Number.isFinite)),
        sumR: distribution(perArm.slice(1).map((a) => a.sumR)),
        sumRKept: distribution(perArm.slice(1).map((a) => a.sumRKept)),
        bySide: sideSplit(seedOps),
      },
      r0: { n: r0.n, kept: r0.kept, T: r0.T, meanR: r0.meanR, meanRKept: r0.meanRKept, sumR: r0.sumR, sumRKept: r0.sumRKept, bySide: sideSplit(arms[0].ops) },
      perSymbol: prereg.symbols.map((s) => {
        const os = seedOps.filter((o) => o.symbol === s);
        const kept = os.filter((o) => o.pass);
        return { symbol: s, n: os.length, kept: kept.length, meanR: mean(os.map((o) => o.r)), meanRKept: mean(kept.map((o) => o.r)) };
      }).filter((x) => x.n),
    },
  };
}

/**
 * Veredito final: junta as duas janelas pré-registradas (mesmas checagens do
 * item 269: as duas janelas, o pré-registro ATUAL e o mesmo commit).
 */
export function combineWindows(summaries, prereg, { preregSha256 } = {}) {
  const errors = [];
  const labels = summaries.map((s) => s?.window);
  for (const w of prereg.windows) if (!labels.includes(w.label)) errors.push(`falta a janela ${w.label}`);
  if (summaries.length !== prereg.windows.length || new Set(labels).size !== labels.length) errors.push('são precisas exatamente as duas janelas, uma de cada');
  for (const s of summaries) if (s?.verdict !== 'WINDOW_DONE') errors.push(`janela ${s?.window ?? '?'}: ${s?.verdict ?? 'sem resumo'} — ${(s?.errors || []).join('; ')}`);
  if (!preregSha256) errors.push('falta o hash do pré-registro atual para conferir as janelas');
  else if (summaries.some((s) => s?.preregSha256 !== preregSha256)) errors.push('alguma janela foi calculada com um pré-registro diferente do atual');
  const commits = new Set(summaries.map((s) => s?.reportCommitSha ?? null));
  if (commits.size !== 1 || commits.has(null)) errors.push('as duas janelas não rodaram no mesmo commit');
  if (errors.length) return { verdict: 'INCOMPLETE', errors };

  const [a, b] = prereg.windows.map((w) => summaries.find((s) => s.window === w.label));
  // T final = média das duas janelas; cada mês entra com metade da soma.
  const inference = clusterT([...a.clusterSums, ...b.clusterSums].map((x) => x.sum / 2), prereg.alpha);
  const observed = inference.total;
  const checks = {
    significance: inference.pass,
    effect: observed >= prereg.minEffectR,
    eachWindow: a.observed > 0 && b.observed > 0,
  };
  // Diferença do item 269: o R0 NÃO decide (pré-registro, `r0Role`). É 1 de 41
  // braços (~115 operações por janela); na calibração, exigir T do R0 > 0 nas
  // duas janelas derrubou o poder de 60% para 39% sem mudar o alarme falso
  // (0/200 nos dois casos). Fica no relatório.
  const descriptiveChecks = { r0EachWindow: a.observedR0 > 0 && b.observedR0 > 0 };
  return {
    verdict: Object.values(checks).every(Boolean) ? 'FILTER_EDGE' : 'NO_FILTER_EDGE',
    errors: [],
    observed,
    inference,
    checks,
    descriptiveChecks,
    windows: [a, b].map((s) => ({
      window: s.window,
      observed: s.observed,
      observedR0: s.observedR0,
      t: s.windowT.t,
      months: s.windowT.clusters,
      keptShare: s.descriptive.keptShare.p50,
      seedsMeanR: s.descriptive.seeds.meanR.p50,
      seedsMeanRKept: s.descriptive.seeds.meanRKept.p50,
    })),
  };
}

const f = (v, d = 4) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(0)}%`);

export function formatWindowMarkdown(s) {
  const lines = ['', `## Filtro de tendência diária — janela ${s.window ?? '?'}`, ''];
  if (s.verdict === 'INCOMPLETE') {
    lines.push('**Resultado inválido — faltou dado ou a rodada não bate com o pré-registro.** Não conta como resposta.', '', ...s.errors.map((e) => `- ${e}`), '');
    return lines.join('\n');
  }
  const d = s.descriptive;
  const cell = (c) => `${c.n} op · ${f(c.meanR, 3)} R`;
  lines.push(
    `Janela ${s.from} → ${s.to}, ${s.arms} braços (R0 + seeds).`,
    '',
    '| | Valor |',
    '|---|---|',
    `| T = R a favor da regra − R de todas, por lado (média dos braços) | ${f(s.observed)} R |`,
    `| T só do R0 (entrada da RF) | ${f(s.observedR0)} R |`,
    `| t desta janela (${s.windowT.clusters} meses; só informativo) | ${f(s.windowT.t, 2)} |`,
    `| Braços com T > 0 | ${d.armsWithPositiveT} de ${s.arms} |`,
    `| Operações que o filtro manteria (mediana dos braços) | ${pct(d.keptShare.p50)} |`,
    `| Seeds: R médio sem filtro × com filtro (medianas) | ${f(d.seeds.meanR.p50, 3)} × ${f(d.seeds.meanRKept.p50, 3)} R |`,
    `| Seeds: soma de R sem filtro × com filtro (medianas) | ${f(d.seeds.sumR.p50, 1)} × ${f(d.seeds.sumRKept.p50, 1)} R |`,
    `| R0: R médio sem × com filtro (${d.r0.n} → ${d.r0.kept} op) | ${f(d.r0.meanR, 3)} × ${f(d.r0.meanRKept, 3)} R |`,
    '',
    `Seeds por lado: BUY a favor ${cell(d.seeds.bySide.buyWithRule)}, contra ${cell(d.seeds.bySide.buyAgainstRule)} · SELL a favor ${cell(d.seeds.bySide.sellWithRule)}, contra ${cell(d.seeds.bySide.sellAgainstRule)} · sem regra ${d.seeds.bySide.unknown}.`,
    '',
    '**O veredito só sai juntando as duas janelas** (W1 e W2) — mande os dois resumos.',
    '',
  );
  return lines.join('\n');
}

const VERDICT_TEXT = {
  FILTER_EDGE: '**O filtro de tendência diária melhorou as entradas na régua pré-registrada.** Próximo passo (só com sua aprovação): confirmar com o filtro rodando de verdade no motor de backtest, antes de qualquer decisão de produção.',
  NO_FILTER_EDGE: '**O filtro de tendência diária não melhorou as entradas.** Operar a favor da regra diária não rendeu mais R por operação, com folga, nas duas janelas.',
  INCOMPLETE: '**Resultado inválido — falta janela ou dado.** Não conta como resposta.',
};

export function formatCombinedMarkdown(c) {
  const lines = ['', '## Filtro de tendência diária — resultado final', '', VERDICT_TEXT[c.verdict], ''];
  if (c.verdict === 'INCOMPLETE') return [...lines, ...c.errors.map((e) => `- ${e}`), ''].join('\n');
  lines.push(
    `T médio das duas janelas: ${f(c.observed)} R por operação · t ${f(c.inference.t, 2)} com ${c.inference.clusters} meses (precisa ≥ ${f(c.inference.critical, 2)}).`,
    `Significância ${c.checks.significance ? 'sim' : 'não'} · efeito ≥ mínimo ${c.checks.effect ? 'sim' : 'não'} · positivo nas duas janelas ${c.checks.eachWindow ? 'sim' : 'não'}.`,
    `Descritivo (não decide): T do R0 positivo nas duas janelas ${c.descriptiveChecks.r0EachWindow ? 'sim' : 'não'}.`,
    '',
    ...c.windows.map((w) => `- ${w.window}: T ${f(w.observed)} R (R0 ${f(w.observedR0)}), t ${f(w.t, 2)} em ${w.months} meses, mantém ${pct(w.keptShare)} das operações, R médio das seeds ${f(w.seedsMeanR, 3)} → ${f(w.seedsMeanRKept, 3)} R com o filtro`),
    '',
  );
  return lines.join('\n');
}
