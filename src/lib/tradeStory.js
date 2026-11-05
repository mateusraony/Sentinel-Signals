/**
 * "A história deste trade" (aba Histórico, docs/known-risks.md item 291) — a operação fechada contada em frases simples, na ordem em
 * que aconteceu: abriu → o que viu pelo caminho (melhor e pior ponto) → TP1 → TP2 → stop movido → saída → resultado.
 *
 * Pedido do usuário (05/11): "a aba Histórico está muito vazia… melhorar muito a forma com que os dados e o que aconteceu no trade".
 * Só usa campos que a operação JÁ tem; o que faltar (operação legada) simplesmente não vira frase — nunca "undefined", "NaN" nem
 * horário inventado. Texto neutro: descreve o que ocorreu, não opina sobre o que "deveria" ter acontecido nem prevê nada.
 *
 * Módulo puro (sem React, sem I/O): o componente injeta `fmt` (formatação de horário no fuso do usuário).
 */
import { getExitPrice, getTp1Price, calcRealizedPnlPct, calcRealizedR } from './tradeMetrics.js';
import { closesFullyAtTp1 } from './opExitRules.js';
import { closedReasonLabel } from './eventTimeline.js';
import { formatPrice } from './priceProximity.js';

/** Quanto o resultado final precisa ficar abaixo do melhor ponto (em R) para a história comentar isso. */
export const GAVE_BACK_MIN_R = 0.25;

const lower = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null);

/**
 * Timeframe do AVISO que originou a operação. `TradeOperation.timeframe` é o de EXECUÇÃO ('15m'/'5m', onde a entrada foi
 * confirmada), não o do aviso ('4h'/'1h' = `signal_timeframe`) — comparar com o errado fazia o filtro 1H/4H/1D do Histórico não
 * mostrar nenhuma operação nova. Operação legada não gravava `signal_timeframe`: toda a de 15m/5m veio da cascata 4h→15m
 * (mesmo fallback de `scanner.js`, SIGNAL_TF_MS) e a anterior à cascata já tinha o timeframe do aviso em `timeframe`.
 */
export function opSignalTimeframe(op) {
  const signalTf = lower(op?.signal_timeframe);
  if (signalTf) return signalTf;
  const tf = lower(op?.timeframe);
  if (!tf) return null;
  return tf === '15m' || tf === '5m' ? '4h' : tf;
}

/** Rótulo do selo de timeframe: "4H → 15M" (aviso → entrada) quando diferem; só "15M" se for o mesmo; null se não há dado. */
export function timeframeChipLabel(op) {
  const signalTf = opSignalTimeframe(op);
  const execTf = lower(op?.timeframe);
  if (signalTf && execTf && signalTf !== execTf) return `${signalTf.toUpperCase()} → ${execTf.toUpperCase()}`;
  return (execTf ?? signalTf)?.toUpperCase() ?? null;
}

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const money = (v) => (isNum(v) ? `$${formatPrice(v)}` : null);
const signedR = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
/**
 * Horário formatado, ou `null`. Só vale texto ISO que vira data E que o PRÓPRIO formatador aceita: `new Date(true)` e datas de calendário
 * inexistentes (30/02) viram timestamp finito mas o formatador da página (moment) devolve "Invalid date" — então a régua é a saída do
 * formatador (Codex, PR #543). Nunca lança.
 */
function formatWhen(fmt, iso) {
  if (typeof iso !== 'string' || !iso) return null;
  if (!Number.isFinite(new Date(iso).getTime())) return null;
  let out;
  try { out = fmt(iso); } catch { return null; }
  return typeof out === 'string' && out.trim() && !/invalid/i.test(out) ? out : null;
}

/** Horas desde a entrada em linguagem simples ("~12 h", "~3 dias"). As barras de `bars_to_*` são do timeframe do aviso (4h, ou 1h na SMC). */
export function elapsedLabel(bars, signalTf) {
  if (!isNum(bars) || bars < 0) return null;
  const hours = bars * (signalTf === '1h' ? 1 : 4);
  if (hours < 1) return 'menos de 1 h';
  if (hours < 48) return `~${Math.round(hours)} h`;
  return `~${Math.round(hours / 24)} dias`;
}

function defaultFmt(iso) {
  return String(iso);
}

/**
 * @param {object} op operação fechada
 * @param {{ fmt?: (iso: string) => string }} [opts] `fmt` formata horários (o componente passa o fuso do usuário)
 * @returns {{ key: string, text: string }[]} passos em ordem; vazio se `op` não é objeto
 */
export function buildTradeStory(op, { fmt = defaultFmt } = {}) {
  if (!op || typeof op !== 'object') return [];
  const steps = [];
  // Primeiro horário VÁLIDO entre os candidatos (os campos de saída podem vir ruins sem que os outros estejam).
  const whenOf = (...isos) => { for (const iso of isos) { const w = formatWhen(fmt, iso); if (w) return w; } return null; };
  const at = (...isos) => { const w = whenOf(...isos); return w ? ` em ${w}` : ''; };
  const sideWord = op.side === 'BUY' ? 'compra' : op.side === 'SELL' ? 'venda' : null;
  const isBuy = op.side === 'BUY';
  const isSell = op.side === 'SELL';
  const signalTf = opSignalTimeframe(op);
  const execTf = lower(op.timeframe);

  // 1. Abriu
  const entry = money(op.entry_price);
  const via = signalTf && execTf && signalTf !== execTf
    ? ` (aviso do gráfico de ${signalTf.toUpperCase()}, confirmado no de ${execTf.toUpperCase()})`
    : '';
  const signalWhen = whenOf(op.created_date);
  const signalAt = signalWhen ? ` (sinal de ${signalWhen})` : '';
  steps.push({
    key: 'opened',
    text: `📍 Abriu uma operação${sideWord ? ` de ${sideWord}` : ''}${entry ? ` a ${entry}` : ''}${signalAt}${via}.`,
  });

  // 2. O caminho: melhor e pior ponto, e quando o melhor veio
  const hasMfe = isNum(op.mfe_r);
  const hasMae = isNum(op.mae_r);
  if (hasMfe || hasMae) {
    const bits = [];
    if (hasMfe) bits.push(`${signedR(op.mfe_r)} a favor`);
    if (hasMae) bits.push(`${signedR(op.mae_r)} contra`);
    let text = `No caminho, chegou a ${bits.join(' e a ')}`;
    const when = hasMfe ? elapsedLabel(op.bars_to_mfe, signalTf) : null;
    if (when) text += ` (o melhor ponto veio ${when} depois da entrada)`;
    const realizedR = calcRealizedR(op);
    if (hasMfe && op.mfe_r > 0 && realizedR !== null && op.mfe_r - realizedR >= GAVE_BACK_MIN_R) {
      text += `; o resultado final (${signedR(realizedR)}) ficou ${(op.mfe_r - realizedR).toFixed(2)}R abaixo desse melhor ponto`;
    }
    steps.push({ key: 'path', text: `${text}.` });
  }

  // 3. TP1
  if (op.tp1_hit === true || op.tp1_hit_at) {
    const price = money(getTp1Price(op));
    const partial = isNum(op.partial_percent) ? op.partial_percent : 50;
    const what = closesFullyAtTp1(op)
      ? 'fechou toda a posição'
      : `realizou ${partial}% da posição, deixando o resto correndo`;
    steps.push({ key: 'tp1', text: `🎯 Bateu o TP1${price ? ` (${price})` : ''}${at(op.tp1_hit_real_time, op.tp1_hit_at)} e ${what}.` });
  }

  // 4. TP2
  if (op.tp2_hit === true || op.tp2_hit_at) {
    const price = money(isNum(op.tp2_hit_price) ? op.tp2_hit_price : op.tp2);
    steps.push({ key: 'tp2', text: `🏆 Bateu o TP2${price ? ` (${price})` : ''}${at(op.tp2_hit_real_time, op.tp2_hit_at)}.` });
  }

  // 5. O stop andou? (só o valor final é gravado — não se sabe QUANDO subiu)
  if (isNum(op.initial_stop) && isNum(op.current_stop) && op.current_stop !== op.initial_stop) {
    const favorable = (isBuy && op.current_stop > op.initial_stop) || (isSell && op.current_stop < op.initial_stop);
    steps.push({
      key: 'stop_moved',
      text: `O stop saiu de ${money(op.initial_stop)} (inicial) para ${money(op.current_stop)} (último valor)${favorable ? ', acompanhando o preço a favor da posição' : ''}.`,
    });
  }

  // 6. Saída (TP2 já está contado acima)
  // Horário de saída = só carimbo de ENCERRAMENTO que existe. `getClosedAt` cai em `updated_date`/`created_date` para documento legado,
  // e a história diria que a operação saiu "no instante em que abriu" — sem carimbo conhecido, a frase simplesmente não traz horário.
  const exitPrice = money(getExitPrice(op));
  if (op.status === 'STOP_HIT') {
    steps.push({ key: 'exit', text: `🛑 Saiu pelo stop${exitPrice ? ` a ${exitPrice}` : ''}${at(op.stop_hit_real_time, op.stop_hit_at, op.closed_at_real_time, op.closed_at)}.` });
  } else if (op.status === 'INVALIDATED' || op.status === 'CLOSED') {
    const reason = closedReasonLabel(op) ?? (op.status === 'INVALIDATED' ? 'sinal invalidado' : null);
    steps.push({ key: 'exit', text: `🔒 Encerrada${reason ? `: ${reason}` : ''}${exitPrice ? `, a ${exitPrice}` : ''}${at(op.closed_at_real_time, op.closed_at)}.` });
  }

  // 7. Resultado
  const pnl = calcRealizedPnlPct(op);
  const r = calcRealizedR(op);
  if (pnl !== null) {
    steps.push({ key: 'result', text: `Resultado final: ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%${r !== null ? ` (${signedR(r)})` : ''}.` });
  }

  return steps;
}
