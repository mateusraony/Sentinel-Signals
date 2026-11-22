// Entender um relatório de backtest sem ler 30 números (tela Backtest). Funções PURAS: entra o relatório (mesmo formato de buildReport/summarizeOps),
// sai texto. Nada aqui toca motor, scan ou banco. Regra de honestidade do projeto (docs/known-risks.md, itens 44/133): `conclusive` é o juiz — enquanto
// for falso, win rate e profit factor são ruído, e a tela NUNCA conclui "tem vantagem" nem "não tem" a partir de uma amostra inconclusiva.

const num = (v) => typeof v === 'number' && Number.isFinite(v);
const plural = (n, um, varios) => `${n} ${n === 1 ? um : varios}`;
const fmtR = (v, d = 2) => (num(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(d)}R` : '—');

/** Texto da fonte do relatório: de onde vêm as operações e o que isso NÃO quer dizer. */
export const SOURCE_NOTE = Object.freeze({
  real: 'São as operações do próprio painel, e TP/Stop são virtuais: nenhuma ordem foi enviada à corretora.',
  quick: 'Simulação simplificada de 1 ativo e 1 timeframe: serve para explorar rápido, não é o resultado exato do motor.',
  json: 'Replay do motor real sobre dados históricos; o passado não garante o resultado futuro.',
});

/**
 * @param {{ overall: any, costs: any, totalOps?: number, stillOpenAtCutoff?: number }} report
 * @param {'real'|'quick'|'json'} [source]
 * @returns {{ tone: 'inconclusive'|'positive'|'negative'|'empty', headline: string, lines: string[], note: string|null }}
 */
export function explainReport(report, source) {
  const overall = report?.overall ?? {};
  const costs = report?.costs ?? {};
  const n = num(costs.countedTrades) ? costs.countedTrades : (num(overall.counted) ? overall.counted : 0);
  const note = SOURCE_NOTE[source] ?? null;
  if (n === 0) {
    return { tone: 'empty', headline: 'Ainda não há operações fechadas para medir.', lines: [], note };
  }

  const net = overall.expectancyR;
  const gross = overall.grossExpectancyR;
  const lines = [];
  const ci = Array.isArray(overall.expectancyRCI95) && overall.expectancyRCI95.length === 2 && overall.expectancyRCI95.every(num) ? overall.expectancyRCI95 : null;

  /** @type {'inconclusive'|'positive'|'negative'} */
  let tone;
  let headline;
  if (costs.conclusive) {
    tone = num(net) && net >= 0 ? 'positive' : 'negative';
    headline = tone === 'positive'
      ? 'Amostra suficiente e resultado positivo depois dos custos.'
      : 'Amostra suficiente e resultado negativo depois dos custos.';
    lines.push(`Média de ${fmtR(net)} por operação${ci ? ` (intervalo de confiança de ${fmtR(ci[0])} a ${fmtR(ci[1])}, que não cruza zero)` : ''}.`);
  } else {
    tone = 'inconclusive';
    headline = 'Ainda não dá para dizer se a estratégia tem vantagem.';
    if (costs.inconclusiveReason === 'sample_too_small') {
      lines.push(`Amostra pequena: ${plural(n, 'operação', 'operações')} (o mínimo para tirar conclusão é ${costs.minTrades ?? overall.minTrades ?? '—'}). Taxa de acerto e profit factor ainda são ruído.`);
    } else if (costs.inconclusiveReason === 'ci_straddles_zero') {
      lines.push(`Com ${plural(n, 'operação', 'operações')} a média por operação (${fmtR(net)}) não se distingue de zero${ci ? `: o intervalo de confiança vai de ${fmtR(ci[0])} a ${fmtR(ci[1])}` : ''}.`);
    } else if (costs.inconclusiveReason === 'no_r_samples') {
      lines.push('Não há operações com R calculável (sem risco inicial definido), então não dá para medir a expectância.');
    } else if (costs.inconclusiveReason) {
      lines.push(`Resultado inconclusivo (${costs.inconclusiveReason}).`);
    }
  }

  if (num(costs.avgCostR) && num(gross) && num(net)) {
    let c = `Os custos (taxa, slippage e funding) tiraram ${fmtR(costs.avgCostR)} por operação: de ${fmtR(gross)} bruto para ${fmtR(net)} líquido.`;
    if (gross > 0 && net <= 0) c += ' Os custos transformaram um resultado bruto positivo em negativo.';
    lines.push(c);
  }

  if (num(overall.avgWinR) && num(overall.avgLossR)) {
    lines.push(`${plural(overall.wins ?? 0, 'vitória', 'vitórias')}, ${plural(overall.losses ?? 0, 'derrota', 'derrotas')} e ${plural(overall.be ?? 0, 'empate', 'empates')}. Cada vitória rendeu em média ${fmtR(overall.avgWinR)} e cada derrota custou ${fmtR(Math.abs(overall.avgLossR))}.`);
  }

  if ((report?.stillOpenAtCutoff ?? 0) > 0) {
    lines.push(`${report.stillOpenAtCutoff} operação(ões) ainda aberta(s) não entram na conta.`);
  }

  return { tone, headline, lines, note };
}

// Motivos que o funil de entrada grava (scanner.js: entryFunnelOutcomes/last_rejection_reason). Só entram os que o código documenta; o resto aparece com o código cru.
export const REASON_LABEL = Object.freeze({
  active_op_exists: 'o ativo já tinha uma operação aberta',
  regime_rejected: 'mercado fraco ou lateral (filtros ADX/Choppiness)',
  confirmation_15m_not_aligned: 'a confirmação de 15 min não veio na mesma direção',
  not_aligned: 'a confirmação de 15 min não veio na mesma direção',
  trend_reversed: 'a tendência já não apontava na direção do sinal',
  no_trigger: 'o gatilho de 5 min não disparou',
  wrong_direction_trigger: 'o gatilho disparou só no lado oposto',
  insufficient_data: 'poucos candles para avaliar',
  fetch_error: 'falha ao buscar os candles',
  ote_zone_unfavorable: 'o gatilho disparou fora da zona favorável',
  candle_pattern_rejected: 'o candle do sinal não tinha um padrão válido',
  retest_pending: 'esperando o preço voltar ao nível (reteste)',
  displacement_gate_rejected: 'o candle de deslocamento não passou no filtro',
});

export const reasonLabel = (code) => REASON_LABEL[code] ?? null;

/**
 * O que mudaria ao aplicar o trial ao scanner ao vivo: compara, chave a chave, o que `doApply` grava (config do trial, com DEFAULTS para chave ausente)
 * com a configuração atual. `liveConfig` null = não foi possível ler (a tela não afirma nada).
 * @returns {Array<{ key: string, from: any, to: any }> | null}
 */
export function diffAppliedConfig(trialConfig, liveConfig, keys, defaults) {
  if (!trialConfig || !liveConfig) return null;
  const out = [];
  for (const key of keys) {
    const to = trialConfig[key] !== undefined ? trialConfig[key] : defaults[key];
    const from = liveConfig[key];
    if (JSON.stringify(to) !== JSON.stringify(from)) out.push({ key, from, to });
  }
  return out;
}
