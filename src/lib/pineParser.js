/**
 * Pine Script Parser — extracts input parameters from Pine v6 code
 * and syncs them to the scanner engine automatically.
 *
 * When the user edits the Pine Script in the editor, this parser
 * extracts all input.* declarations and stores them. The scanner
 * reads from this config on every scan, so changes to the Pine
 * Script are reflected automatically — no manual bot changes needed.
 */

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
  strategyTitle: 'NEW ERA - Range Filter Strategy v12',
};

/**
 * Parse Pine Script source code and extract all input parameters.
 * @param {string} code - Pine Script source
 * @returns {Object} parsed config with mapped variable names
 */
export function parsePineScript(code) {
  const config = { ...DEFAULTS };
  if (!code) return config;

  // Match: varName = input.type(value, ...
  const inputRegex = /(\w+)\s*=\s*input\.(int|float|bool|string)\s*\(\s*([^,)\n]+)/g;
  let match;
  while ((match = inputRegex.exec(code)) !== null) {
    const varName = match[1];
    const type = match[2];
    const rawValue = match[3].trim();

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
 * Read the current Pine config from localStorage.
 * Falls back to defaults if not yet parsed.
 * Called by the scanner on every scan to get fresh values.
 * @returns {Object}
 */
export function getPineConfig() {
  try {
    const stored = localStorage.getItem(PINE_CONFIG_KEY);
    if (stored) return { ...DEFAULTS, ...JSON.parse(stored) };
  } catch { /* ignore */ }
  return { ...DEFAULTS };
}

/**
 * Check if the stored Pine config differs from the given code.
 * Used to detect if the Pine Script was changed and needs re-sync.
 * @param {string} code - current Pine Script source
 * @returns {boolean} true if config needs to be re-parsed
 */
export function isPineConfigStale(code) {
  const stored = getPineConfig();
  const fresh = parsePineScript(code);
  const keys = Object.keys(DEFAULTS);
  return keys.some(k => stored[k] !== fresh[k]);
}

/**
 * Sync parsed RF parameters (rng_per, rng_qty) to all active assets.
 * Called automatically when Pine Script is saved.
 * @returns {Promise<number>} count of assets updated
 */
export async function syncPineToAssets() {
  const { backend } = await import('@/api/entities');
  const config = getPineConfig();

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
  } catch {
    return 0;
  }
}