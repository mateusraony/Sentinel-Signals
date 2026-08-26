/**
 * Pine Script Parser — extracts input parameters from Pine v6 code
 * and syncs them to the scanner engine automatically.
 *
 * When the user edits the Pine Script in the editor, this parser
 * extracts all input.* declarations and stores them. The scanner
 * reads from this config on every scan, so changes to the Pine
 * Script are reflected automatically — no manual bot changes needed.
 */

import { logWarn } from './logger';

const PINE_CONFIG_KEY = 'cryptoradar_pine_config';

// Exported so callers reconstructing a COMPLETE config from a partial one
// (e.g. Backtest.jsx's "apply trial to live scanner", applying an old
// report generated before a key existed) can fall back to the value that
// was actually in effect at the time, instead of silently leaving
// whatever is currently stored in Firestore untouched — see docs/known-risks.md
// item 93 (Codex review, PR #197).
export const DEFAULTS = {
  rng_per: 20,
  rng_qty: 3.5,
  minScore: 75,
  atrLen: 14,
  tp1R: 1.5,
  tp1QtyPercent: 50,
  trailAtrMult: 2.0,
  emaFastLen: 20,
  emaSlowLen: 50,
  rsiLen: 14,
  volLen: 20,
  pineVersion: 6,
  strategyTitle: 'NEW ERA - Range Filter Strategy v13.2',
  // Auto-Tier (Grupo 03)
  tier2Threshold: 0.8,
  tier3Threshold: 1.5,
  // Regime filters (Grupo 05)
  useADX: true,
  adxLen: 14,
  adxSmooth: 14,
  useChop: true,
  chopLen: 14,
  // Smart exits (Grupo 08)
  useTimeStop: true,
  timeStopT1: 48,
  timeStopT2: 64,
  timeStopT3: 96,
  useChopExit: false,
  useInvalidation: false,
  invalidRFBars: 2,
  invalidScoreMin: 75,
  // Signal confirmation (Grupo 02)
  confirmBars: 1,
  onlyClosedCandles: true,
  // Cross-cascade arbitration (src/lib/signalArbitration.js) — not part of
  // the user's Pine Script (no `input.*()` declaration parses these; they
  // only change via strategyConfig/current directly), but synced the same
  // way so the browser and cron agree.
  arbEnabled: true,
  arbPromoteMinScore: 75,
  arbReinforceMinScore: 50,
  arbInvalidateOnOppositeMajor: false,
  // Mesmo mecanismo que arbInvalidateOnOppositeMajor, mas para um candidato
  // oposto do MESMO timeframe (same_cascade_opposite_direction), não do
  // timeframe maior. Master flag OFF por padrão — pesquisa de comunidade
  // (stop-and-reverse/whipsaw) recomenda confirmação forte antes de agir
  // sobre reversão, e o mecanismo irmão (correction_warning/item 45.9) já
  // documentou causalidade invertida: o aviso tende a chegar depois que o
  // preço já andou contra a posição. NÃO ativar sem comparar relatórios de
  // backtest com/sem primeiro. Ver docs/known-risks.md item 93.
  arbInvalidateOnOppositeSameTf: false,
  arbOppositeScorePenalty: 15,
  // Risk:Reward entry gate (src/lib/opExitRules.js passesRiskReward)
  minRR: 1.2,
  // SMC (1h→5m cascade) confluence score weights (src/lib/indicators/smcConfluence.js)
  smcScoreStructureWeight: 15,
  smcScoreChochBonus: 10,
  smcScoreEmaWeight: 20,
  smcScoreRfWeight: 15,
  smcScoreVolumeWeight: 15,
  smcScoreAlignmentWeight: 15,
  smcScoreSweepWeight: 10,
  // Runner do TP1 (known-risks item 46). LIGADO por padrão = comportamento de
  // sempre (parcial no TP1 + runner até TP2/trailing). Com `false`, o TP1 fecha
  // 100% da posição e vira saída terminal. Medido em 344 operações: o runner
  // custou -0,040 R por operação (-13,9 R no total), e fechar no TP1 teria sido
  // melhor em 95 das 121 que o atingiram. NÃO virou default porque a medição é
  // de UM regime (bear market) — comparar backtests antes de ligar.
  runnerEnabled: true,
  // Retest confirmation gate (Fase 2 rodada 1, src/lib/indicators/retest.js)
  // — also not from any `input.*()` in the Pine, same reasoning as the
  // arbitration keys above. Master flag OFF by default: see
  // docs/known-risks.md item 40 — do not flip without comparing backtest
  // reports with/without it first.
  retestEnabled: false,
  retestToleranceAtrMult: 0.3,
  retestTouchMode: 'close',
  // Displacement candle gate (Fase 2 rodada 2, SMC 1h→5m only,
  // src/lib/indicators/displacement.js) — same reasoning as retest above:
  // master flag OFF by default, see docs/known-risks.md item 41.
  // displacementMinVolumeRatio null = volume never required (pure
  // price-action mode, the canonical-ICT reading found by research).
  displacementEnabled: false,
  displacementBodyAtrMult: 1.5,
  displacementMinVolumeRatio: null,
  // SMC tier/regime gate (Fase 3, src/lib/indicators/tier.js) — extends the
  // RF cascade's existing classifyTier/evaluateRegime to the 1h→5m cascade
  // too, reusing the same threshold table (no separate 1h calibration).
  // Master flag OFF by default, see docs/known-risks.md item 42.
  smcTierEnabled: false,
  // Order Block / Fair Value Gap (Fase 4, src/lib/indicators/orderBlock.js +
  // fvg.js) — informational score inputs, never a gate (the user's own Pine
  // consumes them the same way, as 2 of 7 components in its Confluence Score).
  // Master flag OFF by default; the numeric params below mirror the real
  // Pine's own values. See docs/known-risks.md item 43.
  smcObFvgEnabled: false,
  obFvgAtrLen: 50,           // = ND.atr(50) do Pine
  obMinAtrMult: 0.5,         // = ob_thresh_min (ATR × 0.5)
  obMaxAtrMult: 2.5,         // = ob_thresh_max (ATR × 2.5)
  fvgMinAtrMult: 0.5,        // = min_fvg_atr_mult
  fvgFillTargetRatio: 0.6,   // = fvg_fill_target_ratio (60%, não 50% nem total)
  // Pesos no score SMC — nascem em 0 DE PROPÓSITO: os 7 pesos existentes já
  // somam 100 e o score é consumido pelos limiares de arbitragem da Fase 1
  // (arbPromoteMinScore/arbReinforceMinScore). Ligar o flag primeiro dá
  // medição pura com score idêntico; subir o peso é decisão separada,
  // depois de comparar backtests (item 43).
  smcScoreObWeight: 0,
  smcScoreFvgWeight: 0,
  // Proteção de stop pré-TP1 (known-risks.md item 53/54) — não é do Pine,
  // mesmo padrão dos outros flags de mecanismo (arbEnabled/runnerEnabled/
  // retestEnabled/etc). Master flag: 61 das 117 operações de um backtest
  // real (12 meses/7 símbolos) ficaram positivas cedo (MFE médio +0,578R) e
  // depois erodiram até o stop original sem NENHUMA proteção intermediária
  // (advanceTrailingStop só roda pós-TP1). Threshold em múltiplo de ATR
  // (não um R fixo pequeno) por causa da armadilha de whipsaw documentada
  // na pesquisa de comunidade — ver item 54.
  //
  // LIGADO por padrão desde 2026-08-26 (item 132, decisão do usuário),
  // no modo TRAILING (não o breakeven que `preTp1StopProtectionAtrMult`
  // sozinho descreve — ver `preTp1TrailEnabled` abaixo, que escolhe o
  // modo). Medido contra grade pré-registrada (config A: start 1,0/trail
  // 2,0 — os dois valores já existiam na estratégia, zero parâmetro novo):
  // 103 vs. 120 operações, mesma expectância líquida dentro do ruído
  // (+0,0257R vs. +0,0262R — diferença não detectável, z=0,004), mas sd(R)
  // cai 35% e max drawdown cai pela metade (12,66% → 6,40%). Não prova
  // edge — reduz o custo (amostra necessária) de provar ou refutar um.
  // `preTp1StopProtectionAtrMult` fica sem efeito enquanto o modo for
  // 'trailing' (só governa o breakeven), mantido pelo mesmo valor de
  // sempre para não mudar nada se algum dia o modo voltar a breakeven.
  preTp1StopProtectionEnabled: true,
  preTp1StopProtectionAtrMult: 1.0,
  // Trailing pré-TP1 contínuo (known-risks.md item 132) — segundo modo do
  // MESMO bloco acima, mutuamente exclusivo com o breakeven; qual roda é
  // lido da OPERAÇÃO (`pre_tp1_stop_mode`, congelado na criação — nunca do
  // pineConfig ao vivo, então um flip aqui só afeta operações NOVAS).
  // Ratcheia com a volatilidade, ancorado no extremo favorável desde a
  // entrada, em vez de saltar uma vez pra breakeven e saturar. Valores
  // (start 1,0×ATR / trail 2,0×ATR) são a config A medida acima — 2,0 é o
  // mesmo `trailAtrMult` do trailing pós-TP1 já em produção.
  preTp1TrailEnabled: true,
  preTp1TrailStartAtrMult: 1.0,
  preTp1TrailAtrMult: 2.0,
  // Gate de padrão de vela (engolfo) na cascata RF 4h→15m — não é do Pine
  // (mesma categoria de mecanismo próprio do reteste/deslocamento/tier
  // acima), pedido explícito do usuário, 2026-08-02. Master flag OFF por
  // padrão: exige que o candle 4h que gerou o sinal também mostre um
  // engolfo válido na direção do sinal (src/lib/indicators/candlePatterns.js),
  // ANTES do 15m/5m — não substitui a Range Filter, só exige mais dela.
  // Não ativar sem comparar relatórios de backtest com/sem primeiro.
  candlePatternEnabled: false,
  // Bypassa check15mConfirmation na cascata RF nativa 4h→15m (known-risks.md
  // item 67) — não é do Pine, mas ao contrário dos outros flags acima, o
  // OBJETIVO é bater 1:1 com uma estratégia real que o usuário já opera no
  // TradingView: o Pine dele entra no fechamento do próprio candle 4h, sem
  // nenhuma confirmação de timeframe menor. Master flag OFF por padrão
  // (preserva o comportamento de hoje — mais seguro contra reversão rápida,
  // mas sistematicamente atrasado/perdido vs. o TradingView). Não ativar em
  // produção sem comparar relatórios de backtest com/sem primeiro.
  skip15mConfirmationEnabled: false,
  // docs/known-risks.md item 114/128 — o Pine real do usuário NÃO tem TP2:
  // o runner pós-TP1 só tem trailing, sem segundo alvo fixo.
  // `TP2_HIT` (tp1R×2 hardcoded) é invenção só do Sentinel. Objetivo é o
  // mesmo do skip15mConfirmationEnabled acima: bater 1:1 com a estratégia
  // real, não otimização estatística (item 115 mediu ponto estimado
  // +0,015R, não significativo — mesma situação do skip15m). Master flag
  // OFF por padrão. Quando `true`, o runner só encerra por STOP_HIT/
  // INVALIDATED/CLOSED (Time Stop/Chop Exit), nunca por TP2 — congelado na
  // CRIAÇÃO da operação (`tp2_cap_disabled`), mesmo contrato de
  // runnerEnabled/preTp1StopProtectionEnabled.
  disableTp2CapEnabled: false,
  // NOTA (não é omissão): `rf1hCondEnabled` (Fase 1, docs/known-risks.md
  // item 56 "Fase 1") existe SÓ em scripts/backtestPineConfig.js —
  // deliberadamente NÃO espelhado aqui, ao contrário da convenção padrão
  // acima ("adicione nos dois arquivos"). Esta chave sincroniza com
  // strategyConfig/current no Firestore, gravável por qualquer sessão
  // anônima (sem tela de login, CLAUDE.md decisão item 1) — mirroring
  // criaria um toggle de produção sem gate de revisão. O experimento deve
  // ficar restrito ao motor de backtest. Tripwire test em
  // rf1hCondTripwire.test.js falha se essa chave aparecer aqui.
};

/**
 * Parse Pine Script source code and extract all input parameters.
 * @param {string} code - Pine Script source
 * @returns {Object} parsed config with mapped variable names
 */
export function parsePineScript(code) {
  /** @type {typeof DEFAULTS & { pineVersion?: number, strategyTitle?: string, _hash?: string, _parsedAt?: string }} */
  const config = { ...DEFAULTS };
  if (!code) return config;

  // Match: varName = input.type(...args...) — captures the whole argument
  // list so both positional (input.int(20, title="...")) and named
  // (input.int(defval=20, title="...")) forms can be read; only the first
  // ")" is used as the boundary, so this assumes args don't contain nested
  // parens (true for the int/float/bool/string forms Pine uses here).
  const inputRegex = /(\w+)\s*=\s*input\.(int|float|bool|string)\s*\(([^)]*)\)/g;
  let match;
  while ((match = inputRegex.exec(code)) !== null) {
    const varName = match[1];
    const type = match[2];
    const argsStr = match[3];

    // Named form takes priority regardless of argument order; otherwise
    // fall back to the first positional argument (only valid when that
    // argument isn't itself a `name=value` pair for some other parameter).
    const namedMatch = argsStr.match(/defval\s*=\s*([^,]+)/);
    const firstArg = argsStr.split(',')[0]?.trim();
    const firstArgIsNamed = firstArg ? /^\w+\s*=/.test(firstArg) : true;
    const rawValue = (namedMatch ? namedMatch[1] : (firstArgIsNamed ? undefined : firstArg))?.trim();

    if (rawValue === undefined) continue;

    let value;
    if (type === 'int' || type === 'float') {
      value = parseFloat(rawValue);
      if (isNaN(value)) continue;
      if (type === 'int') value = Math.round(value);
    } else if (type === 'bool') {
      value = rawValue === 'true';
    } else if (type === 'string') {
      value = rawValue.replace(/^["']|["']$/g, '');
    }

    if (varName in DEFAULTS) {
      config[varName] = value;
    }
  }

  // Detect version
  const versionMatch = code.match(/@version=(\d+)/);
  if (versionMatch) config.pineVersion = parseInt(versionMatch[1]);

  // Detect strategy title
  const titleMatch = code.match(/title\s*=\s*"([^"]+)"/);
  if (titleMatch) config.strategyTitle = titleMatch[1];

  // Hash of code for change detection
  config._hash = code.length + '_' + (code.match(/\n/g)?.length || 0);
  config._parsedAt = new Date().toISOString();

  return config;
}

/**
 * Parse and persist Pine config to localStorage.
 * @param {string} code - Pine Script source
 * @returns {Object} parsed config
 */
export function savePineConfig(code) {
  const config = parsePineScript(code);
  localStorage.setItem(PINE_CONFIG_KEY, JSON.stringify(config));
  return config;
}

/**
 * Synchronous, localStorage-only read of the Pine config (no Firestore
 * round-trip) — used for the initial render before the async getPineConfig()
 * resolves, and for local-only comparisons like isPineConfigStale.
 * @returns {Object}
 */
export function getLocalPineConfig() {
  try {
    const stored = localStorage.getItem(PINE_CONFIG_KEY);
    if (stored) return { ...DEFAULTS, ...JSON.parse(stored) };
  } catch (e) {
    logWarn('pineParser', 'Config Pine Script corrompida no localStorage, usando defaults', { error: e.message });
  }
  return { ...DEFAULTS };
}

// Strategy-business parameters that must be identical between the browser
// and the 24/7 cron scan. Kept in Firestore so both sides read the same
// source of truth — see savePineConfig below and scripts/adminPineConfig.js.
//
// emaFastLen/emaSlowLen/rsiLen/volLen/atrLen were added 2026-07-18 (known-risks
// item 27) — they existed in DEFAULTS since the start but were never synced,
// so scanner.js silently used a different, hardcoded fallback (9/21 for EMA)
// instead of the Pine script's real periods (20/50). See
// scanner.js's resolveIndicatorParams for how these combine with the
// (still supported) per-asset override fields.
//
// confirmBars/onlyClosedCandles stay synced but are NOT read by scanner.js:
// onlyClosedCandles is vestigial — the scanner already unconditionally
// filters to closed candles regardless of this flag's value, so wiring in a
// `false` would need to newly support unclosed-candle evaluation (a real
// safety trade-off, not a bugfix); confirmBars would change WHEN a signal
// fires (require N continuation candles), a materially different feature
// from a parameter mismatch — deliberately out of scope here, own round if
// ever implemented.
export const SYNCED_STRATEGY_KEYS = [
  'minScore', 'tp1R', 'tp1QtyPercent', 'trailAtrMult',
  'tier2Threshold', 'tier3Threshold',
  'useADX', 'adxLen', 'adxSmooth', 'useChop', 'chopLen',
  'useTimeStop', 'timeStopT1', 'timeStopT2', 'timeStopT3',
  'useChopExit', 'useInvalidation', 'invalidRFBars', 'invalidScoreMin',
  'confirmBars', 'onlyClosedCandles',
  'emaFastLen', 'emaSlowLen', 'rsiLen', 'volLen', 'atrLen',
  // Cross-cascade arbitration + R:R gate + SMC score weights (Phase 1 —
  // see signalArbitration.js/opExitRules.js/smcConfluence.js)
  'arbEnabled', 'arbPromoteMinScore', 'arbReinforceMinScore',
  'arbInvalidateOnOppositeMajor', 'arbInvalidateOnOppositeSameTf', 'arbOppositeScorePenalty', 'minRR',
  'smcScoreStructureWeight', 'smcScoreChochBonus', 'smcScoreEmaWeight',
  'smcScoreRfWeight', 'smcScoreVolumeWeight', 'smcScoreAlignmentWeight',
  'smcScoreSweepWeight',
  // Runner do TP1 (known-risks item 46)
  'runnerEnabled',
  // Retest confirmation gate (Fase 2 rodada 1 — retest.js)
  'retestEnabled', 'retestToleranceAtrMult', 'retestTouchMode',
  // Displacement candle gate (Fase 2 rodada 2 — displacement.js)
  'displacementEnabled', 'displacementBodyAtrMult', 'displacementMinVolumeRatio',
  // SMC tier/regime gate (Fase 3 — tier.js)
  'smcTierEnabled',
  // Order Block / FVG (Fase 4 — orderBlock.js + fvg.js)
  'smcObFvgEnabled', 'obFvgAtrLen', 'obMinAtrMult', 'obMaxAtrMult',
  'fvgMinAtrMult', 'fvgFillTargetRatio', 'smcScoreObWeight', 'smcScoreFvgWeight',
  // Proteção de stop pré-TP1 (known-risks.md item 53/54) + trailing
  // contínuo (item 132), LIGADO por padrão desde 2026-08-26
  'preTp1StopProtectionEnabled', 'preTp1StopProtectionAtrMult',
  'preTp1TrailEnabled', 'preTp1TrailStartAtrMult', 'preTp1TrailAtrMult',
  // Gate de padrão de vela na cascata RF (candlePatterns.js)
  'candlePatternEnabled',
  // Bypass da confirmação 15m na cascata RF nativa (known-risks.md item 67)
  'skip15mConfirmationEnabled',
  // Desliga o teto de TP2 do runner, trailing puro igual ao Pine real (known-risks.md item 114/128)
  'disableTp2CapEnabled',
];

// Subset of SYNCED_STRATEGY_KEYS that has no `input.*()` counterpart in the
// user's Pine script — parsePineScript() never touches these, so the locally
// parsed config always holds their plain DEFAULTS, never a real edited value.
// Codex review (PR #78): syncPineToAssets() used to write EVERY
// SYNCED_STRATEGY_KEYS value (including these) to strategyConfig/current on
// every Pine Script save. Since StrategyConfig.set() merges (setDoc with
// merge:true), a key simply ABSENT from the write payload is left untouched —
// but these keys WERE present (holding DEFAULTS), so any value an operator
// tuned directly in Firestore (there's no UI for them yet) was silently
// clobbered back to DEFAULTS by the next unrelated Pine save. Excluded from
// the WRITE payload only (see syncPineToAssets below) — still read normally
// via SYNCED_STRATEGY_KEYS in getPineConfig, so both sides keep agreeing on
// whatever IS stored in Firestore.
const NON_PINE_SYNCED_KEYS = new Set([
  'arbEnabled', 'arbPromoteMinScore', 'arbReinforceMinScore',
  'arbInvalidateOnOppositeMajor', 'arbInvalidateOnOppositeSameTf', 'arbOppositeScorePenalty', 'minRR',
  'smcScoreStructureWeight', 'smcScoreChochBonus', 'smcScoreEmaWeight',
  'smcScoreRfWeight', 'smcScoreVolumeWeight', 'smcScoreAlignmentWeight',
  'smcScoreSweepWeight',
  'runnerEnabled',
  'retestEnabled', 'retestToleranceAtrMult', 'retestTouchMode',
  'displacementEnabled', 'displacementBodyAtrMult', 'displacementMinVolumeRatio',
  'smcTierEnabled',
  'smcObFvgEnabled', 'obFvgAtrLen', 'obMinAtrMult', 'obMaxAtrMult',
  'fvgMinAtrMult', 'fvgFillTargetRatio', 'smcScoreObWeight', 'smcScoreFvgWeight',
  'preTp1StopProtectionEnabled', 'preTp1StopProtectionAtrMult',
  'preTp1TrailEnabled', 'preTp1TrailStartAtrMult', 'preTp1TrailAtrMult',
  'candlePatternEnabled',
  'skip15mConfirmationEnabled',
  'disableTp2CapEnabled',
]);

/**
 * Read the current Pine config: merges localStorage (all Pine-parsed
 * values, e.g. rng_per/rng_qty) with the Firestore-synced business
 * parameters (SYNCED_STRATEGY_KEYS above), so the panel and the 24/7 cron
 * never disagree on those. Falls back to defaults if neither source has a
 * value yet.
 * @returns {Promise<Object>}
 */
export async function getPineConfig() {
  let config = { ...DEFAULTS };
  try {
    const stored = localStorage.getItem(PINE_CONFIG_KEY);
    if (stored) config = { ...config, ...JSON.parse(stored) };
  } catch (e) {
    logWarn('pineParser', 'Config Pine Script corrompida no localStorage, usando defaults', { error: e.message });
  }

  try {
    const { backend } = await import('@/api/entities');
    const current = await backend.entities.StrategyConfig.get('current');
    if (current) {
      for (const key of SYNCED_STRATEGY_KEYS) {
        if (current[key] !== undefined) config[key] = current[key];
      }
    }
  } catch (e) {
    logWarn('pineParser', 'Falha ao ler strategyConfig do Firestore, usando localStorage/defaults', { error: e.message });
  }

  return config;
}

/**
 * Check if the stored Pine config differs from the given code.
 * Used to detect if the Pine Script was changed and needs re-sync.
 * @param {string} code - current Pine Script source
 * @returns {boolean} true if config needs to be re-parsed
 */
export function isPineConfigStale(code) {
  const stored = getLocalPineConfig();
  const fresh = parsePineScript(code);
  const keys = Object.keys(DEFAULTS);
  return keys.some(k => stored[k] !== fresh[k]);
}

/**
 * Sync parsed RF parameters (rng_per, rng_qty) to all active assets, and the
 * 4 strategy-business parameters (minScore/tp1R/tp1QtyPercent/trailAtrMult)
 * to strategyConfig/current so the 24/7 cron (scripts/adminPineConfig.js)
 * picks up the same values. Called automatically when Pine Script is saved.
 * @returns {Promise<number>} count of assets updated
 */
export async function syncPineToAssets() {
  const { backend } = await import('@/api/entities');
  const config = getLocalPineConfig();

  try {
    const syncedPayload = {};
    for (const key of SYNCED_STRATEGY_KEYS) {
      if (NON_PINE_SYNCED_KEYS.has(key)) continue;
      syncedPayload[key] = config[key];
    }
    await backend.entities.StrategyConfig.set('current', {
      ...syncedPayload,
      updated_at: new Date().toISOString(),
    });
  } catch (e) {
    logWarn('pineParser', 'Falha ao sincronizar strategyConfig com o Firestore', { error: e.message });
  }

  try {
    const assets = await backend.entities.MonitoredAsset.filter({ is_active: true });
    const toUpdate = assets.filter(
      a => a.rf_period !== config.rng_per || a.rf_multiplier !== config.rng_qty
    );

    await Promise.all(
      toUpdate.map(a =>
        backend.entities.MonitoredAsset.update(a.id, {
          rf_period: config.rng_per,
          rf_multiplier: config.rng_qty,
        })
      )
    );

    return toUpdate.length;
  } catch (e) {
    logWarn('pineParser', 'Falha ao sincronizar parâmetros RF com os ativos monitorados', { error: e.message });
    return 0;
  }
}