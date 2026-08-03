// Shadow-mode counterpart to src/lib/pineParser.js's getPineConfig() — Fase 1
// modo sombra prospectivo (docs/known-risks.md item 56 "Modo sombra"). Reuses
// scripts/adminPineConfig.js's real getPineConfig() UNMODIFIED (same read of
// strategyConfig/current + the same DEFAULTS — same tp1R/tier table/ADX/Chop
// thresholds the real 24/7 scan uses today) and overrides exactly one key on
// top: rf1hCondEnabled: true.
//
// This is deliberately the ONLY place in the whole project where that flag
// is forced on outside of a test/backtest file — pineParser.js (browser) and
// adminPineConfig.js (cron) never define it (see rf1hCondTripwire.test.js),
// so this override can never collide with, or be confused for, a real
// strategyConfig/current value.
import { getPineConfig as getRealPineConfig } from './adminPineConfig.js';

export async function getPineConfig() {
  const real = await getRealPineConfig();
  return { ...real, rf1hCondEnabled: true };
}
