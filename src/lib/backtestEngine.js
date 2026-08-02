// Pure orchestration core for historical backtesting (docs/known-risks.md,
// .claude/rules/trading-engine.md). This does NOT reimplement the trading
// state machine or the indicator math — it drives the REAL scanAsset/
// persistScanResults from ./scanner.js against historical candle data
// instead of live Binance data, with a simulated clock so cooldowns/Time
// Stop/retry windows age correctly during replay. scanner.js itself is
// untouched: candles and pine config reach it exactly the way the
// browser/cron split already works — via import redirection at bundle time
// (scripts/build-backtest.mjs, a 5th redirect target alongside the 4
// scripts/build-scan.mjs already has) — not a new code path, not a third
// way to mutate a TradeOperation.
//
// priceCheckActiveOpsInner (the real-time spot-price loop) is deliberately
// NOT driven here — there's no tick data in a candle-only backtest, and
// persistScanResults' candle-based exits are already a conservative
// approximation of it (worst-case bar range, never faster to exit than live
// would be). That specific approximation can only make a backtested win rate
// look WORSE than live, never inflate it.
//
// CORREÇÃO (Fase 5, docs/known-risks.md item 44): a frase acima já foi escrita
// aqui como se valesse para o replay INTEIRO ("só pode parecer pior, nunca
// inflado") — e isso era falso. Ela vale só quanto à granularidade de candle.
// Até a Fase 5 o replay não descontava taxa, slippage nem funding, o que
// empurra na direção OPOSTA: inflava o resultado. Custos agora são
// descontados por padrão (tradeMetrics.js DEFAULT_COST_MODEL) e a seção
// `costs` do relatório mostra o quanto pesam, em % e em R.
import { scanAsset, persistScanResults } from './scanner.js';
import { isTerminalStatus } from './opTransition.js';
import { summarizeOps, DEFAULT_COST_MODEL, ZERO_COST, getOpenedAt } from './tradeMetrics.js';
import { closesFullyAtTp1 } from './opExitRules.js';

const RealDate = Date;
let originalDate = null;
let currentMs = 0;

class FakeDate extends RealDate {
  constructor(...args) {
    if (args.length === 0) super(currentMs);
    else super(...args);
  }
  static now() {
    return currentMs;
  }
}

// Replaces the GLOBAL `Date` with one whose no-arg constructor and `.now()`
// report the simulated instant instead of the real wall clock — scanner.js
// calls `Date.now()`/`new Date()` directly in ~19 places (cooldowns, Time
// Stop bar-aging, retry windows, timestamps), with no clock ever injected.
// Replaying months of history with the real clock running would make Time
// Stop fire almost immediately (age computed from `Date.now() - entryRef`
// would read as months old) and would corrupt every cooldown/retry window.
// `new Date(x)`/multi-arg construction pass through unchanged — only the
// "what time is it right now" default is overridden, the same one property
// vi.setSystemTime() overrides for Vitest's fake timers.
export function installSimClock(initialMs) {
  if (originalDate) throw new Error('installSimClock: a sim clock is already installed — call restoreClock() first');
  originalDate = globalThis.Date;
  currentMs = initialMs;
  globalThis.Date = FakeDate;
}

export function advanceSimClock(ms) {
  currentMs = ms;
}

export function simNow() {
  return currentMs;
}

export function restoreClock() {
  if (originalDate) {
    globalThis.Date = originalDate;
    originalDate = null;
  }
}

// No-look-ahead candle windowing — the one property every consumer
// (scanAsset, via the redirected fetchCandles) depends on to avoid look-
// ahead bias. Never exposes a candle whose closeTime is after the simulated
// cursor. `candles` must be sorted ascending by closeTime. Marks every
// returned candle `isClosed: true` unconditionally — the real
// marketDataProvider.js derives isClosed from `Date.now() > candle.closeTime`,
// which is meaningless here (every historical bar is trivially "in the
// past" relative to REAL wall-clock time; only the simulated cursor matters,
// and this function already only returns bars at or before it).
// BUSCA BINÁRIA, não varredura linear — e isso não é micro-otimização.
// A versão anterior caminhava do FIM do array para trás
// (`while (end > 0 && candles[end-1].closeTime > asOfMs) end--`). Com o cursor
// simulado no começo de uma janela longa, isso percorre quase o array inteiro
// a CADA chamada — e a função é chamada por ativo, por timeframe, a cada passo
// do replay. Como o número de passos também cresce com a janela, o custo total
// vira QUADRÁTICO no período: 4× o período = 16× o custo.
//
// Medido (run 30218382227): 4 anos × 7 símbolos rodou 5h25min sem terminar e
// bateu o timeout, contra 28 min para 12 meses — exatamente o 16× previsto.
// Com ~140 mil candles de 15m, são ~17 comparações aqui em vez de ~137 mil.
//
// `candles` DEVE estar ordenado de forma crescente por closeTime (pré-condição
// que já existia e da qual a versão linear também dependia).
export function sliceClosedAsOf(candles, asOfMs, limit) {
  // Primeiro índice cujo closeTime > asOfMs — ou seja, o fim exclusivo da
  // janela visível. É a MESMA fronteira que o laço linear encontrava.
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].closeTime > asOfMs) hi = mid;
    else lo = mid + 1;
  }
  const end = lo;
  const start = limit ? Math.max(0, end - limit) : 0;
  return candles.slice(start, end).map(c => ({ ...c, isClosed: true }));
}

// Finest enabled timeframe across all assets decides the replay cadence:
// between closes of that timeframe, fetchCandles for every OTHER timeframe
// returns an identical "last N closed candles" result (nothing scanAsset
// reads changes), so stepping any finer would just re-run no-ops — the same
// reason hasAssetStateChanged already skips redundant AssetState writes in
// production. 5m if any asset has the SMC 1h→5m cascade on, else 15m (the
// RF cascade's own confirmation timeframe).
export function inferStepMs(assets) {
  const anySmc = assets.some(a => a.smc_enabled);
  return (anySmc ? 5 : 15) * 60 * 1000;
}

export async function runBacktest({
  assets, backend, fromMs, toMs, evaluationFromMs, evaluationToMs, stepMs, onStep, costModel, minTrades,
} = {}) {
  if (!Array.isArray(assets) || assets.length === 0) {
    throw new Error('runBacktest: assets must be a non-empty array');
  }
  if (!backend) throw new Error('runBacktest: backend is required');
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) {
    throw new Error('runBacktest: fromMs/toMs must form a valid range (toMs > fromMs)');
  }
  const step = stepMs || inferStepMs(assets);

  // Warm-up (docs/known-risks.md item 47.2). fromMs/toMs continue a ser a
  // janela de DADOS — o relógio simulado corre por ela inteira, sem isso os
  // indicadores nunca convergiriam (RF/EMA/RSI/ATR/ADX/Choppiness precisam de
  // ~6× o próprio período, .claude/rules/pine-parity.md). evaluationFromMs/
  // evaluationToMs, quando passados, é a janela AVALIADA — só operações
  // abertas dentro dela entram no relatório. Ambos default para fromMs/toMs
  // (retrocompat total: sem os novos parâmetros o comportamento é idêntico a
  // antes desta mudança — nenhum relatório existente muda de número).
  const evalFromMs = Number.isFinite(evaluationFromMs) ? evaluationFromMs : fromMs;
  const evalToMs = Number.isFinite(evaluationToMs) ? evaluationToMs : toMs;
  if (evalFromMs < fromMs || evalToMs > toMs || evalToMs <= evalFromMs) {
    throw new Error('runBacktest: evaluationFromMs/evaluationToMs devem estar dentro de [fromMs, toMs] e formar um intervalo válido');
  }

  // Tallies the SMC 1h→5m cascade's structure-event funnel across the whole
  // replay — answers "why zero SMC trades?" with real counts instead of
  // silence. docs/known-risks.md item 38: the old 1h Premium/Discount zone
  // gate (item 35) was removed outright — every 1h structure break now
  // becomes a SignalEvent, so confirmedSignals (newSignals filtered to
  // source === 'smc_structure') IS structureEventsTotal now, not a fraction
  // of it. Zone-awareness moved to the 5m entry trigger instead
  // (check5mSmcConfirmation, evaluated against the break's own leg) —
  // smcOteZoneRejectionKeys mirrors persistScanResults' smc5mZoneRejections
  // (sampled from the entry motor's first evaluation of each signal only,
  // not the silent retry loop — see the comment on smc5mZoneRejections in
  // scanner.js for why). Deduplicated by `dedup_key` (same key
  // SystemLog.createUnique/SignalEvent.createUnique already dedupe by in
  // persistScanResults) — scanAsset is stateless and re-evaluates the SAME
  // last-closed 1h candle on every tick until the next one closes, so at the
  // real default cadence (5min while any asset has smc_enabled,
  // inferStepMs) a single event would otherwise be tallied once per tick
  // (~12x/hour) instead of once. Sets, not counters: scanAsset's own
  // `results`/`newSignals` stay per-tick and discarded after persisting,
  // same as before this change — only these key sets survive the loop.
  const smcConfirmedSignalKeys = new Set();
  const smcOteZoneRejectionKeys = new Set();
  // Cross-cascade arbitration outcomes (src/lib/signalArbitration.js),
  // surfaced so a replay makes the new "intelligent" blocking/promotion
  // visible instead of only inferable from op counts. Keyed by dedup_key —
  // a given signal reaches handleActiveOpArbitration at most once across the
  // whole replay (same SignalEvent.createUnique dedup smcConfirmedSignalKeys
  // above relies on), so a Map is defensive rather than strictly required.
  const arbitrationOutcomesByKey = new Map();
  // Fase 2 rodada 1 retest gate (docs/known-risks.md item 40) — same
  // dedup-by-key/last-write-wins convention as arbitrationOutcomesByKey
  // above, so a later "retested:true" recorded by the retry loop correctly
  // overwrites the "pending" outcome the 1st pass recorded for the same
  // signal. Empty for the whole replay whenever pineConfig.retestEnabled is
  // off (the default) — nothing ever pushes into it — which is also how the
  // report below infers whether the flag was on, without backtestEngine.js
  // needing its own redirected pineParser import.
  const retestOutcomesByKey = new Map();
  // Fase 2 rodada 2 displacement gate (docs/known-risks.md item 41) — same
  // convention as retestOutcomesByKey above. SMC 1h_5m only.
  const displacementOutcomesByKey = new Map();
  // Fase 3 SMC tier/regime gate (docs/known-risks.md item 42) — same
  // convention as retestOutcomesByKey above. SMC 1h_5m only.
  const smcRegimeOutcomesByKey = new Map();
  // Round 3 (docs/known-risks.md item 50) — same convention, mirrors
  // smcRegimeOutcomesByKey for the RF 4h_15m regime gate (evaluateRegime is
  // always on for RF, unlike SMC's opt-in smcTierEnabled).
  const rfRegimeOutcomesByKey = new Map();
  // Round 3 (docs/known-risks.md item 50) — same convention, for the SMC 5m
  // entry trigger (check5mSmcConfirmation). Also always-on (not opt-in).
  const smcTriggerOutcomesByKey = new Map();
  // Fase 4 Order Block / FVG (docs/known-risks.md item 43) — same convention.
  // SMC 1h_5m only, recorded at signal emission.
  const smcObFvgOutcomesByKey = new Map();
  // Gate de padrão de vela (engolfo), RF 4h_15m only, opt-in via
  // pineConfig.candlePatternEnabled — same convention as retestOutcomesByKey.
  const candlePatternOutcomesByKey = new Map();
  // known-risks item 45.3/49 — "muitos sinais, poucas operações". Diferente
  // dos Maps acima (que guardam o estado FINAL por sinal), este é um
  // histograma de TODAS as avaliações que rejeitaram algo, nas duas
  // cascatas — responde "qual gate barra mais ao longo do funil inteiro",
  // não "qual foi o motivo final de cada sinal". Um sinal que falha 3x e
  // confirma na 4ª tentativa conta 3 rejeições reais que aconteceram — não
  // seria correto (nem mais simples) tentar reconstruir só o motivo final
  // por sinal aqui, que exigiria cruzar de volta com TradeOperation.
  const entryFunnelCounts = { '4h_15m': {}, '1h_5m': {} };

  // Contagem de TENTATIVAS, paralela aos Maps acima. O loop de retry recomputa
  // cada gate do zero a cada passada, dentro da janela de 4h do sinal — então
  // um mesmo dedup_key pode ser avaliado muitas vezes. O Map por chave guarda o
  // estado FINAL (correto para confirmado/pendente), mas apagava o fato de ter
  // havido N avaliações: o relatório não distinguia "1 sinal que tentou 5x e
  // falhou" de "1 sinal que falhou 1x". São coisas operacionalmente
  // diferentes — custo de API, tempo em espera, e quantas vezes o gate quase
  // deixou passar. Achado de revisão externa (o documento de arquitetura
  // quantitativa, §10.3), confirmado contra o código.
  const attemptsByKey = {
    arbitration: new Map(),
    retest: new Map(),
    displacement: new Map(),
    smcRegime: new Map(),
    rfRegime: new Map(),
    smcObFvg: new Map(),
    smcTrigger: new Map(),
    candlePattern: new Map(),
  };
  const recordOutcome = (byKey, attempts, outcome) => {
    byKey.set(outcome.dedup_key, outcome);
    attempts.set(outcome.dedup_key, (attempts.get(outcome.dedup_key) || 0) + 1);
  };

  // Codex review (PR #104, P2): rfRegimeOutcomesByKey/smcRegimeOutcomesByKey
  // above are last-write-wins — buildRegimeSection's adxStats/chopStats read
  // from them, so a signal rejected at ADX 5 then 24 only ever contributed
  // its LAST rejection (24), and a signal that eventually PASSES contributes
  // none of its earlier rejections at all. Same histogram-not-Map pattern as
  // entryFunnelCounts above (every evaluation counts, not just the final
  // state) — these two plain arrays accumulate every regime evaluation,
  // independent of the per-signal Maps, so buildRegimeSection can compute
  // stats over every real rejection instead of only final signal states.
  const rfRegimeAllOutcomes = [];
  const smcRegimeAllOutcomes = [];

  installSimClock(fromMs);
  try {
    for (let t = fromMs; t <= toMs; t += step) {
      advanceSimClock(t);
      for (const asset of assets) {
        // Per-asset isolation, mirroring scanAllAssetsInner's own try/catch —
        // one asset's failure at one simulated instant must not abort the
        // whole replay or contaminate other assets' results.
        try {
          const result = await scanAsset(asset);
          for (const sig of (result.newSignals || [])) {
            if (sig.source === 'smc_structure') smcConfirmedSignalKeys.add(sig.dedup_key);
          }
          const persistResult = await persistScanResults(result);
          for (const rejection of (persistResult.smc5mZoneRejections || [])) {
            smcOteZoneRejectionKeys.add(rejection.dedup_key);
          }
          for (const outcome of (persistResult.arbitrationOutcomes || [])) {
            recordOutcome(arbitrationOutcomesByKey, attemptsByKey.arbitration, outcome);
          }
          for (const outcome of (persistResult.retestOutcomes || [])) {
            recordOutcome(retestOutcomesByKey, attemptsByKey.retest, outcome);
          }
          for (const outcome of (persistResult.displacementOutcomes || [])) {
            recordOutcome(displacementOutcomesByKey, attemptsByKey.displacement, outcome);
          }
          for (const outcome of (persistResult.smcRegimeOutcomes || [])) {
            recordOutcome(smcRegimeOutcomesByKey, attemptsByKey.smcRegime, outcome);
          }
          for (const outcome of (persistResult.smcObFvgOutcomes || [])) {
            recordOutcome(smcObFvgOutcomesByKey, attemptsByKey.smcObFvg, outcome);
          }
          // Codex review (PR #104, P2): plain running array (like
          // entryFunnelCounts below), NOT deduped by dedup_key — every
          // regime evaluation for the SMC cascade counts, so a signal
          // rejected 3 times before finally passing doesn't lose those 3
          // real rejections from the stats the way smcRegimeOutcomesByKey
          // (last-write-wins) does. Left OUTSIDE the eval-window gate below
          // on purpose, matching smcRegimeOutcomesByKey's own (pre-existing,
          // documented, deferred) lack of windowing — see known-risks.md
          // item 51's "not corrected" list.
          smcRegimeAllOutcomes.push(...(persistResult.smcRegimeOutcomes || []));
          // Codex review (PR #102): unlike the Maps above (which only ever
          // hold the FINAL outcome per dedup_key, so a warm-up-only entry is
          // naturally overwritten once real evaluation starts), this is a
          // running SUM across every tick — counting warm-up/post-evaluation
          // ticks here would silently inflate byReason with rejections
          // outside the window the rest of the report (evaluatedOps, costs)
          // is scoped to. Gate on the same evalFromMs/evalToMs boundary.
          if (t >= evalFromMs && t <= evalToMs) {
            for (const outcome of (persistResult.entryFunnelOutcomes || [])) {
              const bucket = (entryFunnelCounts[outcome.cascade] ||= {});
              bucket[outcome.reason] = (bucket[outcome.reason] || 0) + 1;
            }
            // Codex review (PR #103): rfRegimeOutcomes/smcTriggerOutcomes are
            // brand new this round — unlike the "naturally overwritten"
            // assumption above (which the SAME review disproved: a
            // warm-up-only signal that's never touched again just sits in
            // the Map as its own entry, and a post-cutoff retry can
            // overwrite an in-window signal's true final state), these two
            // get the SAME window gate as entryFunnelOutcomes from the
            // start. retestOutcomes/displacementOutcomes/smcRegimeOutcomes/
            // arbitrationOutcomes/smcObFvgOutcomes above share this same
            // pre-existing gap (Fase 2/3) — NOT fixed here, see
            // docs/known-risks.md item 51 for why that's a separate,
            // broader change left for its own round.
            for (const outcome of (persistResult.rfRegimeOutcomes || [])) {
              recordOutcome(rfRegimeOutcomesByKey, attemptsByKey.rfRegime, outcome);
            }
            // Codex review (PR #104, P2) — same running-array reasoning as
            // smcRegimeAllOutcomes above, kept correctly windowed here since
            // rfRegimeOutcomesByKey itself already is (Fix 1 above).
            rfRegimeAllOutcomes.push(...(persistResult.rfRegimeOutcomes || []));
            for (const outcome of (persistResult.smcTriggerOutcomes || [])) {
              recordOutcome(smcTriggerOutcomesByKey, attemptsByKey.smcTrigger, outcome);
            }
            // Gate de padrão de vela — brand new this round, correctly
            // windowed from the start (same as rfRegimeOutcomes/
            // smcTriggerOutcomes just above).
            for (const outcome of (persistResult.candlePatternOutcomes || [])) {
              recordOutcome(candlePatternOutcomesByKey, attemptsByKey.candlePattern, outcome);
            }
          }
        } catch (err) {
          if (onStep) onStep(t, { asset: asset.symbol, error: err.message });
        }
      }
      if (onStep) onStep(t);
    }
  } finally {
    restoreClock();
  }

  const allOps = await backend.entities.TradeOperation.filter({});
  // Operações abertas durante o aquecimento (antes de evalFromMs) ficaram só
  // pra dar histórico aos indicadores — nunca deveriam contar como resultado
  // avaliado. getOpenedAt (tradeMetrics.js) já é a referência única de
  // "quando a op começou a existir"; ausência dela (doc corrompido/legado)
  // não filtra — fail-open, mesmo espírito dos outros fallbacks deste módulo.
  const warmingUp = evalFromMs > fromMs || evalToMs < toMs;
  const evaluatedOps = warmingUp
    ? allOps.filter((op) => {
      const openedAtIso = getOpenedAt(op);
      if (!openedAtIso) return true;
      const openedAtMs = new Date(openedAtIso).getTime();
      return !Number.isFinite(openedAtMs) || (openedAtMs >= evalFromMs && openedAtMs <= evalToMs);
    })
    : allOps;

  return buildReport(evaluatedOps, {
    fromMs: evalFromMs, toMs: evalToMs,
    dataRangeMs: warmingUp ? { fromMs, toMs } : null,
    smcConfirmedSignals: smcConfirmedSignalKeys.size,
    smcRejectedByOteZone: smcOteZoneRejectionKeys.size,
    arbitrationOutcomes: [...arbitrationOutcomesByKey.values()],
    retestOutcomes: [...retestOutcomesByKey.values()],
    displacementOutcomes: [...displacementOutcomesByKey.values()],
    smcRegimeOutcomes: [...smcRegimeOutcomesByKey.values()],
    smcRegimeAllOutcomes,
    rfRegimeOutcomes: [...rfRegimeOutcomesByKey.values()],
    rfRegimeAllOutcomes,
    smcObFvgOutcomes: [...smcObFvgOutcomesByKey.values()],
    smcTriggerOutcomes: [...smcTriggerOutcomesByKey.values()],
    candlePatternOutcomes: [...candlePatternOutcomesByKey.values()],
    entryFunnelCounts,
    attemptStats: Object.fromEntries(
      Object.entries(attemptsByKey).map(([name, map]) => [name, summarizeAttempts(map)]),
    ),
    costModel,
    minTrades,
  });
}

// Forma estável para as seções do relatório: `evaluations` é quantas vezes o
// gate rodou, `total` (na própria seção) é quantos sinais únicos existiram.
// `retried` responde "quantos precisaram de mais de uma passada" — o número
// que estava invisível antes.
export const EMPTY_ATTEMPTS = { evaluations: 0, retried: 0, maxAttempts: 0 };

export function summarizeAttempts(attemptsMap) {
  if (!attemptsMap || attemptsMap.size === 0) return { ...EMPTY_ATTEMPTS };
  let evaluations = 0; let retried = 0; let maxAttempts = 0;
  for (const count of attemptsMap.values()) {
    evaluations += count;
    if (count > 1) retried += 1;
    if (count > maxAttempts) maxAttempts = count;
  }
  return { evaluations, retried, maxAttempts };
}

// Codex review (PR #103, P2): min/avg/max over the RAW adx/chop values from
// evaluations where that specific sub-gate rejected — answers "how close to
// the threshold" without dumping every raw sample into the JSON. null values
// (legacy outcomes / not computed) are skipped, not coerced to 0.
function numericStats(values) {
  const nums = values.filter((v) => v != null);
  if (nums.length === 0) return null;
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    avgRejected: +(sum / nums.length).toFixed(2),
    minRejected: Math.min(...nums),
    maxRejected: Math.max(...nums),
  };
}

// Round 3 (docs/known-risks.md item 50) — shared aggregation for the two
// regime-gate sections (rfRegime, smcRegime): identical shape and byReason
// bucketing, only the outcomes array/cascade differ. Extracted so the two
// sections can't silently drift apart.
//
// `outcomes` is the last-write-wins Map's values (one entry per unique
// signal — drives total/passed/rejected/byReason, consistent with every
// other Map-based section in this file). `allOutcomes` is the separate,
// non-deduped running array of EVERY evaluation (Codex review, PR #104,
// P2): adxStats/chopStats read from THIS one, not `outcomes` — a signal
// rejected at ADX 5 then 24 before finally passing would otherwise
// contribute nothing (final state is ok:true) or only its last rejection
// (24, not the true 5-then-24 spread) to the calibration stats.
function buildRegimeSection(outcomes, attempts, allOutcomes = outcomes) {
  const passed = outcomes.filter(o => o.ok).length;
  const byReason = {};
  for (const { ok, adxOk, chopOk } of outcomes) {
    if (ok) continue;
    const reason = !adxOk && !chopOk ? 'adx_and_chop' : !adxOk ? 'adx_weak' : 'choppy';
    byReason[reason] = (byReason[reason] || 0) + 1;
  }
  const adxRejectedValues = [];
  const chopRejectedValues = [];
  for (const { adxOk, chopOk, adx, chop } of allOutcomes) {
    if (!adxOk) adxRejectedValues.push(adx);
    if (!chopOk) chopRejectedValues.push(chop);
  }
  return {
    enabled: outcomes.length > 0,
    total: outcomes.length,
    attempts,
    passed,
    rejected: outcomes.length - passed,
    byReason,
    // Codex review (PR #103, P2): before this, adx/chop/tier were collected
    // on every outcome (Round 3) but never surfaced anywhere in the
    // aggregated report — a future threshold-calibration decision had no way
    // to see whether rejections were near-miss or nowhere close.
    adxStats: numericStats(adxRejectedValues),
    chopStats: numericStats(chopRejectedValues),
  };
}

// Groups closed ops by cascade (4h_15m vs 1h_5m) and feeds each group (plus
// the overall set) into tradeMetrics.summarizeOps — the exact same win
// rate/profit factor/expectancy-in-R/drawdown calculation the app's own UI
// already trusts, not reinvented here. Ops still non-terminal at the cutoff
// are reported separately, never force-closed and never counted in win/
// loss/BE (summarizeOps already excludes them via isTerminalStatus).
// Ecoa no relatório o modelo de custo efetivamente aplicado, para o JSON ser
// autoexplicativo meses depois ("este run foi com ou sem custo?").
function resolveReportCostModel(costModel) {
  if (!costModel) return { ...DEFAULT_COST_MODEL, applied: true };
  const isZero = ['feeBpsEntry', 'feeBpsExit', 'slippageBpsPerSide', 'fundingBpsPer8h']
    .every(k => (costModel[k] ?? DEFAULT_COST_MODEL[k]) === ZERO_COST[k]);
  return { ...DEFAULT_COST_MODEL, ...costModel, applied: !isZero };
}

export function buildReport(ops, {
  fromMs, toMs, dataRangeMs = null, smcConfirmedSignals = 0, smcRejectedByOteZone = 0,
  arbitrationOutcomes = [], retestOutcomes = [], displacementOutcomes = [],
  smcRegimeOutcomes = [], smcRegimeAllOutcomes = smcRegimeOutcomes,
  rfRegimeOutcomes = [], rfRegimeAllOutcomes = rfRegimeOutcomes,
  smcObFvgOutcomes = [], smcTriggerOutcomes = [], candlePatternOutcomes = [],
  entryFunnelCounts = { '4h_15m': {}, '1h_5m': {} }, attemptStats = {}, costModel, minTrades,
} = {}) {
  const attemptsOf = (name) => attemptStats[name] ?? { ...EMPTY_ATTEMPTS };
  const stillOpen = ops.filter(op => !isTerminalStatus(op.status));
  const closed = ops.filter(op => isTerminalStatus(op.status));

  const byCascade = {};
  for (const op of closed) {
    const key = op.cascade || 'unknown';
    (byCascade[key] ||= []).push(op);
  }
  const cascades = {};
  for (const [cascade, group] of Object.entries(byCascade)) {
    cascades[cascade] = summarizeOps(group, { costModel, minTrades });
  }
  // Calculado uma vez e reusado em `overall` e na seção `costs` — as duas
  // precisam vir do MESMO agregado, senão o veredito de amostra poderia
  // descrever um conjunto diferente do que o relatório mostra.
  const overallSummary = summarizeOps(closed, { costModel, minTrades });

  return {
    range: {
      fromMs, toMs,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    },
    // Presente só quando evaluationFromMs/evaluationToMs restringiu a janela
    // avaliada pra menos que a janela de dados (item 47.2/warm-up) — a
    // diferença entre `range` (o que foi CONTADO) e `dataRangeMs` (o que o
    // relógio simulado efetivamente percorreu) é exatamente o buffer de
    // aquecimento.
    dataRangeMs,
    totalOps: ops.length,
    stillOpenAtCutoff: stillOpen.length,
    overall: overallSummary,
    byCascade: cascades,
    // Answers "why zero SMC (1h_5m) trades?" with real counts instead of an
    // empty byCascade entry — see docs/known-risks.md items 34/35/38.
    // structureEventsTotal === confirmedSignals BY DESIGN post-item-38 (every
    // 1h break becomes a SignalEvent, no gate left between the two) — kept
    // as a separate field for report-shape stability and as a regression
    // signal: the concrete tests in backtestEngine.test.js assert both
    // against a known ground-truth event count, so a future reintroduction
    // of 1h-stage gating would show up as confirmedSignals (and this field)
    // dropping below that count. rejectedByOteZone is a DIFFERENT, later
    // pipeline stage (the 5m entry trigger) — not subtracted from this total.
    smcDiagnostics: {
      structureEventsTotal: smcConfirmedSignals,
      confirmedSignals: smcConfirmedSignals,
      rejectedByOteZone: smcRejectedByOteZone,
      tradeOpsCreated: ops.filter(op => op.cascade === '1h_5m').length,
    },
    // Cross-cascade arbitration (src/lib/signalArbitration.js) — counts by
    // outcome and by the CANDIDATE cascade that triggered each decision
    // (not the active op's cascade). Empty/all-zero when no competing
    // signal ever arrived during the replay, which is the common case for a
    // short window or a single-cascade asset — not itself a sign of a bug.
    arbitration: (() => {
      const byOutcome = {};
      const byCascade = {};
      for (const { cascade, outcome } of arbitrationOutcomes) {
        byOutcome[outcome] = (byOutcome[outcome] || 0) + 1;
        (byCascade[cascade] ||= {});
        byCascade[cascade][outcome] = (byCascade[cascade][outcome] || 0) + 1;
      }
      return { total: arbitrationOutcomes.length, attempts: attemptsOf('arbitration'), byOutcome, byCascade };
    })(),
    // Fase 2 rodada 1 retest gate (src/lib/indicators/retest.js,
    // docs/known-risks.md item 40) — opt-in, off by default. `enabled` is
    // inferred from retestOutcomes being non-empty (nothing is ever pushed
    // while pineConfig.retestEnabled is false), so a report from a replay
    // with the flag off reads `{enabled:false, total:0, ...}` — matching the
    // no-op guarantee the gate has in production. This section is the whole
    // point of the "compare before activating" workflow: run twice
    // (--pine-config with/without retestEnabled) and diff this block against
    // the win-rate/R:R numbers above, per known-risks.md item 40 / the
    // backtest-usage.md recipe.
    retest: (() => {
      const confirmed = retestOutcomes.filter(o => o.retested).length;
      const barsSum = retestOutcomes.reduce((sum, o) => sum + (o.retested ? (o.barsToConfirm || 0) : 0), 0);
      const byCascade = {};
      const byReason = {};
      for (const { cascade, retested, reason } of retestOutcomes) {
        (byCascade[cascade] ||= { total: 0, confirmed: 0, pending: 0 });
        byCascade[cascade].total += 1;
        byCascade[cascade][retested ? 'confirmed' : 'pending'] += 1;
        // Auditoria pós-#81/#82: "pending" sozinho conflava motivos distintos
        // (ainda aguardando vs. parâmetros inválidos vs. sem candles) num só
        // número — byReason separa cada `reason` de detectRetest.
        if (!retested) byReason[reason] = (byReason[reason] || 0) + 1;
      }
      return {
        enabled: retestOutcomes.length > 0,
        total: retestOutcomes.length,
        attempts: attemptsOf('retest'),
        confirmed,
        pending: retestOutcomes.length - confirmed,
        avgBarsToConfirm: confirmed > 0 ? +(barsSum / confirmed).toFixed(1) : null,
        byCascade,
        byReason,
      };
    })(),
    // Fase 2 rodada 2 displacement gate (src/lib/indicators/displacement.js,
    // docs/known-risks.md item 41) — opt-in, off by default, SMC 1h_5m
    // cascade only. Same `enabled`-inferred-from-non-empty convention as
    // `retest` above, and the same purpose: the number to diff between two
    // --pine-config runs (with/without displacementEnabled) before deciding
    // to activate. avgBodyRatio is only over CONFIRMED outcomes — the
    // metric to look at when calibrating displacementBodyAtrMult.
    displacement: (() => {
      const confirmedD = displacementOutcomes.filter(o => o.isDisplacement).length;
      const bodyRatioSum = displacementOutcomes.reduce((sum, o) => sum + (o.isDisplacement ? (o.bodyRatio || 0) : 0), 0);
      const byCascade = {};
      const byReason = {};
      for (const { cascade, isDisplacement, reason } of displacementOutcomes) {
        (byCascade[cascade] ||= { total: 0, confirmed: 0, pending: 0 });
        byCascade[cascade].total += 1;
        byCascade[cascade][isDisplacement ? 'confirmed' : 'pending'] += 1;
        if (!isDisplacement) byReason[reason] = (byReason[reason] || 0) + 1;
      }
      return {
        enabled: displacementOutcomes.length > 0,
        total: displacementOutcomes.length,
        attempts: attemptsOf('displacement'),
        confirmed: confirmedD,
        pending: displacementOutcomes.length - confirmedD,
        avgBodyRatio: confirmedD > 0 ? +(bodyRatioSum / confirmedD).toFixed(2) : null,
        byCascade,
        byReason,
      };
    })(),
    // Fase 3 SMC tier/regime gate (src/lib/indicators/tier.js,
    // docs/known-risks.md item 42) — opt-in, off by default, SMC 1h_5m
    // cascade only. Same `enabled`-inferred-from-non-empty convention as
    // `retest`/`displacement` above — the number to diff between two
    // --pine-config runs (with/without smcTierEnabled) before deciding to
    // activate.
    smcRegime: buildRegimeSection(smcRegimeOutcomes, attemptsOf('smcRegime'), smcRegimeAllOutcomes),
    // Round 3 (docs/known-risks.md item 50) — same shape as smcRegime above,
    // mirrored for the RF 4h_15m cascade. Unlike SMC's opt-in
    // smcTierEnabled, evaluateRegime always runs for RF — `enabled` here
    // just means "at least one 4h regime evaluation happened during the
    // window", not a feature flag. This closed the biggest blind spot found
    // by the entryFunnel section (item 49): `regime_rejected` was 69% of
    // 4h_15m rejections with zero visibility into the actual adx/chop
    // values that produced them.
    rfRegime: buildRegimeSection(rfRegimeOutcomes, attemptsOf('rfRegime'), rfRegimeAllOutcomes),
    // Fase 4 Order Block / FVG (src/lib/indicators/orderBlock.js + fvg.js,
    // docs/known-risks.md item 43) — opt-in, off by default, SMC 1h_5m only,
    // medido no momento da EMISSÃO do sinal. Mesma convenção
    // `enabled`-inferido-de-array-não-vazio das seções acima. Com os pesos no
    // default (0) esta seção é o ÚNICO efeito observável de ligar o flag — é
    // exatamente o dado pra decidir se vale dar peso a OB/FVG no score.
    smcObFvg: (() => {
      let obActive = 0, fvgActive = 0, both = 0, neither = 0;
      for (const o of smcObFvgOutcomes) {
        if (o.obActive) obActive += 1;
        if (o.fvgActive) fvgActive += 1;
        if (o.obActive && o.fvgActive) both += 1;
        if (!o.obActive && !o.fvgActive) neither += 1;
      }
      return {
        enabled: smcObFvgOutcomes.length > 0,
        total: smcObFvgOutcomes.length,
        attempts: attemptsOf('smcObFvg'),
        obActive,
        fvgActive,
        both,
        neither,
      };
    })(),
    // Round 3 (docs/known-risks.md item 50) — gatilho de entrada 5m da
    // cascata SMC (check5mSmcConfirmation). Unlike retest/displacement/
    // smcRegime/smcObFvg above, this is NEVER opt-in (no pineConfig flag
    // gates it — it runs whenever asset.smc_enabled is set), so `enabled`
    // would be misleading here (it'd almost always read true without
    // meaning "a flag is on") — deliberately omitted. `attempts.evaluations`
    // is what turns "signals seem to exhaust the whole 4h retry window"
    // (previously only an aggregate-arithmetic inference: 346 signals × ~48
    // evaluations ≈ 17,024, matching the measured entryFunnel total) into a
    // real per-signal count.
    smcTrigger: (() => {
      const confirmedCount = smcTriggerOutcomes.filter(o => o.confirmed).length;
      const byReason = {};
      const byTrigger = { sweep: 0, structure: 0 };
      for (const o of smcTriggerOutcomes) {
        if (o.confirmed) { if (o.trigger) byTrigger[o.trigger] = (byTrigger[o.trigger] || 0) + 1; continue; }
        byReason[o.rejectReason] = (byReason[o.rejectReason] || 0) + 1;
      }
      return {
        total: smcTriggerOutcomes.length,
        attempts: attemptsOf('smcTrigger'),
        confirmed: confirmedCount,
        rejected: smcTriggerOutcomes.length - confirmedCount,
        byTrigger,
        byReason,
      };
    })(),
    // Gate de padrão de vela (engolfo) — pedido do usuário, 2026-08-02.
    // Opt-in (pineConfig.candlePatternEnabled, off por padrão), RF 4h_15m
    // only — `enabled` aqui SIM é significativo (ao contrário de smcTrigger
    // acima, que nunca é opt-in): total 0 pode genuinamente significar
    // "flag desligado neste run", não só "nenhum sinal passou pelas
    // avaliações anteriores".
    candlePattern: (() => {
      const passed = candlePatternOutcomes.filter(o => o.ok).length;
      const byPattern = {};
      const byReason = {};
      for (const o of candlePatternOutcomes) {
        if (o.ok) { if (o.pattern) byPattern[o.pattern] = (byPattern[o.pattern] || 0) + 1; continue; }
        byReason[o.reason] = (byReason[o.reason] || 0) + 1;
      }
      return {
        enabled: candlePatternOutcomes.length > 0,
        total: candlePatternOutcomes.length,
        attempts: attemptsOf('candlePattern'),
        passed,
        rejected: candlePatternOutcomes.length - passed,
        byPattern,
        byReason,
      };
    })(),
    // Geometria de saída (docs/known-risks.md item 46) — QUAL gestão este run
    // usou. Só o estado, não a atribuição: quanto o runner rendeu já sai no
    // diagnóstico (`analyze-backtest`, seção "O RUNNER PAGOU?"), que o workflow
    // publica no mesmo resumo — duplicar aqui seria duas fontes para o mesmo
    // número. O que esta seção impede é o erro de comparar dois relatórios sem
    // perceber que a GESTÃO mudou entre eles, o que atribuiria à estratégia uma
    // diferença que veio da saída.
    runner: (() => {
      let withRunner = 0, fullyClosedAtTp1 = 0;
      for (const op of closed) {
        if (closesFullyAtTp1(op)) fullyClosedAtTp1 += 1; else withRunner += 1;
      }
      return {
        // Inferido das próprias operações, não lido do pineConfig: é a gestão
        // que de fato foi aplicada, mesmo que o flag tenha mudado no meio.
        enabled: withRunner > 0,
        opsWithRunner: withRunner,
        opsFullyClosedAtTp1: fullyClosedAtTp1,
        closedByTp1Full: closed.filter(op => op.closed_reason === 'TP1_FULL').length,
      };
    })(),
    // Proteção de stop pré-TP1 (docs/known-risks.md items 53/54) — opt-in,
    // off by default (pineConfig.preTp1StopProtectionEnabled). Diferente de
    // retest/displacement/smcRegime acima, não precisou de um array de
    // outcomes novo threaded pelo scanner: os 3 campos que a decisão precisa
    // (pre_tp1_stop_protection_enabled/_advance_trigger_atr_mult/_advanced_at)
    // já ficam gravados NA PRÓPRIA operação (mesmo padrão do `runner` acima
    // — inferido de `closed`, não de um outcomes array). `advanced` é quantas
    // ops tiveram o gate DISPARADO (não só habilitado); dos disparados,
    // `reachedTp1AfterAdvance` é quem seguiu até o TP1 mesmo assim (contra-
    // evidência de corte prematuro — o risco de whipsaw que a pesquisa de
    // comunidade documentou), `stoppedAtBreakevenPreTp1` é quem parou no
    // stop já protegido (o cenário que o mecanismo pretende evitar virar
    // perda cheia), `otherExitAfterAdvance` cobre Time Stop/Chop Exit/
    // Invalidation depois do avanço. Comparar este bloco entre dois relatórios
    // (--pine-config com/sem o flag) é o mesmo fluxo "compare antes de ativar"
    // de retest/displacement/smcTier — ver known-risks.md item 54.
    preTp1StopProtection: (() => {
      const enabledOps = closed.filter(op => op.pre_tp1_stop_protection_enabled === true);
      const advancedOps = enabledOps.filter(op => op.pre_tp1_stop_advanced_at);
      let reachedTp1 = 0, stoppedAtBreakeven = 0, otherExit = 0;
      for (const op of advancedOps) {
        if (op.tp1_hit) reachedTp1 += 1;
        else if (op.status === 'STOP_HIT') stoppedAtBreakeven += 1;
        else otherExit += 1;
      }
      return {
        enabled: enabledOps.length > 0,
        total: enabledOps.length,
        advanced: advancedOps.length,
        reachedTp1AfterAdvance: reachedTp1,
        stoppedAtBreakevenPreTp1: stoppedAtBreakeven,
        otherExitAfterAdvance: otherExit,
      };
    })(),
    // Funil de confirmação de entrada (docs/known-risks.md item 45.3/49) —
    // "muitos sinais, poucas operações": quantas vezes cada gate rejeitou uma
    // tentativa de confirmar entrada, nas duas cascatas, ao longo do replay
    // inteiro (1ª passada + todas as passadas de retry). `totalRejections` é
    // a soma de `byReason` — NÃO é "quantos sinais únicos", é quantas
    // avaliações rejeitaram algo (ver comentário de entryFunnelCounts em
    // runBacktest). Vazio nas duas cascatas é normal se nenhum sinal chegou
    // a ser avaliado nesse período.
    entryFunnel: Object.fromEntries(
      Object.entries(entryFunnelCounts).map(([cascade, byReason]) => [
        cascade,
        { totalRejections: Object.values(byReason).reduce((a, b) => a + b, 0), byReason },
      ]),
    ),
    // Fase 5 (docs/known-risks.md item 44) — o custo que o replay descontou e,
    // mais importante, o veredito de amostra. `avgCostR` é a linha decisiva:
    // se ela for da mesma ordem que `overall.expectancyR`, a "vantagem" era
    // só ausência de custo. `conclusive:false` significa que NENHUMA conclusão
    // deve ser tirada deste relatório, por mais bonito que o win rate esteja.
    costs: {
      model: resolveReportCostModel(costModel),
      avgCostR: overallSummary.avgCostR,
      totalCostPct: overallSummary.totalCostPct,
      grossExpectancyR: overallSummary.grossExpectancyR,
      netExpectancyR: overallSummary.expectancyR,
      conclusive: overallSummary.conclusive,
      inconclusiveReason: overallSummary.inconclusiveReason,
      expectancyRCI95: overallSummary.expectancyRCI95,
      countedTrades: overallSummary.counted,
      minTrades: overallSummary.minTrades,
    },
  };
}
