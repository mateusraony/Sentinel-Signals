/**
 * SMC Confluence Engine — score 0-100 for the 1h→5m cascade, mirroring
 * indicators/confluence.js's role for the 4h→15m (Range Filter) cascade.
 * Before this, the SMC cascade always persisted `score: 0` (buildSmcTradeOpData
 * read `sig.context?.score`, which no code path ever set) — there was no way
 * to compare an SMC candidate's strength against an RF candidate's for
 * cross-cascade arbitration (src/lib/signalArbitration.js).
 *
 * Weights default to sum 100 but are configurable via strategyConfig so the
 * two cascades can be tuned/backtested independently.
 *
 * This score is ADVISORY ONLY — it feeds arbitration and audit trails, it
 * does NOT gate SMC signal emission. Making it an emission gate would reopen
 * the tautological-rejection history documented in docs/known-risks.md items
 * 34/35/38 (changing which SignalEvents fire needs its own backtest-informed
 * decision, not a side effect of adding a score).
 */

export const SMC_SCORE_DEFAULTS = {
  structureWeight: 15,
  chochBonus: 10,
  emaWeight: 20,
  rfWeight: 15,
  volumeWeight: 15,
  alignmentWeight: 15,
  sweepWeight: 10,
  // Fase 4 (docs/known-risks.md item 43) — Order Block / Fair Value Gap.
  // Nascem em 0 DE PROPÓSITO, não por esquecimento: os 7 pesos acima já somam
  // exatamente 100 e o score termina em Math.min(100, ...), então qualquer
  // peso novo sem redistribuir comprime o topo da distribuição — e este score
  // JÁ é consumido em produção pelos limiares de arbitragem da Fase 1
  // (arbPromoteMinScore: 75, arbReinforceMinScore: 50). Com peso 0, ligar
  // pineConfig.smcObFvgEnabled dá medição pura (campos de auditoria + a seção
  // do backtest) com score byte-idêntico; subir o peso, redistribuindo os
  // demais para somar 100, é uma segunda decisão deliberada, informada pelo
  // backtest — mesma cultura "medir antes de ativar" dos itens 40/41/42.
  obWeight: 0,
  fvgWeight: 0,
};

/**
 * @param {Object} params
 * @param {'BOS'|'CHoCH'} params.structureType
 * @param {'BUY'|'SELL'} params.signalType
 * @param {number} [params.rf1hDirection] - 1h Range Filter direction (-1|0|1)
 * @param {string} [params.emaTrend] - 'bullish'|'bearish'|'neutral'
 * @param {{current:number, ma:number}|null} [params.volumeData]
 * @param {Object|null} [params.alignmentResult] - analyzeAlignment() result
 * @param {string|null} [params.pdZone] - 'premium'|'discount'|'equilibrium'
 * @param {boolean|null} [params.sweepConfirmed] - null at 1h signal emission
 *   (not known yet), boolean once the 5m confirmation trigger resolves.
 * @param {boolean|null} [params.obActive] - Fase 4: preço dentro de um Order
 *   Block válido na direção do sinal. null quando pineConfig.smcObFvgEnabled
 *   está desligado (não avaliado), diferente de false (avaliado, não ativo).
 * @param {boolean|null} [params.fvgActive] - Fase 4: existe um Fair Value Gap
 *   não preenchido na direção do sinal. Mesma convenção null/false acima.
 * @param {Object} [params.weights] - partial override of SMC_SCORE_DEFAULTS
 * @returns {{score:number, strength:string, priority:string, reasons:string[], pdZone:string|null}}
 */
export function calculateSmcSignalStrength({
  structureType,
  signalType,
  rf1hDirection = 0,
  emaTrend = 'neutral',
  volumeData = null,
  alignmentResult = null,
  pdZone = null,
  sweepConfirmed = null,
  obActive = null,
  fvgActive = null,
  weights = {},
}) {
  // Merged per-key with `??` (not object spread) — a caller passing
  // `{ structureWeight: undefined }` (e.g. an unset strategyConfig key) must
  // fall back to the default, not silently zero the component.
  const w = {
    structureWeight: weights.structureWeight ?? SMC_SCORE_DEFAULTS.structureWeight,
    chochBonus: weights.chochBonus ?? SMC_SCORE_DEFAULTS.chochBonus,
    emaWeight: weights.emaWeight ?? SMC_SCORE_DEFAULTS.emaWeight,
    rfWeight: weights.rfWeight ?? SMC_SCORE_DEFAULTS.rfWeight,
    volumeWeight: weights.volumeWeight ?? SMC_SCORE_DEFAULTS.volumeWeight,
    alignmentWeight: weights.alignmentWeight ?? SMC_SCORE_DEFAULTS.alignmentWeight,
    sweepWeight: weights.sweepWeight ?? SMC_SCORE_DEFAULTS.sweepWeight,
    obWeight: weights.obWeight ?? SMC_SCORE_DEFAULTS.obWeight,
    fvgWeight: weights.fvgWeight ?? SMC_SCORE_DEFAULTS.fvgWeight,
  };

  const isBuy = signalType === 'BUY';
  const isSell = signalType === 'SELL';
  const reasons = [];

  // Structure base — a fresh BOS/CHoCH IS the signal itself; CHoCH (trend
  // change) is a stronger structural event than BOS (continuation).
  let score = w.structureWeight;
  reasons.push(`Estrutura 1H: ${structureType} (+${w.structureWeight})`);
  if (structureType === 'CHoCH') {
    score += w.chochBonus;
    reasons.push(`Bônus CHoCH (+${w.chochBonus})`);
  }

  // EMA trend aligned with signal direction
  if ((isBuy && emaTrend === 'bullish') || (isSell && emaTrend === 'bearish')) {
    score += w.emaWeight;
    reasons.push(`EMA alinhada (+${w.emaWeight})`);
  }

  // 1h Range Filter direction aligned with signal direction
  if ((isBuy && rf1hDirection === 1) || (isSell && rf1hDirection === -1)) {
    score += w.rfWeight;
    reasons.push(`Range Filter 1H alinhado (+${w.rfWeight})`);
  }

  // Volume above its own moving average (same convention as confluence.js)
  if (volumeData && volumeData.current > volumeData.ma) {
    score += w.volumeWeight;
    reasons.push(`Volume acima da média (+${w.volumeWeight})`);
  }

  // Multi-timeframe (1d/4h/1h) alignment toward the signal direction — full
  // credit when fully aligned, half when only partially aligned.
  const wantDirection = isBuy ? 'bullish' : 'bearish';
  if (alignmentResult?.alignment === 'aligned' && alignmentResult.direction === wantDirection) {
    score += w.alignmentWeight;
    reasons.push(`Alinhamento multi-timeframe completo (+${w.alignmentWeight})`);
  } else if (alignmentResult?.alignment === 'partially_aligned' && alignmentResult.direction === wantDirection) {
    const partial = w.alignmentWeight / 2;
    score += partial;
    reasons.push(`Alinhamento multi-timeframe parcial (+${partial})`);
  }

  // 5m liquidity sweep trigger — only resolved at op-creation time.
  if (sweepConfirmed === true) {
    score += w.sweepWeight;
    reasons.push(`Sweep de liquidez confirmado no 5m (+${w.sweepWeight})`);
  }

  // Order Block / FVG (Fase 4) — dois componentes independentes, espelhando o
  // Pine real do usuário, que conta ob_*_active e fvg_*_active como 2 dos 7
  // pontos do seu próprio Confluence Score. Com os pesos no default (0) estes
  // dois blocos são no-ops aritméticos e nem entram em `reasons` — o score
  // fica byte-idêntico ao de antes da Fase 4.
  if (obActive === true && w.obWeight > 0) {
    score += w.obWeight;
    reasons.push(`Preço dentro de Order Block (+${w.obWeight})`);
  }
  if (fvgActive === true && w.fvgWeight > 0) {
    score += w.fvgWeight;
    reasons.push(`Fair Value Gap não preenchido a favor (+${w.fvgWeight})`);
  }

  score = Math.min(100, Math.round(score));

  let strength, priority;
  if (score >= 70) {
    strength = 'strong'; priority = 'high';
  } else if (score >= 40) {
    strength = 'moderate'; priority = 'medium';
  } else {
    strength = 'weak'; priority = 'low';
  }

  return { score, strength, priority, reasons, pdZone };
}
