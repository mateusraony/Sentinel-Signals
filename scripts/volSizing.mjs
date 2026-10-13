// Teste pré-registrado de tamanho de posição pela volatilidade — docs/known-risks.md
// item 269. Parte pura (sem rede, sem Date.now); a CLI é scripts/vol-sizing.mjs.
//
// O que já existe: risco fixo de 1% por operação com stop de 2–3 × ATR, ou seja,
// a posição JÁ é ∝ 1/volatilidade de curto prazo. O que este teste mede é só o
// TIMING DE REGIME: um peso por operação
//   w = clamp(σ_ref / σ_20d, 0,5, 2)
// (σ_20d = desvio dos últimos 20 retornos diários fechados antes do dia da
// entrada; σ_ref = mediana de σ_20d no último ano), normalizado para média 1 em
// cada braço, para os dois fluxos terem o mesmo risco médio.
//
// Estatística: T = média(w̃·R) − média(R), média entre o R0 e as seeds.
// Como w̃ tem média 1 em cada braço, T = Σ cᵢ·(Rᵢ − R̄_braço) com Σcᵢ = 0: sob a
// hipótese nula (R não depende do peso) E[T] = 0, qualquer que seja o R médio.
//
// Inferência: t de Student sobre as somas MENSAIS de cᵢ·(Rᵢ − R̄) (mês
// calendário da entrada, todos os braços e moedas juntos). As seeds atravessam
// o mesmo caminho de preço, e os regimes de volatilidade e de resultado duram
// semanas — a unidade independente é o tempo, não a operação nem a seed. A
// nula de deslocamento circular (a do item 268) foi medida aqui e REPROVADA:
// com regimes de 1–3 meses há poucos deslocamentos efetivamente diferentes, e
// ela dava p ≤ 0,025 em ~7% das rodadas de puro ruído (deveria ser 2,5%).
import { getOpenedAt, getClosedAt } from '../src/lib/tradeMetrics.js';
import { distribution, summarizeRandomBaseline } from './randomBaselineSummary.mjs';
import { parseSymbolsFromTrialArgs } from './compareBacktestReports.mjs';
import { studentTCritical95 } from './backtest-correlation-check.mjs';

const DAY = 24 * 60 * 60 * 1000;
export const dayStart = (ms) => Math.floor(ms / DAY) * DAY;
const toMs = (v) => (v == null ? NaN : typeof v === 'number' ? v : new Date(v).getTime());
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const sd = (xs) => {
  if (xs.length < 2) return null;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
};
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const k = s.length;
  return k ? (k % 2 ? s[(k - 1) / 2] : (s[k / 2 - 1] + s[k / 2]) / 2) : null;
};

/**
 * σ conhecida no INÍCIO de cada dia D: desvio-padrão amostral dos últimos
 * `lookbackDays` retornos log diários de velas que fecharam antes de D. Exige
 * as lookbackDays+1 velas consecutivas; com buraco, aquele dia fica sem σ.
 * @returns {Map<number, number>} início do dia (ms UTC) → σ
 */
export function dailySigma(candles1d, lookbackDays) {
  const days = [...(candles1d || [])]
    .filter((c) => Number.isFinite(c?.openTime) && c.close > 0)
    .sort((a, b) => a.openTime - b.openTime);
  const out = new Map();
  for (let j = lookbackDays; j < days.length; j += 1) {
    if (days[j].openTime - days[j - lookbackDays].openTime !== lookbackDays * DAY) continue;
    const rets = [];
    for (let k = j - lookbackDays + 1; k <= j; k += 1) rets.push(Math.log(days[k].close / days[k - 1].close));
    // A vela j fecha às D−1ms; o σ vale para o dia seguinte inteiro.
    out.set(days[j].openTime + DAY, sd(rets));
  }
  return out;
}

/**
 * Peso de cada dia da janela [fromMs, toMs). Sem σ no dia, ou com menos de
 * `minRefDays` dias de referência, o peso é 1 ("plano") — moeda listada há
 * pouco não ganha nem perde tamanho.
 */
export function weightSeries(sigmaByDay, { fromMs, toMs, refDays, minRefDays, clamp }) {
  const out = [];
  for (let d = dayStart(fromMs); d < toMs; d += DAY) {
    const sigma = sigmaByDay.get(d);
    // Referência = os `refDays` dias ANTERIORES (sem o próprio dia — review do
    // Codex, PR #490: incluir o σ do dia puxava a mediana para o denominador).
    const ref = [];
    for (let k = 1; k <= refDays; k += 1) {
      const s = sigmaByDay.get(d - k * DAY);
      if (Number.isFinite(s)) ref.push(s);
    }
    if (!(sigma > 0) || ref.length < minRefDays) { out.push({ day: d, sigma: sigma ?? null, w: 1, flat: true }); continue; }
    const raw = median(ref) / sigma;
    out.push({ day: d, sigma, w: Math.min(clamp[1], Math.max(clamp[0], raw)), flat: false });
  }
  return out;
}

/** Operações fechadas de um relatório de backtest (overall.curve). */
export function opsFromReport(report) {
  return (report?.overall?.curve || [])
    .filter((c) => c?.op && Number.isFinite(c.r))
    .map((c) => ({ symbol: c.op.symbol, openedMs: toMs(getOpenedAt(c.op)), closedMs: toMs(getClosedAt(c.op)), r: c.r }));
}

// Contribuição de cada operação para o T do braço: (w̃ − 1)·(R − R̄)/n.
// A soma é exatamente média(w̃·R) − média(R).
function armContributions(ops, weightsBySymbol) {
  if (!ops.length) return [];
  const ws = ops.map((o) => weightsBySymbol[o.symbol][o.idx].w);
  const mw = mean(ws);
  const mr = mean(ops.map((o) => o.r));
  return ops.map((o, i) => ({ month: new Date(o.openedMs).toISOString().slice(0, 7), c: ((ws[i] / mw - 1) * (o.r - mr)) / ops.length }));
}

/** t de Student unicaudal sobre somas por cluster (Σ das somas = estatística). */
export function clusterT(sums, alpha) {
  const g = sums.length;
  const total = sums.reduce((a, b) => a + b, 0);
  const s = sd(sums);
  if (g < 3 || !(s > 0)) return { clusters: g, total, t: null, critical: null, pass: false };
  const t = (total / g) * Math.sqrt(g) / s;
  const critical = studentTCritical95(g - 1, 2 * alpha);
  return { clusters: g, total, t, critical, pass: t >= critical };
}

const cvar5 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.max(1, Math.floor(s.length * 0.05));
  return mean(s.slice(0, k));
};

function maxDrawdownR(xs) {
  let cum = 0; let peak = 0; let dd = 0;
  for (const x of xs) { cum += x; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  return dd;
}

/**
 * Uma janela: R0 + seeds, velas diárias, pré-registro.
 * @param {{ control: object, randoms: object[], candlesBySymbol: Record<string, object[]>, prereg: object, commitSha?: string|null }} input
 */
export function runVolSizingWindow({ control, randoms, candlesBySymbol, prereg }) {
  const errors = [];
  const fromIso = control?.range?.from ?? null;
  const toIso = control?.range?.to ?? null;
  const window = prereg.windows.find((w) => fromIso?.slice(0, 10) === w.from && toIso?.slice(0, 10) === w.to);
  if (!window) errors.push(`janela ${fromIso?.slice(0, 10)} → ${toIso?.slice(0, 10)} não é nenhuma das pré-registradas (${prereg.windows.map((w) => `${w.label} ${w.from} → ${w.to}`).join('; ')})`);

  // Mesma validação do item 264: braços comparáveis, seeds 1..N completas.
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
  // Borda da janela (achado na rodada real da W2, item 269): a 1ª passada da
  // janela (00:00 do 1º dia) decide com a vela que fechou 1 ms antes, e é esse
  // horário que a operação carrega. Ela pertence à janela e recebe o peso do
  // dia anterior, pela mesma regra causal. Por isso a série começa um dia
  // antes (índice 0 = dia −1) e o dia da operação é deslocado em +1.
  const seriesFromMs = fromMs - DAY;
  const n = Math.round((toMsWin - seriesFromMs) / DAY);
  const weightsBySymbol = {};
  const weightInfo = {};
  for (const s of prereg.symbols) {
    if (!candlesBySymbol[s]?.length) continue;
    const ws = weightSeries(dailySigma(candlesBySymbol[s], prereg.lookbackDays), {
      fromMs: seriesFromMs, toMs: toMsWin, refDays: prereg.refDays, minRefDays: prereg.minRefDays, clamp: prereg.weightClamp,
    });
    weightsBySymbol[s] = ws;
    // Descritivo só dos dias da janela (o dia −1 existe só para a borda).
    const live = ws.slice(1).filter((x) => !x.flat).map((x) => x.w);
    weightInfo[s] = { flatDays: ws.length - 1 - live.length, meanW: mean(live), minW: live.length ? Math.min(...live) : null, maxW: live.length ? Math.max(...live) : null };
  }

  const arms = [{ arm: 'R0', report: control }, ...randoms.map((r) => ({ arm: String(r.reproducibility?.pineConfig?.randomEntrySeed), report: r }))]
    .map(({ arm, report }) => {
      const ops = opsFromReport(report).map((o) => ({ ...o, idx: Math.floor((dayStart(o.openedMs) - seriesFromMs) / DAY) }));
      for (const o of ops) {
        if (!weightsBySymbol[o.symbol]) errors.push(`braço ${arm}: operação em ${o.symbol} sem velas diárias`);
        else if (!(o.openedMs >= fromMs - 1 && o.openedMs < toMsWin)) errors.push(`braço ${arm}: operação de ${o.symbol} aberta fora da janela`);
        else if (weightsBySymbol[o.symbol][o.idx].flat && weightsBySymbol[o.symbol][o.idx].sigma == null
          && candlesBySymbol[o.symbol].some((c) => c.openTime < o.openedMs - prereg.lookbackDays * DAY)) {
          // Moeda já listada há mais de 20 dias e mesmo assim sem σ = buraco nas velas.
          errors.push(`braço ${arm}: ${o.symbol} sem σ no dia da entrada (buraco nas velas diárias)`);
        }
      }
      return { arm, ops };
    });
  if (errors.length) return { verdict: 'INCOMPLETE', errors: [...new Set(errors)].slice(0, 20), window: window.label };

  // T da janela = média dos T dos braços; cada contribuição entra dividida
  // pelo número de braços com operação.
  const withOps = arms.filter((a) => a.ops.length);
  const byMonth = new Map();
  for (const a of withOps) {
    for (const { month, c } of armContributions(a.ops, weightsBySymbol)) byMonth.set(month, (byMonth.get(month) ?? 0) + c / withOps.length);
  }
  const clusterSums = [...byMonth.entries()].sort(([x], [y]) => x.localeCompare(y)).map(([month, sum]) => ({ month, sum }));
  const inference = clusterT(clusterSums.map((x) => x.sum), prereg.alpha);
  const observed = inference.total;

  const perArm = arms.map((a) => {
    const ws = a.ops.map((o) => weightsBySymbol[o.symbol][o.idx].w);
    const mw = mean(ws);
    const x = a.ops.map((o, i) => (ws[i] / mw) * o.r);
    const r = a.ops.map((o) => o.r);
    const T = a.ops.length ? armContributions(a.ops, weightsBySymbol).reduce((acc, o) => acc + o.c, 0) : null;
    return { arm: a.arm, n: a.ops.length, T, sdRatio: sd(x) / sd(r), cvarRatio: cvar5(x) / cvar5(r) };
  });
  const r0 = arms[0];
  const r0w = r0.ops.map((o) => weightsBySymbol[o.symbol][o.idx].w);
  const r0mw = mean(r0w);
  const byClose = r0.ops.map((o, i) => ({ ...o, wt: r0w[i] / r0mw })).sort((a, b) => a.closedMs - b.closedMs);
  const events = byClose.flatMap((o) => [{ t: o.openedMs, d: 1, w: o.wt }, { t: o.closedMs, d: -1, w: -o.wt }]).sort((a, b) => a.t - b.t || a.d - b.d);
  let open = 0; let openW = 0; let maxOpen = 0; let maxOpenW = 0;
  for (const e of events) { open += e.d; openW += e.w; maxOpen = Math.max(maxOpen, open); maxOpenW = Math.max(maxOpenW, openW); }

  return {
    verdict: 'WINDOW_DONE',
    errors: [],
    warnings: base.warnings,
    window: window.label,
    reportCommitSha: control?.reproducibility?.commitSha ?? null,
    from: window.from,
    to: window.to,
    days: n - 1,
    arms: arms.length,
    observed,
    observedR0: perArm[0].T,
    clusterSums,
    windowT: inference,
    descriptive: {
      sdRatio: distribution(perArm.map((a) => a.sdRatio)),
      cvarRatio: distribution(perArm.map((a) => a.cvarRatio)),
      predictedSdRatio: prereg.predictedSdRatio,
      armsWithPositiveT: perArm.filter((a) => a.T > 0).length,
      r0: {
        n: r0.ops.length,
        T: perArm[0].T,
        meanR: mean(r0.ops.map((o) => o.r)),
        meanWeightedR: mean(byClose.map((o) => o.wt * o.r)),
        maxDrawdownR: maxDrawdownR(byClose.map((o) => o.r)),
        maxDrawdownWeightedR: maxDrawdownR(byClose.map((o) => o.wt * o.r)),
        maxOpenOps: maxOpen,
        maxOpenWeight: maxOpenW,
        perSymbol: prereg.symbols.map((s) => {
          const os = byClose.filter((o) => o.symbol === s);
          return { symbol: s, n: os.length, meanWeight: mean(os.map((o) => o.wt)), meanR: mean(os.map((o) => o.r)) };
        }).filter((x) => x.n),
      },
      weights: weightInfo,
    },
  };
}

/**
 * Veredito final: junta as duas janelas pré-registradas.
 * `preregSha256` = hash do pré-registro ATUAL; cada janela tem que ter sido
 * calculada com ele (review do Codex, PR #490).
 */
export function combineWindows(summaries, prereg, { preregSha256 } = {}) {
  const errors = [];
  const labels = summaries.map((s) => s?.window);
  for (const w of prereg.windows) if (!labels.includes(w.label)) errors.push(`falta a janela ${w.label}`);
  if (summaries.length !== prereg.windows.length || new Set(labels).size !== labels.length) errors.push('são precisas exatamente as duas janelas, uma de cada');
  for (const s of summaries) if (s?.verdict !== 'WINDOW_DONE') errors.push(`janela ${s?.window ?? '?'}: ${s?.verdict ?? 'sem resumo'} — ${(s?.errors || []).join('; ')}`);
  if (!preregSha256) errors.push('falta o hash do pré-registro atual para conferir as janelas');
  else if (summaries.some((s) => s?.preregSha256 !== preregSha256)) errors.push('alguma janela foi calculada com um pré-registro diferente do atual');
  // Mesmo código nas duas janelas (review do Codex, PR #490): senão seriam duas
  // estratégias diferentes, não uma replicação.
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
    r0EachWindow: a.observedR0 > 0 && b.observedR0 > 0,
  };
  return {
    verdict: Object.values(checks).every(Boolean) ? 'VOLSIZING_EDGE' : 'NO_VOLSIZING_EDGE',
    errors: [],
    observed,
    inference,
    checks,
    windows: [a, b].map((s) => ({ window: s.window, observed: s.observed, observedR0: s.observedR0, t: s.windowT.t, months: s.windowT.clusters, sdRatio: s.descriptive.sdRatio.p50, cvarRatio: s.descriptive.cvarRatio.p50 })),
  };
}

const f = (v, d = 4) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));

export function formatWindowMarkdown(s) {
  const lines = ['', `## Tamanho pela volatilidade — janela ${s.window ?? '?'}`, ''];
  if (s.verdict === 'INCOMPLETE') {
    lines.push('**Resultado inválido — faltou dado ou a rodada não bate com o pré-registro.** Não conta como resposta.', '', ...s.errors.map((e) => `- ${e}`), '');
    return lines.join('\n');
  }
  const d = s.descriptive;
  lines.push(
    `Janela ${s.from} → ${s.to} (${s.days} dias), ${s.arms} braços (R0 + seeds).`,
    '',
    '| | Valor |',
    '|---|---|',
    `| T = R médio com peso − R médio sem peso (todos os braços) | ${f(s.observed)} R |`,
    `| T só do R0 (entrada da RF) | ${f(s.observedR0)} R |`,
    `| t desta janela (${s.windowT.clusters} meses; só informativo) | ${f(s.windowT.t, 2)} |`,
    `| Braços com T > 0 | ${d.armsWithPositiveT} de ${s.arms} |`,
    `| Desvio com peso ÷ sem peso (mediana; previsto ~${d.predictedSdRatio}) | ${f(d.sdRatio.p50, 3)} |`,
    `| Perda nos 5% piores, com peso ÷ sem peso (mediana) | ${f(d.cvarRatio.p50, 3)} |`,
    `| R0: queda máxima sem peso × com peso | ${f(d.r0.maxDrawdownR, 2)} R × ${f(d.r0.maxDrawdownWeightedR, 2)} R |`,
    `| R0: operações abertas ao mesmo tempo (máx.) × soma dos pesos | ${d.r0.maxOpenOps} × ${f(d.r0.maxOpenWeight, 2)} |`,
    '',
    '**O veredito só sai juntando as duas janelas** (W1 e W2) — mande os dois resumos.',
    '',
  );
  return lines.join('\n');
}

const VERDICT_TEXT = {
  VOLSIZING_EDGE: '**O tamanho pela volatilidade melhorou o resultado na régua pré-registrada.** Próximo passo (só com sua aprovação): decidir se e como isso entra no painel.',
  NO_VOLSIZING_EDGE: '**O tamanho pela volatilidade não melhorou o resultado.** Aumentar a mão em mercado calmo não rendeu mais R que a mão fixa atual, com folga, nas duas janelas.',
  INCOMPLETE: '**Resultado inválido — falta janela ou dado.** Não conta como resposta.',
};

export function formatCombinedMarkdown(c) {
  const lines = ['', '## Tamanho pela volatilidade — resultado final', '', VERDICT_TEXT[c.verdict], ''];
  if (c.verdict === 'INCOMPLETE') return [...lines, ...c.errors.map((e) => `- ${e}`), ''].join('\n');
  lines.push(
    `T médio das duas janelas: ${f(c.observed)} R por operação · t ${f(c.inference.t, 2)} com ${c.inference.clusters} meses (precisa ≥ ${f(c.inference.critical, 2)}).`,
    `Significância ${c.checks.significance ? 'sim' : 'não'} · efeito ≥ mínimo ${c.checks.effect ? 'sim' : 'não'} · positivo nas duas janelas ${c.checks.eachWindow ? 'sim' : 'não'} · R0 positivo nas duas ${c.checks.r0EachWindow ? 'sim' : 'não'}.`,
    '',
    ...c.windows.map((w) => `- ${w.window}: T ${f(w.observed)} R (R0 ${f(w.observedR0)}), t ${f(w.t, 2)} em ${w.months} meses, desvio com/sem peso ${f(w.sdRatio, 3)}, perda nos 5% piores com/sem ${f(w.cvarRatio, 3)}`),
    '',
  );
  return lines.join('\n');
}
