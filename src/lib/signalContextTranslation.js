/**
 * Auditoria do Telegram (2026-09-29), Fase 2 item 2.8 — traduz o
 * `SignalEvent.context` (docs/schema-reference/SignalEvent.jsonc) em pares
 * { label, value, direction } legíveis, pra mostrar ANTES do JSON bruto na
 * página Alertas (que continua existindo, atrás de "ver contexto técnico").
 *
 * `direction` (1/-1/0/null) é devolvido separado do texto pra quem for
 * renderizar poder reusar `DirectionIndicator.jsx` (mesma convenção já usada
 * em todo o painel) em vez de reinventar seta/cor aqui — este módulo é puro,
 * sem JSX.
 *
 * Regra do resto do plano vale aqui também: campo ausente/desconhecido é
 * OMITIDO, nunca vira "0" ou um texto inventado.
 */
const RSI_OVERBOUGHT = 70;
const RSI_OVERSOLD = 30;

function rsiZoneLabel(rsi) {
  if (!Number.isFinite(rsi)) return null;
  if (rsi >= RSI_OVERBOUGHT) return 'sobrecompra';
  if (rsi <= RSI_OVERSOLD) return 'sobrevenda';
  return 'zona neutra';
}

const PD_ZONE_LABEL = { premium: 'premium', discount: 'discount', equilibrium: 'equilíbrio' };

/**
 * @param {object} context - SignalEvent.context
 * @returns {Array<{ label: string, value: string, direction?: number|null }>}
 */
export function translateSignalContext(context) {
  if (!context || typeof context !== 'object') return [];
  const rows = [];

  if (context.rf_direction === 1 || context.rf_direction === -1) {
    rows.push({ label: 'Range Filter', value: context.rf_direction === 1 ? 'comprador' : 'vendedor', direction: context.rf_direction });
  }
  if (context.tf_4h_direction === 1 || context.tf_4h_direction === -1) {
    rows.push({ label: 'Tendência 4h', value: context.tf_4h_direction === 1 ? 'alta' : 'baixa', direction: context.tf_4h_direction });
  }
  if (context.tf_1d_direction === 1 || context.tf_1d_direction === -1) {
    rows.push({ label: 'Tendência 1d', value: context.tf_1d_direction === 1 ? 'alta' : 'baixa', direction: context.tf_1d_direction });
  }
  if (context.tf_1h_direction === 1 || context.tf_1h_direction === -1) {
    rows.push({ label: 'Tendência 1h', value: context.tf_1h_direction === 1 ? 'alta' : 'baixa', direction: context.tf_1h_direction });
  }
  if (Number.isFinite(context.rsi)) {
    const zona = rsiZoneLabel(context.rsi);
    rows.push({ label: 'RSI', value: zona ? `${context.rsi.toFixed(0)} — ${zona}` : context.rsi.toFixed(0) });
  }
  // Codex review (PR #447) — histograma exatamente 0 (raro, ponto de
  // cruzamento) não é nem positivo nem negativo; mesmo raciocínio de
  // "omitir em vez de inventar" já usado nos campos de direção acima
  // (rf_direction/tf_x_direction === 0 também não vira linha nenhuma).
  if (Number.isFinite(context.macd_histogram) && context.macd_histogram !== 0) {
    const positivo = context.macd_histogram > 0;
    rows.push({ label: 'MACD', value: positivo ? 'positivo' : 'negativo', direction: positivo ? 1 : -1 });
  }
  // Campos só de sinal SMC (smc_structure) — ausentes em RF/MACD/EMA/RSI.
  if (context.structure_type) {
    rows.push({ label: 'Estrutura', value: context.structure_type === 'BOS' ? 'rompimento de estrutura (BOS)' : 'mudança de caráter (CHoCH)' });
  }
  if (context.pd_zone && PD_ZONE_LABEL[context.pd_zone]) {
    rows.push({ label: 'Zona', value: PD_ZONE_LABEL[context.pd_zone] });
  }

  return rows;
}
