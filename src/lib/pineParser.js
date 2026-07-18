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

const DEFAULTS = {
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
};

/**
 * Parse Pine Script source code and extract all input parameters.
 * @param {string} code - Pine Script source
 * @returns {Object} parsed config with mapped variable names
 */
export function parsePineScript(code) {
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
const SYNCED_STRATEGY_KEYS = [
  'minScore', 'tp1R', 'tp1QtyPercent', 'trailAtrMult',
  'tier2Threshold', 'tier3Threshold',
  'useADX', 'adxLen', 'adxSmooth', 'useChop', 'chopLen',
  'useTimeStop', 'timeStopT1', 'timeStopT2', 'timeStopT3',
  'useChopExit', 'useInvalidation', 'invalidRFBars', 'invalidScoreMin',
  'confirmBars', 'onlyClosedCandles',
  'emaFastLen', 'emaSlowLen', 'rsiLen', 'volLen', 'atrLen',
];

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
    for (const key of SYNCED_STRATEGY_KEYS) syncedPayload[key] = config[key];
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