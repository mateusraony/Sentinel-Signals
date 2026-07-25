// Order Block (OB) — Fase 4 (docs/known-risks.md item 43).
//
// APROXIMAÇÃO GEOMÉTRICA DELIBERADA, não porte fiel — e parte da diferença é
// IMPOSSÍVEL de fechar, não questão de esforço: o `track_obs` do Pine real do
// usuário roda com `align_edge_to_value_area=true`/`align_break_price_to_poc=true`,
// ou seja, as bordas do bloco e o nível de invalidação (`break_price`) vêm de um
// PERFIL DE VOLUME (VAH/VAL/POC) calculado pela biblioteca externa
// `robbatt/lib_profile/44`, cujo código não existe neste repositório. Também
// não são portados: a máquina de estados trailing→extending→awaiting_confirmation
// (o Pine rastreia candidatos barra a barra com estado `var`, incompatível com o
// scanner, que recalcula tudo do zero a cada passada), as 5 vias alternativas de
// confirmação, `soft_confirm`, `has_fvg_out`, `is_bac`, e os arrays
// `tracking_blocks_*`/`broken_blocks_*`.
//
// O que É portado: a definição mainstream de OB ("última vela contrária antes do
// impulso que rompe estrutura" — confirmada por pesquisa de comunidade como a
// leitura consensual) e os múltiplos de ATR do filtro de tamanho do próprio Pine
// do usuário (`ob_thresh_min = ATR(50)*0.5`, `ob_thresh_max = ATR(50)*2.5`) —
// não há convenção numérica comunitária pra isso, então o valor do script real
// é a única âncora defensável.
//
// Consequência registrada: esta função NÃO é candidata a golden test contra o
// TradingView (diferente de BOS/CHoCH/sweep/PD, que são porte fiel) — ver
// .claude/rules/pine-parity.md. Puro, sem I/O, sem estado entre chamadas.

/**
 * Localiza o Order Block da direção pedida, ancorado no rompimento de estrutura
 * da ÚLTIMA vela fechada.
 *
 * Pré-condição de uso (garantida pelo chamador em scanner.js): só faz sentido
 * chamar quando `calculateStructure` acabou de reportar BOS/CHoCH — o
 * `lastBull`/`lastBear` daquela função se refere sempre à última barra fechada
 * (`smcStructure.js`, `const last = n - 1`), então a vela de rompimento é
 * `candles[n-1]` e não é preciso varrer a série de eventos.
 *
 * @param {Array<{open:number,high:number,low:number,close:number}>} candles
 * @param {Object} params
 * @param {'BUY'|'SELL'} params.direction - direção do rompimento
 * @param {number} params.atrValue - ATR já calculado pelo chamador (ATR(50) na
 *   configuração real do Pine), mesma convenção de retest.js/displacement.js
 * @param {number} [params.minAtrMult=0.5] - `ob_thresh_min` do Pine
 * @param {number} [params.maxAtrMult=2.5] - `ob_thresh_max` do Pine
 * @param {number} [params.maxLookback=20] - quantas velas para trás procurar a
 *   vela contrária antes de desistir
 * @returns {{active:boolean, zoneHigh:number|null, zoneLow:number|null,
 *   zoneSize:number|null, barsAgo:number|null, reason:string|null}}
 */
export function detectOrderBlock(candles, { direction, atrValue, minAtrMult = 0.5, maxAtrMult = 2.5, maxLookback = 20 }) {
  const none = { active: false, zoneHigh: null, zoneLow: null, zoneSize: null, barsAgo: null, reason: null };

  if (direction !== 'BUY' && direction !== 'SELL') return { ...none, reason: 'invalid_params' };
  if (atrValue == null || !(atrValue > 0)) return { ...none, reason: 'invalid_params' };
  if (minAtrMult == null || maxAtrMult == null || minAtrMult < 0 || maxAtrMult < minAtrMult) {
    return { ...none, reason: 'invalid_params' };
  }
  if (!Array.isArray(candles) || candles.length < 2) return { ...none, reason: 'no_candles' };

  const n = candles.length;
  const isBuy = direction === 'BUY';
  const oldest = Math.max(0, n - 1 - maxLookback);

  // Última vela de cor CONTRÁRIA ao rompimento, antes da vela que rompeu.
  let obIndex = -1;
  for (let i = n - 2; i >= oldest; i--) {
    const c = candles[i];
    if (isBuy ? c.close < c.open : c.close > c.open) {
      obIndex = i;
      break;
    }
  }
  if (obIndex === -1) return { ...none, reason: 'no_opposing_candle' };

  const ob = candles[obIndex];
  const zoneHigh = ob.high;
  const zoneLow = ob.low;
  const zoneSize = zoneHigh - zoneLow;

  // Filtro de tamanho — mesmos múltiplos do Pine real (`M.in_range` na
  // confirmação lá, aqui uma checagem geométrica única).
  if (zoneSize < atrValue * minAtrMult || zoneSize > atrValue * maxAtrMult) {
    return { ...none, zoneHigh, zoneLow, zoneSize, barsAgo: n - 1 - obIndex, reason: 'size_out_of_range' };
  }

  // Invalidação SIMPLIFICADA (não é o `update_broken` do Pine, que usa
  // break_price = ponto médio ou POC do perfil de volume, com toggle
  // wick/close): qualquer vela após a formação que tenha FECHADO inteiramente
  // além da zona no sentido contrário ao rompimento mata o bloco.
  for (let j = obIndex + 1; j < n; j++) {
    if (isBuy ? candles[j].close < zoneLow : candles[j].close > zoneHigh) {
      return { ...none, zoneHigh, zoneLow, zoneSize, barsAgo: n - 1 - obIndex, reason: 'invalidated' };
    }
  }

  // "Ativo" = o preço atual está DENTRO da zona — checagem idêntica à do
  // #region CONFLUENCE SCORE do Pine (`close >= right_bottom and close <= left_top`).
  const lastClose = candles[n - 1].close;
  const inZone = lastClose >= zoneLow && lastClose <= zoneHigh;

  return {
    active: inZone,
    zoneHigh,
    zoneLow,
    zoneSize,
    barsAgo: n - 1 - obIndex,
    reason: inZone ? null : 'price_outside_zone',
  };
}
