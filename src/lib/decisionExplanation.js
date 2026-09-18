/**
 * Fase 1 — Explainability V2. Camada única de explicação: dado um SignalEvent
 * (com ou sem `decision_snapshot`), produz um objeto pronto para Dashboard,
 * Telegram e Histórico traduzirem, sem cada tela deduzir por conta própria.
 *
 * Não reescreve `src/lib/signalStatus.js` — COMPÕE com ele. `rejectionCopy()`
 * já resolve `headline`/`why` de forma fail-closed (chave ausente, motivo
 * desconhecido, sinal expirado sem motivo salvo — nunca lança, nunca inventa).
 * O que este módulo adiciona é `evidence`: os fatos numéricos de
 * `decision_snapshot.facts` (src/lib/decisionSnapshot.js), que hoje só
 * `SignalEvent`s rejeitados por `regime_rejected`/`trend_reversed` carregam.
 *
 * Contrato fail-closed: entidade sem `decision_snapshot` (sinal legado, ou
 * rejeitado por um motivo que esta fase ainda não instrumenta) devolve
 * `evidence: null` — nunca um valor calculado on-the-fly nem um texto que
 * pareça mais preciso do que os dados registrados permitem.
 *
 * Fase 3 — Explainability V2 estende este módulo com `explainOperationDecision`
 * para `TradeOperation` ativa (HOLDING/PROTECTED). Fase 4 estende o mesmo
 * `OPERATION_COPY`/`formatOperationEvidence` para EXIT (STOP_HIT/TP2_HIT/
 * INVALIDATED/CLOSED, automático ou manual) — ver docs/known-risks.md.
 *
 * Módulo puro: sem React, sem I/O, sem Firestore.
 */

// Extensão .js explícita — este módulo agora também é alcançado por
// scripts/adminTelegram.js (Fase 4), que scripts/health-audit.mjs importa
// via Node ESM NATIVO (sem passar pelo esbuild de scripts/build-scan.mjs,
// que resolve extensão sozinho). Sem a extensão, `node scripts/health-audit.mjs`
// quebra com ERR_MODULE_NOT_FOUND antes de rodar qualquer checagem —
// achado de revisão (Codex, PR #376).
import { rejectionCopy, classifySignal } from './signalStatus.js';
import { formatPrice } from './priceProximity.js';

const NOTHING_TO_DO = 'Nada a fazer — o app continua verificando sozinho.';

// Osciladores/contagens de barra (ADX, Chop, bars_open etc.) — arredondamento
// fixo de 1 casa é correto aqui (escala 0-100 ou inteiro), NUNCA usar para
// preço/distância de preço (ver formatPriceNum abaixo).
function formatNum(value) {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

// Fatos em escala de PREÇO do ativo (distâncias, stop/tp, deltas assinados —
// ver src/lib/decisionSnapshot.js's signedMove()). `formatNum` acima esmaga
// esses valores em 1 casa fixa: correto para BTC (~65000), destrutivo para um
// ativo sub-$1 (ex.: ETHFI ~0.69 vira "0.7"). Reusa a escala adaptativa já em
// produção nos chips STOP/ENTRADA/TP1/TP2 (`formatPrice`,
// src/lib/priceProximity.js) — mesma fonte de verdade, sem duplicar limiares.
// Contrato diferente de propósito: `formatPrice` nunca devolve `null` (usa
// '—' para entrada inválida); aqui preservamos o `null` de `formatNum`
// porque os call-sites abaixo dependem dele para omitir a frase inteira.
function formatPriceNum(value) {
  if (!Number.isFinite(value)) return null;
  return formatPrice(value);
}

function directionLabel(dir) {
  if (dir === 1) return 'compra';
  if (dir === -1) return 'venda';
  return 'indefinida';
}

// Achado de revisão independente (2026-09-17): `decision_snapshot` só é
// regravado quando algo mais já ia gravar mesmo (write-on-change em
// SignalEvent; carona nas escritas de mfe_r/current_stop em TradeOperation —
// ver docs/known-risks.md itens 181/182). Isso significa que um snapshot com
// `data_status: 'LIVE'` pode estar descrevendo uma avaliação de várias
// passadas atrás, sem nenhum sinal visual disso. Em vez de tentar adivinhar
// um limiar de "desatualizado" (que varia por timeframe — 4h vs 1h — e por
// isso seria fácil de errar), expõe o horário em que os fatos foram medidos
// e deixa o usuário julgar. Sem `moment` de propósito — este módulo é
// dependency-free, mesmo padrão de src/lib/opExitRules.js.
function formatMeasuredAt(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  const hh = String(brt.getUTCHours()).padStart(2, '0');
  const mm = String(brt.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

function withMeasuredAt(evidence, snapshot) {
  if (!evidence) return evidence;
  const time = formatMeasuredAt(snapshot?.evaluated_at);
  return time ? `${evidence} (medido às ${time} BRT)` : evidence;
}

/**
 * Formata `decision_snapshot.facts` numa frase curta, por `reason_code`.
 * Só os dois reason_codes que `decisionSnapshot.js` já produz nesta fase —
 * um reason_code sem formatador conhecido (ou fatos incompletos) devolve
 * `null`, nunca um texto genérico fingindo evidência.
 *
 * `currentReasonCode` é o motivo categórico ATUAL do sinal
 * (`signal.last_rejection_reason`) — `recordRejection()` (scanner.js) só
 * grava `decision_snapshot` nos motivos regime_rejected/trend_reversed; os
 * outros ~8 motivos (candle_pattern_rejected, retest_pending, etc.) mudam
 * `last_rejection_reason` via write-on-change SEM tocar `decision_snapshot`,
 * que fica com o valor da última vez que um desses dois motivos esteve
 * ativo. Sem este guard, a evidência numérica podia descrever um motivo já
 * resolvido enquanto o chip/frase acima já mostra o motivo atual — achado
 * de revisão independente (`sentinel-trading-engine-review` + `code-review`,
 * 2026-09-17), não hipotético.
 */
function formatEvidence(snapshot, currentReasonCode) {
  if (!snapshot || snapshot.data_status === 'UNKNOWN') return null;
  if (currentReasonCode && snapshot.reason_code !== currentReasonCode) return null;
  const { reason_code: reasonCode, facts = {} } = snapshot;

  if (reasonCode === 'regime_rejected') {
    const parts = [];
    const adx = formatNum(facts.adx);
    const adxMin = formatNum(facts.adx_min);
    if (adx != null) parts.push(`força do movimento (ADX) ${adx}${adxMin != null ? ` — mínimo exigido ${adxMin}` : ''}`);
    const chop = formatNum(facts.chop);
    const chopMax = formatNum(facts.chop_max);
    if (chop != null) parts.push(`lateralização (Chop) ${chop}${chopMax != null ? ` — máximo permitido ${chopMax}` : ''}`);
    if (!parts.length) return null;
    return `Medido: ${parts.join(' · ')}.`;
  }

  if (reasonCode === 'trend_reversed') {
    if (!Number.isFinite(facts.current_direction) || !Number.isFinite(facts.signal_direction)) return null;
    return `Medido: tendência atual aponta para ${directionLabel(facts.current_direction)}; o aviso era de ${directionLabel(facts.signal_direction)}.`;
  }

  return null;
}

function warningsFor(snapshot) {
  if (!snapshot) return [];
  if (snapshot.data_status === 'UNKNOWN') {
    return ['Os números desta avaliação não estavam disponíveis no momento — o motivo categórico acima continua válido.'];
  }
  if (snapshot.data_status === 'STALE') {
    return ['Os números abaixo podem estar desatualizados.'];
  }
  return [];
}

/**
 * @param {object} signal  SignalEvent completo (com ou sem decision_snapshot)
 * @param {object} [ctx]   { now } — injetável para teste; usado só para a fase
 * @returns {{
 *   headline: string, why: string, evidence: string|null, missing: null,
 *   nextStep: null, userAction: string, warnings: string[], technical: object|null,
 * }}
 */
export function explainDecision(signal, ctx = {}) {
  const phase = classifySignal(signal, ctx.now ?? Date.now()).phase;
  const copy = rejectionCopy(signal, phase);
  const snapshot = signal?.decision_snapshot ?? null;
  return {
    headline: copy.chip,
    why: copy.detail,
    evidence: withMeasuredAt(formatEvidence(snapshot, signal?.last_rejection_reason ?? null), snapshot),
    missing: null,
    nextStep: null,
    userAction: NOTHING_TO_DO,
    warnings: warningsFor(snapshot),
    technical: snapshot,
  };
}

/**
 * Fase 3 — texto por `reason_code` de gestão de `TradeOperation` ativa. Não
 * existe hoje nenhum equivalente categórico (diferente de `SignalEvent`, que
 * já tinha `rejectionCopy()`) — este é o texto novo desta fase, no mesmo tom
 * de `signalStatus.js`: título curto, "por quê" em uma frase, `userAction`
 * sempre "nada a fazer" (a gestão é 100% automática).
 */
const OPERATION_COPY = Object.freeze({
  awaiting_tp1: {
    headline: 'Monitorando',
    why: 'Nenhuma condição de saída foi atingida. A proteção de stop desta operação ainda não está ativa nesta passada.',
  },
  pre_tp1_protection_armed_not_triggered: {
    headline: 'Monitorando — proteção armada',
    why: 'Nenhuma condição de saída foi atingida. O preço ainda não avançou o suficiente para elevar o stop até a entrada.',
  },
  breakeven_triggered: {
    headline: 'Proteção aumentada',
    why: 'O preço avançou o suficiente para a regra de proteção elevar o stop até a entrada — a partir de agora a operação não fecha mais no vermelho.',
  },
  pre_tp1_trailing_dormant: {
    headline: 'Monitorando — trilha inativa',
    why: 'Nenhuma condição de saída foi atingida. O preço ainda não se moveu o suficiente a favor para a trilha de proteção começar a seguir.',
  },
  pre_tp1_trailing_advanced: {
    headline: 'Proteção aumentada',
    why: 'O preço avançou o suficiente para a trilha de proteção elevar o stop.',
  },
  tp1_hit_stop_to_breakeven: {
    headline: 'TP1 atingido — proteção aumentada',
    why: 'TP1 foi atingido: parte da posição foi realizada e o stop subiu para a entrada — o restante não pode mais fechar no vermelho.',
  },
  tp1_hit_stop_unchanged: {
    headline: 'TP1 atingido',
    why: 'TP1 foi atingido: parte da posição foi realizada. O stop já estava na entrada, então não houve mudança adicional.',
  },
  runner_rf_managed: {
    headline: 'Runner ativo',
    why: 'TP1 já foi atingido. O restante da posição é encerrado pela reversão do indicador, não por uma trilha de stop.',
  },
  runner_trailing_dormant: {
    headline: 'Runner ativo — trilha estável',
    why: 'TP1 já foi atingido. O preço ainda não se moveu o suficiente nesta passada para a trilha elevar o stop.',
  },
  runner_trailing_advanced: {
    headline: 'Runner ativo — proteção aumentada',
    why: 'TP1 já foi atingido e o preço avançou o suficiente para a trilha elevar o stop.',
  },
  // Fase 4 — EXIT (a operação encerrou). Um reason_code por ponto de
  // interceptação de scanner.js — ver src/lib/decisionSnapshot.js para o
  // porquê de não haver um texto genérico "operação encerrada".
  stop_hit_pre_tp1: {
    headline: 'Stop atingido',
    why: 'O preço tocou o stop antes de TP1 ser atingido.',
  },
  stop_hit_runner: {
    headline: 'Stop atingido',
    why: 'O preço tocou o stop já protegido (breakeven ou trilha) depois do TP1.',
  },
  tp2_hit: {
    headline: 'TP2 atingido — operação completa',
    why: 'O preço atingiu o alvo final; o restante da posição foi encerrado.',
  },
  invalidated_rf_bars_pre_tp1: {
    headline: 'Invalidada — tendência reverteu',
    why: 'O indicador ficou contra a posição por barras suficientes antes de TP1.',
  },
  invalidated_rf_direct_runner: {
    headline: 'Invalidada — tendência reverteu',
    why: 'O indicador virou contra a posição, já com TP1 realizado.',
  },
  invalidated_smc_structure: {
    headline: 'Invalidada — estrutura reverteu',
    why: 'A estrutura de mercado que sustentava a posição se rompeu no lado oposto.',
  },
  chop_exit: {
    headline: 'Encerrada — mercado sem direção',
    why: 'A lateralização (Choppiness) passou do limite tolerado antes de TP1.',
  },
  time_stop: {
    headline: 'Encerrada — prazo esgotado',
    why: 'A operação não atingiu TP1 dentro do prazo máximo permitido.',
  },
  tp1_full_close: {
    headline: 'TP1 atingido — operação encerrada',
    why: 'Sem runner ativo nesta operação, o TP1 encerra a posição por completo.',
  },
  stop_hit_price_check: {
    headline: 'Stop atingido',
    why: 'O preço ao vivo tocou o stop.',
  },
  tp2_hit_price_check: {
    headline: 'TP2 atingido — operação completa',
    why: 'O preço ao vivo atingiu o alvo final.',
  },
  tp1_full_close_price_check: {
    headline: 'TP1 atingido — operação encerrada',
    why: 'Sem runner ativo nesta operação, o TP1 encerra a posição por completo.',
  },
  manual_closed: {
    headline: 'Encerrada manualmente',
    why: 'Um usuário encerrou esta operação manualmente pelo painel.',
  },
  manual_invalidated: {
    headline: 'Invalidada manualmente',
    why: 'Um usuário invalidou esta operação manualmente pelo painel.',
  },
});

const FALLBACK_OPERATION_COPY = Object.freeze({
  headline: 'Monitorando',
  why: 'Nenhuma condição de saída foi atingida. O app não guardou os fatos exatos desta avaliação — a gestão continua automática.',
});

/**
 * Formata `decision_snapshot.facts` por `reason_code` de gestão. Mesma regra
 * fail-closed de `formatEvidence`: `data_status !== 'LIVE'` ou `reason_code`
 * sem formatador conhecido devolvem `null`, nunca um texto inventado.
 */
function formatOperationEvidence(snapshot) {
  if (!snapshot || snapshot.data_status !== 'LIVE') return null;
  const { reason_code: reasonCode, facts = {} } = snapshot;

  if (reasonCode === 'awaiting_tp1') {
    const toTp1 = formatPriceNum(facts.distance_to_tp1);
    const toStop = formatPriceNum(facts.distance_to_stop);
    if (toTp1 == null || toStop == null) return null;
    return `Medido: faltam ${toTp1} até o TP1, ${toStop} de folga até o stop.`;
  }

  if (reasonCode === 'tp1_hit_stop_to_breakeven' || reasonCode === 'tp1_hit_stop_unchanged') {
    const before = formatPriceNum(facts.stop_before);
    const after = formatPriceNum(facts.stop_after);
    if (before == null || after == null) return null;
    return reasonCode === 'tp1_hit_stop_to_breakeven'
      ? `Medido: stop foi de ${before} para ${after} (entrada).`
      : `Medido: stop mantido em ${after} (já era a entrada).`;
  }

  if (reasonCode === 'pre_tp1_protection_armed_not_triggered' || reasonCode === 'breakeven_triggered') {
    const move = formatPriceNum(facts.favorable_move);
    const required = formatPriceNum(facts.required_move);
    if (move == null || required == null) return null;
    // facts.favorable_move nasce negativo quando o preço abre CONTRA a
    // posição logo após a entrada (gap) — comum, não um caso raro. Chamar
    // um valor negativo de "favorável" é uma contradição de linguagem
    // (achado da varredura geral, 2026-09-18).
    const base = facts.favorable_move < 0
      ? `Medido: ainda sem movimento favorável (${move}), necessário ${required} para acionar.`
      : `Medido: movimento favorável ${move}, necessário ${required} para acionar.`;
    if (reasonCode === 'breakeven_triggered') {
      const before = formatPriceNum(facts.stop_before);
      const after = formatPriceNum(facts.stop_after);
      return before != null && after != null ? `${base} Stop foi de ${before} para ${after}.` : base;
    }
    return base;
  }

  if (reasonCode === 'pre_tp1_trailing_dormant' || reasonCode === 'pre_tp1_trailing_advanced') {
    const required = formatPriceNum(facts.required_move);
    if (facts.favorable_move == null) {
      return required != null ? `Medido: ainda sem movimento favorável registrado — necessário ${required} para a trilha começar.` : null;
    }
    const move = formatPriceNum(facts.favorable_move);
    if (move == null || required == null) return null;
    // Mesma correção de linguagem do bloco acima para valor negativo.
    const base = facts.favorable_move < 0
      ? `Medido: ainda sem movimento favorável (${move}), gatilho da trilha em ${required}.`
      : `Medido: movimento favorável ${move}, gatilho da trilha em ${required}.`;
    if (reasonCode === 'pre_tp1_trailing_advanced') {
      const before = formatPriceNum(facts.stop_before);
      const after = formatPriceNum(facts.stop_after);
      return before != null && after != null ? `${base} Stop foi de ${before} para ${after}.` : base;
    }
    return base;
  }

  if (reasonCode === 'runner_rf_managed') {
    const toStop = formatPriceNum(facts.distance_to_stop);
    if (toStop == null) return null;
    const toTp2 = formatPriceNum(facts.distance_to_tp2);
    return toTp2 != null
      ? `Medido: ${toStop} de folga até o stop, faltam ${toTp2} até o TP2.`
      : `Medido: ${toStop} de folga até o stop.`;
  }

  if (reasonCode === 'runner_trailing_dormant' || reasonCode === 'runner_trailing_advanced') {
    const before = formatPriceNum(facts.stop_before);
    const after = formatPriceNum(facts.stop_after);
    if (reasonCode === 'runner_trailing_advanced' && before != null && after != null) {
      return `Medido: stop foi de ${before} para ${after}.`;
    }
    return before != null ? `Medido: stop mantido em ${before}.` : null;
  }

  // Fase 4 — EXIT.
  if (reasonCode === 'stop_hit_pre_tp1' || reasonCode === 'stop_hit_runner') {
    const stop = formatPriceNum(facts.stop);
    if (stop == null) return null;
    const price = formatPriceNum(facts.stop_check_price);
    return price != null ? `Medido: stop em ${stop}, preço tocou ${price}.` : `Medido: stop em ${stop}.`;
  }

  if (reasonCode === 'tp2_hit') {
    const tp2 = formatPriceNum(facts.tp2);
    if (tp2 == null) return null;
    const price = formatPriceNum(facts.tp_check_price);
    return price != null ? `Medido: TP2 em ${tp2}, preço tocou ${price}.` : `Medido: TP2 em ${tp2}.`;
  }

  if (reasonCode === 'invalidated_rf_bars_pre_tp1') {
    const bars = formatNum(facts.reverse_bars);
    const req = formatNum(facts.invalid_rf_bars);
    if (bars == null || req == null) return null;
    return `Medido: ${bars} candles com o indicador contra a posição (necessário: ${req}).`;
  }

  if (reasonCode === 'invalidated_rf_direct_runner') {
    const filt = formatPriceNum(facts.rf_filter_value);
    const close = formatPriceNum(facts.close_price);
    if (filt == null || close == null) return null;
    return `Medido: preço ${close} contra o filtro em ${filt}.`;
  }

  if (reasonCode === 'invalidated_smc_structure') {
    if (!Number.isFinite(facts.smc_trend) || !Number.isFinite(facts.signal_direction)) return null;
    return `Medido: estrutura agora aponta para ${directionLabel(facts.smc_trend)}; a operação era de ${directionLabel(facts.signal_direction)}.`;
  }

  if (reasonCode === 'chop_exit') {
    const chop = formatNum(facts.chop);
    const max = formatNum(facts.chop_max);
    if (chop == null) return null;
    return max != null ? `Medido: lateralização (Chop) ${chop} — máximo permitido ${max}.` : `Medido: lateralização (Chop) ${chop}.`;
  }

  if (reasonCode === 'time_stop') {
    const open = formatNum(facts.bars_open);
    const max = formatNum(facts.time_stop_bars);
    if (open == null || max == null) return null;
    // Frase reescrita para não depender de open <= max: `bars_open` conta
    // por tempo decorrido (não por candle), então pode ultrapassar
    // `time_stop_bars` de verdade quando o cron fica indisponível — "X de Y"
    // vira gramaticalmente sem sentido nesse caso (achado da varredura
    // geral, 2026-09-18).
    return `Medido: ${open} candles em aberto sem atingir TP1 (limite: ${max}).`;
  }

  if (reasonCode === 'tp1_full_close') {
    const tp1 = formatPriceNum(facts.tp1);
    return tp1 != null ? `Medido: TP1 em ${tp1}.` : null;
  }

  if (reasonCode === 'stop_hit_price_check') {
    const stop = formatPriceNum(facts.stop);
    const price = formatPriceNum(facts.price);
    if (stop == null || price == null) return null;
    return `Medido: stop em ${stop}, preço ao vivo ${price}.`;
  }

  if (reasonCode === 'tp2_hit_price_check') {
    const tp2 = formatPriceNum(facts.tp2);
    const price = formatPriceNum(facts.price);
    if (tp2 == null || price == null) return null;
    return `Medido: TP2 em ${tp2}, preço ao vivo ${price}.`;
  }

  if (reasonCode === 'tp1_full_close_price_check') {
    const tp1 = formatPriceNum(facts.tp1);
    const price = formatPriceNum(facts.price);
    if (tp1 == null || price == null) return null;
    return `Medido: TP1 em ${tp1}, preço ao vivo ${price}.`;
  }

  return null;
}

/**
 * @param {object} op    TradeOperation completo (com ou sem decision_snapshot)
 * @returns mesmo contrato de `explainDecision`
 */
export function explainOperationDecision(op) {
  const snapshot = op?.decision_snapshot ?? null;
  const copy = snapshot && OPERATION_COPY[snapshot.reason_code]
    ? OPERATION_COPY[snapshot.reason_code]
    : FALLBACK_OPERATION_COPY;
  return {
    headline: copy.headline,
    why: copy.why,
    evidence: withMeasuredAt(formatOperationEvidence(snapshot), snapshot),
    missing: null,
    nextStep: null,
    userAction: NOTHING_TO_DO,
    warnings: warningsFor(snapshot),
    technical: snapshot,
  };
}
